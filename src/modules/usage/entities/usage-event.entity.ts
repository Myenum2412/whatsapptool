import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

export enum UsageEventKind {
  MESSAGE_SENT = 'message.sent',
  MESSAGE_RECEIVED = 'message.received',
  SESSION_CONNECTED = 'session.connected',
  API_CALL = 'api.call',
  STORAGE_BYTE = 'storage.byte',
}

/**
 * One metered unit of consumption, attributed to an organization.
 *
 * DATA connection (SQLite or PostgreSQL — see column-types.ts), NOT the main control plane, and that
 * is the whole reason the ledger lives here: it is the highest-write-volume table in the product, so
 * it must be able to live on PostgreSQL and scale, and it must be deleted on a retention sweep
 * without touching the identity database. Its sibling `organizations` row lives on the always-SQLite
 * `main` connection, so `organizationId` is a plain column: a cross-database FK is not expressible
 * and the two databases are not in one transaction.
 *
 * Append-only and immutable. A correction is a new row, never an UPDATE of `quantity`: billing must
 * be able to re-derive a total from the rows alone, and an edited row makes two sums disagree with
 * no way to tell which was right.
 *
 * `occurredAt` is separate from `createdAt` on purpose. A backfill or an event produced during an
 * outage must be billable at when it happened, while `createdAt` records when the row landed; using
 * one column for both silently shifts historical invoices.
 */
@Entity('usage_events')
@Index('IDX_usage_events_organizationId_occurredAt', ['organizationId', 'occurredAt'])
@Index('IDX_usage_events_organizationId_kind_occurredAt', ['organizationId', 'kind', 'occurredAt'])
export class UsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  organizationId!: string;

  @Column({ type: 'varchar', length: 50 })
  kind!: UsageEventKind;

  // Units in this row (messages in a batch, kilobytes for storage). Summed over a window; kept > 1
  // so a 500-message batch is one row and one write instead of 500.
  @Column({ type: 'integer', default: 1 })
  quantity!: number;

  // Which session produced the usage, when it was a session-scoped action. Provenance only — no FK,
  // mirroring `ingress_events.sessionId`: a session deleted at retention must not delete or block
  // the ledger rows that already happened.
  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId!: string | null;

  // What was metered, when it was not a session: a chat id, a phone number, a storage key. Kept as a
  // loose varchar rather than a polymorphic relation because the ledger must record usage for
  // subjects whose owning row may already be gone.
  @Column({ type: 'varchar', length: 255, nullable: true })
  subject!: string | null;

  // The single field a quota or invoice window reads, and the leading column of the composite indexes
  // above so a per-organization range scan is an index range rather than a table scan.
  @Column({ type: dateColumnType(), transformer: DateTransformer })
  occurredAt!: Date;

  // simple-json (never jsonb) to match the data connection's existing columns: the pg driver only
  // auto-parses native json, and no usage query filters on this column in SQL.
  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  // No `@UpdateDateColumn`, deliberately. An auto-updating timestamp column is TypeORM's standing
  // invitation to `save()` a row in place, and the one invariant this table exists to provide is
  // that rows are immutable once written. `createdAt` records when the row landed and never moves;
  // a correction is a compensating row, so the sum over a closed period is reproducible from the
  // rows alone and an edited row cannot make two invoices disagree.
  @CreateDateColumn()
  createdAt!: Date;
}
