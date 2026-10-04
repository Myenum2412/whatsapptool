import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/** What a contact decided. */
export enum ConsentAction {
  GRANTED = 'granted',
  WITHDRAWN = 'withdrawn',
}

/**
 * What the decision is about.
 *
 * Separate bases because they carry different rules and different consequences, and collapsing them into
 * one flag is what produces the common mistake of a transactional "your invoice is ready" being refused
 * because the contact opted out of marketing. Transactional messages (receipts, delivery notices, a reply
 * to the contact's own question) are not marketing and regulators treat them differently.
 */
export enum ConsentBasis {
  /** Promotional and marketing contact. The basis an opt-out keyword withdraws. */
  MARKETING = 'marketing',
  /** Operational messages about an existing transaction or conversation. */
  TRANSACTIONAL = 'transactional',
}

/** How the decision came about — what makes it attributable, and therefore auditable. */
export enum ConsentSource {
  /** The contact said so: an inbound keyword, a link click, a ticked box on our own page. */
  CONTACT = 'contact',
  /** A named human recorded it, e.g. from a signed form during onboarding. */
  OPERATOR = 'operator',
  /** Migrated from a previous system. Evidence quality is the operator's problem, so it is named. */
  IMPORT = 'import',
  /**
   * The contact sent an opt-out/opt-in keyword over WhatsApp itself.
   *
   * Distinct from `CONTACT` because the evidence is qualitatively different and worth being able to
   * count: an inbound keyword is self-authenticated by the WhatsApp session, whereas a `CONTACT` row
   * (a link click, a web form) rests on a system of ours that could in principle be wrong.
   */
  KEYWORD = 'keyword',
}

/**
 * One immutable, attributed decision about one contact's permission to be messaged.
 *
 * DATA connection, alongside `sessions` and `suppressed_contacts`: a consent record is worthless if it
 * cannot be produced alongside the messages it authorises, and it must survive a control-plane rebuild.
 * Scoped by `sessionId` for the same reason suppression is — permission is granted to one WhatsApp
 * account, and the same number may be an opted-out complainer on one account and a customer on another.
 *
 * APPEND-ONLY. There is no `updatedAt` and no code path that updates a row: `SuppressedContact` holds
 * current state, and this holds the trail that state came from. Editing a consent row would leave no
 * record that consent was ever granted, which is exactly the row an evidentiary request is about.
 */
@Entity('contact_consents')
@Index('IDX_contact_consents_sessionId_contact_decidedAt', ['sessionId', 'contact', 'decidedAt'])
@Index('IDX_contact_consents_sessionId_basis', ['sessionId', 'basis'])
export class ContactConsent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  contact!: string;

  @Column({ type: 'varchar', length: 36 })
  sessionId!: string;

  @Column({ type: 'varchar', length: 24 })
  basis!: ConsentBasis;

  @Column({ type: 'varchar', length: 16 })
  action!: ConsentAction;

  @Column({ type: 'varchar', length: 24 })
  source!: ConsentSource;

  /**
   * The operator who recorded an `OPERATOR` claim. Null for a contact-sourced decision, which needs no
   * attribution — the contact IS the authority. Required for operator and import claims, enforced in the
   * service: an unattributed consent record cannot be audited, which defeats the ledger's only purpose.
   *
   * A user id from the `main` control plane, so this is a plain column, not a cross-connection FK.
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  operatorId!: string | null;

  /** Free-text context: the keyword matched, the form reference. Never parsed. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  /**
   * WHEN the decision was made, as distinct from when the row landed. An operator backfilling a signed
   * form from last week must record last week's date: using `createdAt` would date the consent to the
   * day of the import, which reads as consent taken after the messages it supposedly authorised.
   */
  @Column({ type: dateColumnType(), transformer: DateTransformer })
  decidedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
