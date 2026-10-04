import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContactConsent, ConsentSource, ConsentAction, ConsentBasis } from './entities/contact-consent.entity';
import { matchOptOut } from './compliance-keywords';
import { OptOutAction } from './entities/suppressed-contact.entity';
import { chatKind } from '../../engine/identity/wa-id';
import { createLogger } from '../../common/services/logger.service';

/** One recorded decision about one contact's permission to be messaged. */
export interface ConsentSummary {
  contact: string;
  /** The latest decision for each basis, which is the one that counts. */
  current: Record<ConsentBasis, ConsentAction>;
  /** Every decision, oldest first — the audit trail an evidentiary request is answered from. */
  history: ContactConsent[];
}

export interface ConsentDecisionInput {
  action: ConsentAction;
  source: ConsentSource;
  /** Required for anything other than a keyword: who is accountable for this consent claim. */
  operatorId?: string | null;
  note?: string | null;
  at?: Date;
}

/**
 * The consent ledger: append-only evidence of what each contact was told, and when they agreed or
 * disagreed.
 *
 * This is deliberately NOT the same thing as the suppression list, and the distinction is the point of
 * having both:
 *
 * - `SuppressedContact` is current state: "do not contact this chat". It is mutated in place and answers
 *   one question, fast, on the send path.
 * - This ledger is history: every grant and every withdrawal, immutable, never updated. It answers
 *   "prove you had permission", which is the question a regulator or a data-subject complaint asks, and
 *   which no mutable current-state table can answer.
 *
 * Collapsing them into one table is the tempting simplification and it destroys the audit trail: an
 * `UPDATE` that flips a consent row from granted to withdrawn leaves no record that consent ever
 * existed, which is precisely the moment the operator most needs to be able to show what happened.
 *
 * Append-only mirrors `usage_events`: no `@UpdateDateColumn`, and corrections are new compensating
 * rows rather than edits.
 */
/**
 * Sources that put a human being's name on the consent claim, and so must be attributable to one.
 *
 * A set rather than a pair of `===` checks so adding a future source has an obvious place to declare
 * whether it needs an operator: silence then means "deliberately anonymous", which is the decision worth
 * noticing. Everything outside this set is something the CONTACT said themselves.
 */
const NEEDS_OPERATOR = new Set<ConsentSource>([ConsentSource.OPERATOR, ConsentSource.IMPORT]);

@Injectable()
export class ConsentLedgerService {
  private readonly logger = createLogger(ConsentLedgerService.name);

  constructor(
    // 'data' is the connection these tables live on. Omitting it asks TypeORM for the repository on the
    // DEFAULT connection, which is always-SQLite `main` — a token ComplianceModule does not register,
    // so the app fails to boot with an unresolved-dependency error. Nothing unit-tests this: a test
    // that constructs the service by hand supplies whatever token it likes.
    @InjectRepository(ContactConsent, 'data')
    private readonly repository: Repository<ContactConsent>,
  ) {}

  /**
   * Record a decision. Never rejects a legitimate basis, but never invents an origin either: a claim
   * made by staff or by an uploaded file needs an `operatorId`.
   *
   * `IMPORT` is included deliberately even though a bulk file is not one person clicking a box. An
   * import is how a consent list gets laundered: a spreadsheet of "active customers" silently becomes
   * thousands of `GRANTED` rows that no human ever confirmed. Requiring the importer's id is what makes
   * that list answerable later — "who loaded these 4,000 contacts and on what evidence" has to have an
   * answer, and the person who ran the upload is the only one who can give it. A contact's own STOP
   * carries no operator because no human is involved; a claim in someone's NAME does.
   */
  async record(
    sessionId: string,
    contact: string,
    basis: ConsentBasis,
    input: ConsentDecisionInput,
  ): Promise<ContactConsent> {
    if (NEEDS_OPERATOR.has(input.source) && !input.operatorId) {
      throw new Error(
        `A ${input.source.toLowerCase()}-sourced consent record needs an operatorId: an unattributed consent claim cannot be audited, which is the only reason this ledger exists`,
      );
    }

    const row = this.repository.create({
      sessionId,
      contact,
      basis,
      action: input.action,
      source: input.source,
      operatorId: input.operatorId ?? null,
      note: input.note ?? null,
      decidedAt: input.at ?? new Date(),
    });
    const saved = await this.repository.save(row);
    this.logger.log(`Recorded ${input.action} for ${contact} on session ${sessionId} (${basis}, ${input.source})`);
    return saved;
  }

  /**
   * The effective permission for a contact, per basis: the latest decision for each.
   *
   * Default is GRANTED. A contact who has never been recorded is reachable — a fresh install with a
   * pre-existing customer list must be able to message them, and requiring an explicit opt-in record
   * before any send would mean a compliance feature that breaks the product on day one. The opt-out
   * side is the one that must never depend on a record existing, which is why `SuppressedContact` is
   * enforced unconditionally on the send path and this ledger is evidence, not a gate.
   */
  async currentState(sessionId: string, contact: string): Promise<Record<ConsentBasis, ConsentAction>> {
    const current: Record<ConsentBasis, ConsentAction> = {
      [ConsentBasis.MARKETING]: ConsentAction.GRANTED,
      [ConsentBasis.TRANSACTIONAL]: ConsentAction.GRANTED,
    };

    const rows = await this.repository.find({
      where: { sessionId, contact },
      order: { decidedAt: 'DESC' },
    });
    // Rows are newest-first, so the first row seen for a basis is the latest decision for it. Tracked in
    // a SEPARATE seen-set rather than by testing `current[basis]`: the defaults above are both
    // GRANTED, so a check against `current` would find every basis already set and never apply a row at
    // all — silently reporting every contact as opted in.
    const seen = new Set<ConsentBasis>();
    for (const row of rows) {
      if (seen.has(row.basis)) continue;
      seen.add(row.basis);
      current[row.basis] = row.action;
    }
    return current;
  }

  /** True when the contact has not withdrawn this basis. */
  async isPermitted(sessionId: string, contact: string, basis: ConsentBasis): Promise<boolean> {
    return (await this.currentState(sessionId, contact))[basis] === ConsentAction.GRANTED;
  }

  /** The full record for one contact: current state plus every decision behind it. */
  async summary(sessionId: string, contact: string): Promise<ConsentSummary> {
    const [current, history] = await Promise.all([
      this.currentState(sessionId, contact),
      this.repository.find({ where: { sessionId, contact }, order: { decidedAt: 'ASC' } }),
    ]);
    return { contact, current, history };
  }

  /**
   * Apply an inbound opt-out/opt-in keyword as BOTH a consent withdrawal and a suppression.
   *
   * Returns the action, or null when the message was not a command. The keyword is matched on the
   * SENDER, not the chat, and only for a direct chat: in a group `from` is the group JID, so recording a
   * withdrawal against a group would fabricate consent state for every participant.
   *
   * The two writes are independent on purpose. Suppression is the gate the send path consults and must
   * not depend on the ledger; the ledger is the evidence and must be written even if suppression already
   * existed. A contact who opted out twice must produce two withdrawal records, not one — the second is
   * the evidence that the first was honoured.
   */
  async applyInboundKeyword(
    sessionId: string,
    sender: string,
    body: string | null | undefined,
    basis: ConsentBasis = ConsentBasis.MARKETING,
  ): Promise<ConsentAction | null> {
    const match = matchOptOut(body);
    if (!match) return null;
    if (chatKind(sender) !== 'individual') {
      this.logger.warn(
        `Ignoring a consent keyword ("${match.keyword}") from a ${chatKind(sender)} chat (${sender}); consent is per-contact, not per-group`,
      );
      return null;
    }

    const action = match.action === OptOutAction.OPT_OUT ? ConsentAction.WITHDRAWN : ConsentAction.GRANTED;
    await this.record(sessionId, sender, basis, {
      action,
      source: ConsentSource.KEYWORD,
      note: `Contact sent "${match.keyword}"`,
    });
    return action;
  }
}
