import { Entity, Column, Index, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Campaign } from './campaign.entity';

/**
 * `all`: sent to every recipient. `row`: sent only to the rows whose attachment cell names it.
 */
export type CampaignAttachmentScope = 'all' | 'row';

/**
 * A file uploaded for a campaign. The bytes live in the configured storage backend (local disk or
 * S3) under `storageKey`, once — never per recipient; this row is the metadata the send loop and
 * the per-row matching read.
 */
@Entity('campaign_attachments')
@Index('IDX_campaign_attachments_campaign_name', ['campaignId', 'normalizedName'], { unique: true })
export class CampaignAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  campaignId!: string;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign!: Campaign;

  @Column({ type: 'varchar' })
  scope!: CampaignAttachmentScope;

  /** The filename as uploaded; WhatsApp shows it on a document. */
  @Column({ type: 'varchar', length: 255 })
  filename!: string;

  /** Lower-cased basename, the key a row's attachment cell is matched on. */
  @Column({ type: 'varchar', length: 255 })
  normalizedName!: string;

  @Column({ type: 'varchar', length: 255 })
  mimetype!: string;

  @Column({ type: 'int' })
  sizeBytes!: number;

  @Column({ type: 'varchar', length: 500 })
  storageKey!: string;

  /** Upload order within the campaign; files for everyone are sent in this order. */
  @Column({ type: 'int', default: 0 })
  position!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
