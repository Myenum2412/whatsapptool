import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

export enum CampaignStatus {
  /** Uploaded and validated; nothing sent until it is started. */
  DRAFT = 'draft',
  RUNNING = 'running',
  /** Stopped by the operator, by a pacing limit, or by a restart; resumable. */
  PAUSED = 'paused',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** Why a campaign is PAUSED, when the operator did not pause it themselves. */
export enum CampaignPauseReason {
  MANUAL = 'MANUAL',
  /** A send-pacing allowance (daily cap, cold-reachout cap, breaker) refused the next send. */
  PACING_LIMITED = 'PACING_LIMITED',
  /** The session's engine went away (disconnected, stopped). */
  SESSION_NOT_READY = 'SESSION_NOT_READY',
  /** The process restarted while the campaign was running. */
  INTERRUPTED = 'INTERRUPTED',
}

/**
 * How attachments go out. `auto` sends each by its type (photo, video, voice/audio, or document);
 * `document` sends every attachment as a document, which keeps photos and videos at full quality.
 */
export type CampaignMediaType = 'auto' | 'document';

/**
 * How recipients answer a campaign's response options:
 * - `poll`: a WhatsApp poll sent after the message — the recipient taps an option.
 * - `reply`: the options are listed under the message, numbered, and the recipient replies with a
 *   number or the option's text.
 * A typed reply that matches an option is recorded under either style.
 */
export type CampaignResponseStyle = 'poll' | 'reply';

export interface CampaignColumn {
  header: string;
  key: string;
}

export interface CampaignProgress {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * A mail-merge send: one template rendered once per spreadsheet row, each row's cells supplying the
 * `{{placeholders}}`, sent to that row's phone number. The template text is snapshotted at creation
 * (`header`/`body`/`footer`) so editing or deleting the template mid-campaign cannot change what the
 * remaining recipients receive.
 */
@Entity('campaigns')
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_campaigns_sessionId')
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', default: CampaignStatus.DRAFT })
  status!: CampaignStatus;

  @Column({ type: 'varchar', nullable: true })
  pauseReason!: CampaignPauseReason | null;

  // Kept for reference only; the snapshot below is what gets sent.
  @Column({ type: 'varchar', nullable: true })
  templateId!: string | null;

  @Column({ type: 'text', nullable: true })
  header!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', nullable: true })
  footer!: string | null;

  @Column({ type: jsonColumnType() })
  columns!: CampaignColumn[];

  @Column({ type: 'varchar', length: 200 })
  phoneColumn!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  mediaColumn!: string | null;

  @Column({ type: 'varchar', default: 'auto' })
  mediaType!: CampaignMediaType;

  @Column({ type: 'int', default: 5000 })
  delayMs!: number;

  @Column({ type: 'boolean', default: true })
  randomizeDelay!: boolean;

  @Column({ type: jsonColumnType() })
  progress!: CampaignProgress;

  /** Null: the campaign asks for no response. */
  @Column({ type: 'varchar', nullable: true })
  responseStyle!: CampaignResponseStyle | null;

  /** Poll question, or the line above the numbered options; may use {{placeholders}}. */
  @Column({ type: 'text', nullable: true })
  responseQuestion!: string | null;

  /** The options, in the order shown. */
  @Column({ type: jsonColumnType(), nullable: true })
  responseOptions!: string[] | null;

  /** Whether a recipient may pick more than one option. */
  @Column({ type: 'boolean', default: false })
  responseMultiple!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceFilename!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;
}
