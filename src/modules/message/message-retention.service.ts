import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/**
 * Retention window in days; `<= 0` disables the purge entirely.
 *
 * `messages` is the product's conversation history, not an append-only telemetry log like
 * `ingress_events`. An operator who turns retention off is making a legitimate choice about data they
 * own — which is exactly why the knob has to exist. The census found no `MESSAGE_RETENTION_DAYS`
 * equivalent at all, so an operator asked "what do you hold about me" and "delete it" had no way to
 * answer either question.
 */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 0;

/**
 * Resolve the retention window from the environment.
 *
 * A pure function over an injectable `env`, matching `resolvePendingMessageReaperOptions` in the
 * sibling reaper, so it is testable without mutating `process.env`. An unparseable value resolves to
 * the DISABLED default rather than to some arbitrary window: a mistyped number of days must never
 * silently delete a customer's WhatsApp history, so the safe reading of "MESSAGE_RETENTION_DAYS=abc"
 * is "no retention configured" — and the operator sees it in the boot log either way.
 */
export function resolveMessageRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return resolveNonNegativeIntEnv(env.MESSAGE_RETENTION_DAYS, DEFAULT_MESSAGE_RETENTION_DAYS);
}

/** Per-statement row count. See the batching note in `pruneOlderThan`. */
export const PURGE_BATCH_SIZE = 500;

/**
 * Ceiling on batches per run, so one huge backlog cannot monopolise the process. A backlog larger
 * than this is continued by the next daily tick — bounded and resumable, never skipped.
 */
export const PURGE_MAX_BATCHES_PER_RUN = 50;

/** What one prune removed. Returned for logging and asserted on in tests. */
export interface MessageRetentionResult {
  /** Rows deleted from `messages`. */
  messages: number;
  /** Archived media files deleted before their rows went. */
  mediaFiles: number;
  /** Rows whose archived file could NOT be deleted, so the row was kept for a later retry. */
  rowsKeptForMedia: number;
}

/**
 * Bounds the growth of `messages`, which otherwise grows without bound, and deletes the archived
 * media those rows point at in the same pass.
 *
 * Runs once at startup then daily via a raw `setInterval` (unref'd), mirroring
 * `IntegrationRetentionService` / `AuditService` — this codebase uses no `@Cron` decorator anywhere,
 * and introducing one here would be the only such use.
 *
 * Disabled by default: `MESSAGE_RETENTION_DAYS` unset or `<= 0` keeps history forever. Unlike the
 * ingress dedup table, this is not clamped to a default, because silently deleting a customer's
 * WhatsApp history is not a safe interpretation of a misconfigured value.
 *
 * Ordering is media-file-first, row-second, and that ordering is load-bearing:
 *
 * - Row-first would drop the only pointer to the archived object, leaving a file in storage that
 *   nothing can name again. The `chat-media/` orphan sweep would eventually collect it, but only
 *   after its grace window and only for the prefix it owns.
 * - File-first means a storage failure leaves the row intact and the next run retries it, which is
 *   recoverable. The reverse is not.
 */
@Injectable()
export class MessageRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('MessageRetentionService');
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Message, 'data') private readonly messageRepository: Repository<Message>,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    const retentionDays = resolveMessageRetentionDays();

    if (retentionDays <= 0) {
      this.logger.log('Message retention disabled (MESSAGE_RETENTION_DAYS <= 0); message history is kept forever');
      // No timer at all, rather than a timer that wakes up daily to no-op: an operator who explicitly
      // disabled retention should not pay for a scheduled query, and an absent timer cannot be
      // forgotten into re-enabling the sweep later.
      return;
    }

    const runPrune = (): void => {
      this.pruneOlderThan(retentionDays)
        .then(result => {
          if (result.messages === 0) return;
          this.logger.log(
            `Pruned ${result.messages} message(s) older than ${retentionDays} day(s) with ${result.mediaFiles} archived media file(s)`,
            {
              action: 'message_retention_pruned',
              messages: result.messages,
              mediaFiles: result.mediaFiles,
              rowsKeptForMedia: result.rowsKeptForMedia,
            },
          );
        })
        .catch(err => this.logger.error('Message retention failed', err instanceof Error ? err.stack : String(err)));
    };

    runPrune(); // prune once at startup
    this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Delete messages older than `retentionDays`, and their archived media first.
   *
   * `<= 0` disables and returns zeros without querying the database, so no input can turn this into
   * "delete everything".
   *
   * Batched for the same reason `ChatMediaArchiveService.purgeExpired` is: the first run after an
   * operator enables retention can face an arbitrarily large backlog, and unbatched that breaks three
   * ways at once — tens of thousands of concurrent deletes, and a single statement past the driver's
   * bind-parameter ceiling (SQLite 32766, Postgres 65535) which throws AFTER the files are already
   * gone, leaving rows pointing at missing files and every later tick repeating the failure.
   */
  async pruneOlderThan(retentionDays: number, now: Date = new Date()): Promise<MessageRetentionResult> {
    if (retentionDays <= 0) return { messages: 0, mediaFiles: 0, rowsKeptForMedia: 0 };

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    let messages = 0;
    let mediaFiles = 0;
    let rowsKeptForMedia = 0;

    for (let batch = 0; batch < PURGE_MAX_BATCHES_PER_RUN; batch++) {
      const expired = await this.messageRepository.find({
        where: { createdAt: LessThan(cutoff) },
        select: { id: true, mediaPath: true },
        take: PURGE_BATCH_SIZE,
        // Oldest first, so an interrupted run drains from the front instead of re-selecting the
        // same newest-of-the-expired rows each tick and never reaching the rest.
        order: { createdAt: 'ASC' },
      });
      if (expired.length === 0) break;

      const deletableIds: string[] = [];
      for (const row of expired) {
        if (row.mediaPath) {
          try {
            await this.storageService.deleteFile(row.mediaPath);
            mediaFiles++;
          } catch (err) {
            rowsKeptForMedia++;
            this.logger.warn(`Failed to delete archived media ${row.mediaPath}; keeping its message row to retry`, {
              error: err instanceof Error ? err.message : String(err),
              messageId: row.id,
            });
            continue;
          }
        }
        deletableIds.push(row.id);
      }

      // Every row in this batch kept its file: the same rows would be re-selected forever, so stop
      // and let the next scheduled run retry rather than spin on them.
      if (deletableIds.length === 0) break;

      await this.messageRepository.delete(deletableIds);
      messages += deletableIds.length;

      // A short batch means the backlog is drained; anything else costs an extra empty query.
      if (expired.length < PURGE_BATCH_SIZE) break;
    }

    return { messages, mediaFiles, rowsKeptForMedia };
  }
}
