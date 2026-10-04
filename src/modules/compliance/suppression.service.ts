import { Injectable, Optional, HttpStatus, HttpException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SuppressedContact, SuppressionSource, OptOutAction } from './entities/suppressed-contact.entity';
import { matchOptOut } from './compliance-keywords';
import { resolveJidCandidates, ContactDirectory } from '../../engine/identity/jid-candidates';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { chatKind } from '../../engine/identity/wa-id';
import { createLogger } from '../../common/services/logger.service';

/** Body code on a suppression refusal, so a client can tell it from any other send failure. */
export const RECIPIENT_SUPPRESSED = 'RECIPIENT_SUPPRESSED';

/**
 * True for the 409 `assertNotSuppressed` throws — a policy refusal, told apart from any other 409 by
 * the `code` on its body.
 *
 * Callers treat it as "the engine was never asked", not as a delivery failure: no `message:failed`
 * hook, no send-breaker increment, and in bulk a failed item rather than a failed batch. A suppressed
 * recipient is a decision we made, so counting it against the account's standing with WhatsApp would
 * penalise the operator for honouring an opt-out.
 */
export function isRecipientSuppressedError(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: string }).code === RECIPIENT_SUPPRESSED;
}

/**
 * The "do not contact this chat" registry, and the only thing allowed to answer "may we send here?".
 *
 * One registry for both operator intent and a contact's own words, because the enforcement point
 * cannot tell them apart and a separate bypassable path is how an opt-out gets lost: if an operator
 * suppression and a keyword opt-out lived in different tables, then the moment an operator cleared a
 * complaint-suppression the contact's own STOP would be gone with it. `source` records which
 * happened; the check does not care.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = createLogger(SuppressionService.name);

  constructor(
    // 'data' is the connection these tables live on. Omitting it asks TypeORM for the repository on the
    // DEFAULT connection, which is always-SQLite `main` — a token ComplianceModule does not register,
    // so the app fails to boot with an unresolved-dependency error. Nothing unit-tests this: a test
    // that constructs the service by hand supplies whatever token it likes.
    @InjectRepository(SuppressedContact, 'data')
    private readonly repository: Repository<SuppressedContact>,
    // Exported by the global EngineModule. Optional so the compliance surface still boots in a unit
    // test without the engine; suppression then matches dialects exactly and fails CLOSED for an
    // unmapped @lid (see resolveJidCandidates).
    @Optional()
    private readonly lidStore?: LidMappingStoreService,
  ) {}

  /**
   * Add a chat to the suppression list, or refresh the existing row for it.
   *
   * Idempotent on (sessionId, chatId): a contact who sends STOP twice must not produce two rows that
   * then disagree about the audit trail. A repeat from a DIFFERENT source upgrades the row's source,
   * because the strongest reason to stay suppressed should be the one on record — an operator's
   * deliberate block must not be downgraded back to a keyword opt-out by a later duplicate STOP.
   */
  async suppress(
    sessionId: string,
    chatId: string,
    source: SuppressionSource,
    reason?: string | null,
    keyword?: string | null,
  ): Promise<void> {
    const identifiers = await this.expand(chatId);
    const existing = await this.repository.findOne({ where: { sessionId, chatId } });

    if (!existing) {
      await this.repository.insert({
        sessionId,
        chatId,
        identifiers,
        source,
        reason: reason ?? null,
        keyword: keyword ?? null,
        suppressedAt: new Date(),
      });
      this.logger.log(`Suppressed ${chatId} on session ${sessionId} (${source})`);
      return;
    }

    const upgraded =
      existing.source === SuppressionSource.BLOCKED ||
      (existing.source === SuppressionSource.MANUAL && source !== SuppressionSource.BLOCKED)
        ? existing.source
        : source;
    await this.repository.update(
      { id: existing.id },
      {
        // Union, never replace: the new address form is additional evidence, and dropping the old
        // one would reopen the door through an identifier the contact already used.
        identifiers: [...new Set([...(existing.identifiers ?? []), ...identifiers])],
        source: upgraded,
        reason: reason ?? existing.reason,
        keyword: keyword ?? existing.keyword,
        suppressedAt: new Date(),
      },
    );
  }

  /**
   * Lift a suppression.
   *
   * Refuses to lift a `BLOCKED` suppression: WhatsApp has told us the contact blocked the account, and
   * an opt-in keyword cannot undo that — the platform enforces it regardless of what we store. The
   * row stays so the operator can see why the contact is unreachable, and a send is still refused.
   */
  async unsuppress(sessionId: string, chatId: string, keyword?: string | null): Promise<boolean> {
    const identifiers = await this.expand(chatId);
    const existing = await this.findRow(sessionId, identifiers);
    if (!existing) return false;

    if (existing.source === SuppressionSource.BLOCKED) {
      this.logger.warn(
        `Refusing to lift a BLOCKED suppression for ${chatId} on session ${sessionId}: WhatsApp reports the contact blocked us, which an opt-in keyword cannot undo`,
      );
      return false;
    }
    await this.repository.delete({ id: existing.id });
    this.logger.log(`Lifted suppression for ${chatId} on session ${sessionId} (${keyword ?? 'operator'})`);
    return true;
  }

  /**
   * Refuse a send to a suppressed chat, and return normally when the chat is contactable.
   *
   * This is the enforcement point. Both copies of the send path (MessageSendService's private
   * `applySendingGate`, which every single sender funnels through, and BulkMessageService's per-item
   * gate) call it before the plugin moderation gate, so a refused recipient is never even offered to a
   * plugin — a moderation hook must not be able to "fix" a suppressed recipient by rewriting it.
   *
   * Fails CLOSED without any code of its own: if the registry read throws, the exception propagates
   * and the send is aborted, which is the only safe direction. An explicit catch here would have to
   * re-throw anyway, and wrapping it would only hide which database failed.
   *
   * 409 rather than 403: nothing about the caller's credentials is wrong, and the refusal is
   * liftable — the contact may opt back in. 410 would promise the destination is gone forever, which
   * an opt-in keyword can undo.
   */
  async assertNotSuppressed(sessionId: string, chatId: string): Promise<void> {
    const row = await this.findRow(sessionId, await this.expand(chatId));
    if (!row) return;

    this.logger.warn(
      `Refusing send to suppressed chat ${chatId} on session ${sessionId} (${row.source}${row.keyword ? `, keyword ${row.keyword}` : ''})`,
    );
    throw new HttpException(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: `This chat is on the do-not-contact list (${row.source}) and cannot be sent to`,
        code: RECIPIENT_SUPPRESSED,
      },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Whether a send to this chat must be refused.
   *
   * Checks every form of the address, so a send aimed at the contact's `@lid` is refused when the
   * opt-out arrived as their `@c.us` and vice versa. This is the identity-expansion rule the whole
   * registry exists to enforce; comparing literal strings is the obvious implementation and it is
   * defeatable by changing which identifier the sender uses.
   */
  async isSuppressed(sessionId: string, chatId: string): Promise<boolean> {
    return (await this.findRow(sessionId, await this.expand(chatId))) !== null;
  }

  /** Every suppression for one session, newest first — the operator's view of the list. */
  async listForSession(sessionId: string): Promise<SuppressedContact[]> {
    return this.repository.find({ where: { sessionId }, order: { suppressedAt: 'DESC' } });
  }

  /**
   * Apply an inbound message as a possible opt-out/opt-in command.
   *
   * Returns what it did, so the caller can audit it; null when the message was not a command. Called
   * from the inbound projector AFTER the message has been persisted, because a suppression decision
   * that is not itself recorded as a message is not auditable, and because failing to write the
   * message must not be caused by the compliance layer.
   */
  async applyInbound(
    sessionId: string,
    chatId: string,
    body: string | null | undefined,
    optOutKeywords?: readonly string[],
    optInKeywords?: readonly string[],
  ): Promise<OptOutAction | null> {
    const match = matchOptOut(body, optOutKeywords, optInKeywords);
    if (!match) return null;

    // Direct chats ONLY. In a group `from` is the group JID and one member typing "STOP" would
    // otherwise suppress the whole group for every other member — silencing a conversation because a
    // stranger said a keyword is a far worse failure than ignoring the keyword, and no regulator asks
    // for it. Channels and status/broadcast ids are excluded for the same reason: they are not
    // individually addressable destinations.
    if (chatKind(chatId) !== 'individual') {
      this.logger.warn(
        `Ignoring an opt-out/opt-in keyword ("${match.keyword}") from a ${chatKind(chatId)} chat (${chatId}); opt-out applies to direct chats only`,
      );
      return null;
    }

    if (match.action === OptOutAction.OPT_OUT) {
      await this.suppress(
        sessionId,
        chatId,
        SuppressionSource.OPT_OUT_KEYWORD,
        'Contact sent an opt-out keyword',
        match.keyword,
      );
    } else {
      await this.unsuppress(sessionId, chatId, match.keyword);
    }
    return match.action;
  }

  /**
   * Mark a chat suppressed because WhatsApp reported the contact blocked the account.
   *
   * Separate from `suppress()` because it must never be auto-lifted by an opt-in keyword, and because
   * the send path refuses it on its own merits: a blocked contact's messages fail at the platform
   * anyway, and finding that out through a delivery failure report is one report too late.
   */
  async markBlocked(sessionId: string, chatId: string): Promise<void> {
    await this.suppress(
      sessionId,
      chatId,
      SuppressionSource.BLOCKED,
      'WhatsApp reported the contact blocked this account',
    );
  }

  private async findRow(sessionId: string, identifiers: string[]): Promise<SuppressedContact | null> {
    if (identifiers.length === 0) return null;

    // Hot path first: the literal (sessionId, chatId) pair is a unique-index hit, which is the common
    // case (a send addressed the same way the contact wrote in). Only when that misses do we pay for
    // the cross-form scan below.
    const exact = await this.repository.findOne({ where: { sessionId, chatId: identifiers[0] } });
    if (exact) return exact;

    // Cross-form: the send is addressed by a DIFFERENT identifier than the opt-out arrived under.
    // `identifiers` is a JSON column, so this cannot be an SQL `IN` — TypeORM would compare the raw
    // serialized array against the literal and never match. A suppression list is opt-outs for one
    // WhatsApp account, not a user table, so one indexed read of the session's rows and an in-memory
    // intersection is the honest cost of matching on identity rather than on a string.
    const rows = await this.repository.find({ where: { sessionId } });
    return rows.find(row => (row.identifiers ?? []).some(form => identifiers.includes(form))) ?? null;
  }

  private expand(chatId: string): Promise<string[]> {
    return resolveJidCandidates(chatId, this.directory());
  }

  private directory(): ContactDirectory | undefined {
    const store = this.lidStore;
    if (!store) return undefined;
    return {
      resolveLid: userPart => store.findPhoneForLid(userPart),
      lidsForPhone: phone => store.findLidsForPhone(phone),
    };
  }
}
