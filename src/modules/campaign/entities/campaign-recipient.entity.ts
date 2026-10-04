import { Entity, Column, Index, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Campaign } from './campaign.entity';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

export enum CampaignRecipientStatus {
  PENDING = 'pending',
  /**
   * Written before the engine is asked and replaced by SENT/FAILED once it answers. A row still in
   * SENDING after a restart may or may not have gone out, so it is failed as INTERRUPTED rather than
   * retried — a duplicate personalised message is worse than a visible gap the operator can re-send.
   */
  SENDING = 'sending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/** One spreadsheet row of a campaign and what happened to it. */
@Entity('campaign_recipients')
@Index('IDX_campaign_recipients_campaign_status_row', ['campaignId', 'status', 'rowNumber'])
@Index('IDX_campaign_recipients_campaign_attachment', ['campaignId', 'attachmentName'])
@Index('IDX_campaign_recipients_responseMessageId', ['responseMessageId'])
@Index('IDX_campaign_recipients_chatId', ['chatId'])
export class CampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  campaignId!: string;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign!: Campaign;

  @Column({ type: 'int' })
  rowNumber!: number;

  // Null only for a row skipped because its phone cell could not be read as a number.
  @Column({ type: 'varchar', nullable: true })
  chatId!: string | null;

  @Column({ type: jsonColumnType() })
  variables!: Record<string, string>;

  /**
   * The uploaded file this row's attachment cell names, normalised (see `normalizeAttachmentName`),
   * so an upload or a removal can flip exactly the rows that name it. Null when the cell is empty
   * or holds an http(s) link instead.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  attachmentName!: string | null;

  @Column({ type: 'varchar', default: CampaignRecipientStatus.PENDING })
  status!: CampaignRecipientStatus;

  @Column({ type: 'varchar', nullable: true })
  errorCode!: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'varchar', nullable: true })
  messageId!: string | null;

  /** The message the recipient answers: the poll, or the message listing the numbered options. */
  @Column({ type: 'varchar', nullable: true })
  responseMessageId!: string | null;

  /** The option(s) the recipient chose, latest answer wins; null until they answer (or after they withdraw a vote). */
  @Column({ type: jsonColumnType(), nullable: true })
  response!: string[] | null;

  /** How the latest answer arrived: `poll` (a tap) or `reply` (a typed message). */
  @Column({ type: 'varchar', nullable: true })
  responseVia!: 'poll' | 'reply' | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  respondedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;
}
