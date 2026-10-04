import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/** How a contact came to be suppressed. */
export enum SuppressionSource {
  /** The contact sent an opt-out keyword. The only source that can be un-done by the contact. */
  OPT_OUT_KEYWORD = 'opt_out_keyword',
  /** An operator suppressed it deliberately (manual import, complaint, legal request). */
  MANUAL = 'manual',
  /** WhatsApp itself reports the contact blocked the account (wwebjs `onBlock`/`onUnblock`). */
  BLOCKED = 'blocked',
}

/** What matched, when the suppression came from a keyword rather than an operator. */
export enum OptOutAction {
  /** The keyword opts the contact OUT — it is now suppressed. */
  OPT_OUT = 'opt_out',
  /** The keyword opts the contact back IN — any suppression of OPT_OUT source is lifted. */
  OPT_IN = 'opt_in',
}

/**
 * A chat this gateway must not send to.
 *
 * DATA connection, alongside `messages`: suppression has to be enforced on the send path, and a
 * control-plane table on the always-SQLite `main` connection would put a second database in the
 * critical path of every single message. It is scoped by `sessionId` because "do not contact" is a
 * property of one WhatsApp account, not of a phone number globally — the same number is a legitimate
 * customer on one session and a complainer on another, and a global block would silently stop a
 * paying customer's messages on their other account.
 *
 * `identifiers` is a JSON array of every form the chat is known by (the literal `@c.us`/`@lid`/
 * `@g.us` plus its phone and lid equivalents, resolved through the same expansion `allowedChats`
 * uses). Storing one literal string would be defeatable by simply addressing the same person through
 * their other identifier, which is the single easiest way to defeat an opt-out.
 */
@Entity('suppressed_contacts')
// The unique composite index already leads with sessionId, so it serves every session-scoped lookup;
// a separate IDX_suppressed_contacts_sessionId would be a second copy of the same leftmost column.
@Index('UQ_suppressed_contacts_sessionId_chatId', ['sessionId', 'chatId'], { unique: true })
export class SuppressedContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The chat id exactly as first observed. Unique with `sessionId` so a repeated opt-out updates the
   * existing row instead of accumulating duplicates.
   */
  @Column({ type: 'varchar', length: 100 })
  chatId!: string;

  @Column({ type: 'varchar', length: 36 })
  sessionId!: string;

  /**
   * Every identifier this chat resolves to. A suppression check compares the SEND's expanded
   * candidate set against this array, so a send addressed by `@lid` is refused when the opt-out came
   * in by `@c.us`, and the other way round.
   */
  // simple-json (never jsonb) to match the data connection, like `usage_events.metadata`: the pg driver
  // only auto-parses native json, and no query filters inside this array in SQL — TypeORM expands it.
  @Column({ type: jsonColumnType() })
  identifiers!: string[];

  @Column({ type: 'varchar', length: 32 })
  source!: SuppressionSource;

  /** Why, in the operator's words — a free-text audit note, never parsed. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  /**
   * The keyword that triggered it, for an opt-out. Null otherwise. Kept so "every send can name the
   * consent it relied on" is answerable after the fact without re-reading the transcript.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  keyword!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  suppressedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
