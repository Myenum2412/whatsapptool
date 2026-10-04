import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { UsageEvent, UsageEventKind } from './entities/usage-event.entity';
import { Session } from '../session/entities/session.entity';
import { TenancyService } from '../tenancy/tenancy.service';
import { DEFAULT_ORGANIZATION_ID, isMultitenancyEnabled } from '../tenancy/tenancy.constants';

/** One metered kind's total over a closed window — the unit an invoice line is summed from. */
export interface UsageSummaryRow {
  kind: UsageEventKind;
  quantity: number;
  events: number;
}

interface RecordInput {
  kind: UsageEventKind;
  sessionId?: string | null;
  subject?: string | null;
  quantity?: number;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
}

/**
 * The only writer of `usage_events`.
 *
 * Three properties matter more than anything else here, because this runs on the send and receive
 * paths of a live gateway:
 *
 * 1. **It can never fail a message.** Every `record*` method returns `void`, kicks the write off
 *    without awaiting it, and swallows the rejection. A failed ledger write is an operational
 *    problem to alert on, never a reason to fail a message the engine already accepted.
 * 2. **It attributes by resolution, never by caller.** No call site passes an organization id. They
 *    pass the session the usage belongs to, and `TenancyService` decides — so the single-tenant
 *    fallback and the future unknown-tenant rejection live in one place and cannot drift per caller.
 * 3. **It adds no read to the default install.** See `organizationForSession`.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(UsageEvent, 'data') private readonly usage: Repository<UsageEvent>,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    private readonly tenancy: TenancyService,
  ) {}

  /** One outbound message the API sent. Counted only after the engine accepted it. */
  recordMessageSent(sessionId: string): void {
    this.record({ kind: UsageEventKind.MESSAGE_SENT, sessionId });
  }

  /** One inbound message that was newly persisted — not a duplicate engine re-fire. */
  recordMessageReceived(sessionId: string): void {
    this.record({ kind: UsageEventKind.MESSAGE_RECEIVED, sessionId });
  }

  /**
   * Fire-and-forget write.
   *
   * `void` on the promise plus a `catch` is the whole failure-isolation story, and it matches how
   * archiving and the plugin hook are handled at the same chokepoints. Deliberately NOT awaited by
   * callers: adding a ledger insert to the critical path of a send would make message latency depend
   * on the health of a table that nothing about sending depends on.
   */
  private record(input: RecordInput): void {
    void this.write(input).catch(err => {
      // Warn, not error, and no stack: this fires once per message, so an error-level log here would
      // flood the log and bury a real problem. The message is the diagnostic.
      this.logger.warn(`Failed to record ${input.kind} usage: ${err instanceof Error ? err.message : String(err)}`, {
        kind: input.kind,
        sessionId: input.sessionId ?? undefined,
      });
    });
  }

  private async write(input: RecordInput): Promise<void> {
    const organizationId = await this.organizationForSession(input.sessionId);
    const row = {
      organizationId,
      kind: input.kind,
      quantity: input.quantity ?? 1,
      sessionId: input.sessionId ?? null,
      subject: input.subject ?? null,
      // Defaulted here rather than by the column so a backfilled event can be billed at when it
      // happened instead of when the row landed. See the entity's note on `occurredAt`.
      occurredAt: input.occurredAt ?? new Date(),
      metadata: input.metadata ?? null,
    };
    // `insert()` takes a QueryDeepPartialEntity. The cast is scoped to this one literal rather than
    // loosening the repository's type: `metadata` is a json column, so the driver accepts the value
    // as-is and TypeORM simply cannot see through `Record<string, unknown>` to prove it.
    await this.usage.insert(row as QueryDeepPartialEntity<UsageEvent>);
  }

  /**
   * The organization a piece of usage belongs to.
   *
   * The `!isMultitenancyEnabled()` branch is the reason metering could be landed without a
   * performance review: it returns the frozen constant with **no database read at all**, so on the
   * default single-tenant install every metered message costs one extra INSERT and zero extra
   * SELECTs. The session lookup only happens once an operator has opted into multi-tenancy, where
   * attributing correctly is worth the read.
   *
   * It returns the constant rather than calling `TenancyService.defaultOrganizationId()` because that
   * verifies the row exists, and one verification query per message — plus a log line per message on
   * a broken install — is the wrong trade. Boot-time seeding already guarantees the row; if it is
   * gone, that is loudly reported once at boot rather than once per message.
   */
  private async organizationForSession(sessionId?: string | null): Promise<string> {
    if (!isMultitenancyEnabled()) return DEFAULT_ORGANIZATION_ID;
    if (!sessionId) return this.tenancy.defaultOrganizationId();

    const session = await this.sessions.findOne({ where: { id: sessionId }, select: { organizationId: true } });
    // `?? null`, not `|| null`: a session with no organization (pre-backfill, or created while
    // enforcement was off) must fall back the same way an absent one does, and both must go through
    // resolveOrganizationId so the unknown-tenant rejection applies uniformly once enforcement is on.
    return this.tenancy.resolveOrganizationId(session?.organizationId ?? null);
  }

  /**
   * Reconstruct one organization's usage over a closed window, grouped by kind.
   *
   * This is the ledger's reason for existing and the proof obligation from the roadmap: an invoice for
   * a closed period must be derivable from the rows alone. Summing `quantity` (not counting rows) is
   * what lets one row carry a batch, and grouping by kind is what makes a per-kind line item a single
   * index range over `IDX_usage_events_organizationId_kind_occurredAt` rather than a JS fold.
   *
   * `from` is inclusive and `to` exclusive, matching every other windowed query in the codebase, so a
   * sequence of adjacent periods tiles without double-counting the boundary instant.
   */
  async summarize(organizationId: string, from: Date, to: Date): Promise<UsageSummaryRow[]> {
    const rows = await this.usage
      .createQueryBuilder('usage')
      .select('usage.kind', 'kind')
      .addSelect('SUM(usage.quantity)', 'quantity')
      .addSelect('COUNT(*)', 'events')
      .where('usage.organizationId = :organizationId', { organizationId })
      .andWhere('usage.occurredAt >= :from', { from })
      .andWhere('usage.occurredAt < :to', { to })
      .groupBy('usage.kind')
      .orderBy('usage.kind', 'ASC')
      .getRawMany<{ kind: UsageEventKind; quantity: string | number; events: string | number }>();

    // Postgres returns SUM()/COUNT() as bigint (string) and SQLite as number. Normalize here so a
    // caller summing two windows does not silently concatenate them.
    return rows.map(row => ({
      kind: row.kind,
      quantity: Number(row.quantity),
      events: Number(row.events),
    }));
  }

  /**
   * Total units of one kind in a window — the single number a quota check compares against.
   *
   * Returns 0 rather than `null` for "no usage" so a caller cannot accidentally treat an absent
   * result as a decision to allow or deny.
   */
  async totalFor(organizationId: string, kind: UsageEventKind, from: Date, to: Date): Promise<number> {
    const row = await this.usage
      .createQueryBuilder('usage')
      .select('COALESCE(SUM(usage.quantity), 0)', 'total')
      .where('usage.organizationId = :organizationId', { organizationId })
      .andWhere('usage.kind = :kind', { kind })
      .andWhere('usage.occurredAt >= :from', { from })
      .andWhere('usage.occurredAt < :to', { to })
      .getRawOne<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }
}
