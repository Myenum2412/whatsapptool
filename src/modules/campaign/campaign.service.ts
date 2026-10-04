import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Campaign, CampaignProgress, CampaignPauseReason, CampaignStatus } from './entities/campaign.entity';
import { CampaignRecipient, CampaignRecipientStatus } from './entities/campaign-recipient.entity';
import { CampaignAttachment, CampaignAttachmentScope } from './entities/campaign-attachment.entity';
import {
  CampaignAttachmentDto,
  CampaignAttachmentUploadResponseDto,
  CampaignDetailResponseDto,
  CampaignPreviewDto,
  CampaignRecipientPageDto,
  CampaignResponseSummaryDto,
  CreateCampaignDto,
  ListRecipientsQueryDto,
  SpreadsheetInspectResponseDto,
  CAMPAIGN_DELAY_DEFAULT_MS,
} from './dto/campaign.dto';
import { parseSpreadsheet, ParsedSpreadsheet, SpreadsheetColumn } from './spreadsheet-parser';
import {
  CampaignSendType,
  CampaignSkipReason,
  filenameFromUrl,
  inferMediaType,
  missingAttachmentDetail,
  normalizeAttachmentName,
  normalizePhoneToChatId,
  prepareRecipients,
  resolveMimetype,
  sendTypeForMimetype,
} from './campaign-rows';
import { Session } from '../session/entities/session.entity';
import { CampaignResponseService } from './responses/campaign-response.service';
import {
  RESPONSE_QUESTION_MAX_CHARS,
  replyOptionsBlock,
  validateResponseOptions,
} from './responses/campaign-response-matching';
import { Message } from '../message/entities/message.entity';
import { StorageService } from '../../common/storage/storage.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { TemplateService } from '../template/template.service';
import { MessageService, DEFAULT_TEMPLATE_RENDER_MAX_CHARS } from '../message/message.service';
import { isPacingLimitedError } from '../message/send-pacing.service';
import { sanitizeBatchError } from '../message/bulk-message.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { isMediaUrl } from '../../common/media/media-url';
import { extractTemplatePlaceholders, renderTemplate } from '../../common/utils/template-render';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/** Largest spreadsheet upload accepted, in bytes. */
export const DEFAULT_CAMPAIGN_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export function resolveCampaignUploadMaxBytes(): number {
  return resolveNonNegativeIntEnv(process.env.CAMPAIGN_UPLOAD_MAX_BYTES, DEFAULT_CAMPAIGN_UPLOAD_MAX_BYTES);
}

/** Most data rows one campaign may hold. */
export const DEFAULT_CAMPAIGN_MAX_ROWS = 10_000;
export function resolveCampaignMaxRows(): number {
  return (
    resolveNonNegativeIntEnv(process.env.CAMPAIGN_MAX_ROWS, DEFAULT_CAMPAIGN_MAX_ROWS) || DEFAULT_CAMPAIGN_MAX_ROWS
  );
}

const SPREADSHEET_MAX_COLUMNS = 50;
const SPREADSHEET_MAX_CELL_CHARS = 4096;
// WhatsApp's caption limit, and the one SendMediaMessageDto enforces on the HTTP route.
const MEDIA_CAPTION_MAX_CHARS = 1024;
const PREVIEW_ROWS = 5;
const SAMPLE_ROWS = 5;
const INSERT_CHUNK = 200;
/** Storage prefix for campaign attachments: `campaign-media/<campaignId>/<random>.<ext>`. */
export const CAMPAIGN_MEDIA_PREFIX = 'campaign-media/';
// Headroom over the row cap for files sent to everyone; a per-row file is at most one per row.
const ATTACHMENT_HEADROOM = 50;
// Upper bound on the "sent to everyone" files held decoded in memory by one send loop.
const SHARED_ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;

type SendOutcome = 'next' | 'pause';

/** One piece of a row's delivery: an uploaded file or a per-row link. */
type MediaPart =
  | { kind: 'stored'; attachment: CampaignAttachment; type: CampaignSendType }
  | { kind: 'url'; url: string; type: CampaignSendType };

/**
 * A row whose delivery is several messages failed after some of them were already sent. The row
 * cannot be retried without repeating what the recipient already has, so it is failed, not released.
 */
class PartialSendError extends Error {
  constructor(
    readonly sent: number,
    readonly total: number,
    readonly cause: unknown,
  ) {
    super(`Sent ${sent} of ${total} messages before failing`);
  }
}

/** Multer mis-decodes UTF-8 filenames as latin1; recover the original when that is what happened. */
export function decodeUploadFilename(name: string | undefined): string {
  // Drop control characters (a filename is shown to recipients and written into reports).
  const raw = [...(name ?? '')]
    .filter(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const best = /[\u0080-\u00ff]/.test(raw) && !decoded.includes('\uFFFD') ? decoded : raw;
  return (best.split(/[\\/]/).pop() ?? '').slice(0, 255);
}

/** Render the snapshotted template for one row the same way send-template does: segments joined by a blank line. */
export function renderCampaignText(
  campaign: Pick<Campaign, 'header' | 'body' | 'footer'>,
  vars: Record<string, string>,
): string {
  return [campaign.header, campaign.body, campaign.footer]
    .filter((segment): segment is string => segment != null && segment.length > 0)
    .map(segment => renderTemplate(segment, vars))
    .join('\n\n')
    .trim();
}

/**
 * The full text a row receives: the rendered template, plus — for a `reply`-style campaign — the
 * question and the numbered options underneath, so the recipient can answer with a number.
 */
export function composeCampaignText(
  campaign: Pick<Campaign, 'header' | 'body' | 'footer' | 'responseStyle' | 'responseQuestion' | 'responseOptions'>,
  vars: Record<string, string>,
): string {
  const text = renderCampaignText(campaign, vars);
  if (campaign.responseStyle !== 'reply' || !campaign.responseOptions?.length) return text;
  const block = replyOptionsBlock(renderTemplate(campaign.responseQuestion ?? '', vars), campaign.responseOptions);
  return text ? `${text}\n\n${block}` : block;
}

/** Neutralise a CSV cell a spreadsheet app would evaluate as a formula (CSV injection). */
export function csvCell(value: string | number | Date | null | undefined): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Mail-merge campaigns: a spreadsheet of recipients, one template, one personalised message per row.
 *
 * Every send goes through MessageService — the same path as a single API send — so send pacing
 * (warm-up and cold-reachout caps, the failure breaker), the `message:sending` plugin gate, typing
 * simulation and message persistence all apply to each row. A pacing refusal or a lost session
 * PAUSES the campaign with a reason instead of failing the remaining rows, so it can be resumed
 * once the allowance frees up or the session reconnects.
 */
@Injectable()
export class CampaignService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CampaignService.name);
  /** The send loop running in this process for each campaign, so a resume joins it instead of starting a second. */
  private readonly loops = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaignRepository: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipientRepository: Repository<CampaignRecipient>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(CampaignAttachment, 'data')
    private readonly attachmentRepository: Repository<CampaignAttachment>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly storage: StorageService,
    private readonly templateService: TemplateService,
    private readonly messageService: MessageService,
    private readonly engines: EngineRegistry,
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    @Optional()
    private readonly configService?: ConfigService,
    // Optional so the service still constructs standalone; absent means typed replies to a campaign
    // that just started may wait up to a minute for the response lookup's cache to notice it.
    @Optional()
    private readonly responses?: CampaignResponseService,
  ) {}

  /**
   * A campaign still RUNNING at boot was being driven by a process that is gone. It is paused, not
   * resumed: the operator decides when sending continues. A row caught mid-send is failed as
   * INTERRUPTED because whether it reached WhatsApp is unknowable — re-sending it could duplicate.
   * Only campaigns whose session this node may hold are touched; a peer's are still live.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.pauseInterruptedCampaigns();
    await this.sweepOrphanedAttachments().catch(error =>
      this.logger.warn(`Campaign attachment sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  private async pauseInterruptedCampaigns(): Promise<void> {
    const running = await this.campaignRepository.find({ where: { status: CampaignStatus.RUNNING } });
    if (running.length === 0) return;
    const claimable = this.ownership
      ? new Set(await this.ownership.claimable([...new Set(running.map(c => c.sessionId))]))
      : null;
    const orphaned = running.filter(c => !claimable || claimable.has(c.sessionId));
    for (const campaign of orphaned) {
      await this.recipientRepository.update(
        { campaignId: campaign.id, status: CampaignRecipientStatus.SENDING },
        {
          status: CampaignRecipientStatus.FAILED,
          errorCode: 'INTERRUPTED',
          errorMessage: 'The server restarted during this send; it may or may not have been delivered',
        },
      );
      await this.campaignRepository.update(
        { id: campaign.id, status: CampaignStatus.RUNNING },
        { status: CampaignStatus.PAUSED, pauseReason: CampaignPauseReason.INTERRUPTED },
      );
      await this.refreshProgress(campaign.id);
    }
    if (orphaned.length > 0) {
      this.logger.warn(`Paused ${orphaned.length} campaign(s) interrupted by a restart; resume them to continue`);
    }
  }

  /**
   * Delete stored attachment files whose campaign no longer exists. Deleting a campaign removes its
   * files directly, but deleting a session cascades its campaigns in the database only, leaving the
   * files behind. Only a vanished campaign's files are touched: a live campaign's are always kept,
   * so an upload in flight on another node is never raced.
   */
  async sweepOrphanedAttachments(): Promise<number> {
    const byCampaign = new Map<string, string[]>();
    for await (const key of this.storage.iterateFiles(CAMPAIGN_MEDIA_PREFIX)) {
      const campaignId = key.slice(CAMPAIGN_MEDIA_PREFIX.length).split('/')[0];
      if (!campaignId) continue;
      byCampaign.set(campaignId, [...(byCampaign.get(campaignId) ?? []), key]);
    }
    if (byCampaign.size === 0) return 0;
    const ids = [...byCampaign.keys()];
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      const found = await this.campaignRepository.find({
        where: { id: In(ids.slice(i, i + INSERT_CHUNK)) },
        select: { id: true },
      });
      for (const c of found) existing.add(c.id);
    }
    let removed = 0;
    for (const [campaignId, keys] of byCampaign) {
      if (existing.has(campaignId)) continue;
      for (const key of keys) {
        await this.storage.deleteFile(key).then(
          () => removed++,
          () => undefined,
        );
      }
    }
    if (removed > 0) this.logger.log(`Removed ${removed} attachment file(s) left behind by deleted campaigns`);
    return removed;
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Upload & creation
  // ---------------------------------------------------------------------------------------------

  async inspect(sessionId: string, file: { buffer?: Buffer } | undefined): Promise<SpreadsheetInspectResponseDto> {
    await this.assertSessionExists(sessionId);
    const sheet = await this.parseUpload(file);
    return {
      columns: sheet.columns,
      rowCount: sheet.rows.length,
      sampleRows: sheet.rows.slice(0, SAMPLE_ROWS).map(row => row.values),
      suggestedPhoneColumn: suggestPhoneColumn(sheet)?.header,
    };
  }

  async create(
    sessionId: string,
    dto: CreateCampaignDto,
    file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<CampaignDetailResponseDto> {
    await this.assertSessionExists(sessionId);
    const sheet = await this.parseUpload(file);
    if (sheet.rows.length === 0) {
      throw new BadRequestException('The spreadsheet has a header row but no data rows');
    }

    const message = dto.templateId
      ? await this.templateService.findOne(sessionId, dto.templateId)
      : { id: null, header: null, body: dto.body ?? '', footer: null };

    const phoneKey = resolveColumn(sheet.columns, dto.phoneColumn, 'phoneColumn');
    const mediaKey = dto.mediaColumn ? resolveColumn(sheet.columns, dto.mediaColumn, 'mediaColumn') : null;

    const response = this.resolveResponseSettings(dto);
    const placeholders = [
      ...new Set(
        [message.header, message.body, message.footer, response?.question].flatMap(extractTemplatePlaceholders),
      ),
    ];
    const known = new Set(sheet.columns.map(c => c.key));
    const unknown = placeholders.filter(key => !known.has(key));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `The message uses ${unknown.map(k => `{{${k}}}`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not ` +
          `a column in the spreadsheet. Available: ${sheet.columns.map(c => `{{${c.key}}}`).join(', ')}`,
      );
    }

    const prepared = prepareRecipients(sheet.rows, {
      phoneKey,
      placeholders,
      mediaKey,
      defaultCountryCode: dto.defaultCountryCode,
      skipRowsWithMissingValues: dto.skipRowsWithMissingValues ?? true,
    });

    const campaign = await this.campaignRepository.manager.transaction(async manager => {
      const created = await manager.save(
        manager.create(Campaign, {
          sessionId,
          name: dto.name,
          status: CampaignStatus.DRAFT,
          pauseReason: null,
          templateId: message.id,
          header: message.header,
          body: message.body,
          footer: message.footer,
          columns: sheet.columns,
          phoneColumn: phoneKey,
          mediaColumn: mediaKey,
          mediaType: dto.mediaType ?? 'auto',
          delayMs: dto.delayMs ?? CAMPAIGN_DELAY_DEFAULT_MS,
          randomizeDelay: dto.randomizeDelay ?? true,
          progress: progressOfPrepared(prepared),
          responseStyle: response?.style ?? null,
          responseQuestion: response?.question ?? null,
          responseOptions: response?.options ?? null,
          responseMultiple: response?.multiple ?? false,
          sourceFilename: file?.originalname?.slice(0, 255) ?? null,
          startedAt: null,
          completedAt: null,
        }),
      );
      for (let i = 0; i < prepared.length; i += INSERT_CHUNK) {
        const chunk = prepared.slice(i, i + INSERT_CHUNK).map(row =>
          manager.create(CampaignRecipient, {
            campaignId: created.id,
            rowNumber: row.rowNumber,
            chatId: row.chatId,
            variables: row.variables,
            attachmentName: row.attachmentName,
            status: row.skipReason ? CampaignRecipientStatus.SKIPPED : CampaignRecipientStatus.PENDING,
            errorCode: row.skipReason ?? null,
            errorMessage: row.skipDetail ?? null,
            messageId: null,
            sentAt: null,
          }),
        );
        await manager.save(chunk);
      }
      return created;
    });

    this.logger.log(
      `Created campaign ${campaign.id} for session ${sessionId}: ${campaign.progress.pending} to send, ${campaign.progress.skipped} skipped`,
    );
    return this.getDetail(sessionId, campaign.id);
  }

  /** Validate the response-option fields; null when the campaign asks for no response. */
  private resolveResponseSettings(
    dto: CreateCampaignDto,
  ): { style: 'poll' | 'reply'; question: string | null; options: string[]; multiple: boolean } | null {
    if (!dto.responseStyle && !dto.responseOptions?.length) return null;
    const style = dto.responseStyle ?? 'poll';
    const options = validateResponseOptions(style, dto.responseOptions ?? []);
    if (typeof options === 'string') throw new BadRequestException(options);
    const question = dto.responseQuestion?.trim() || null;
    if (style === 'poll' && !question) {
      throw new BadRequestException('A poll needs a question: set responseQuestion (e.g. "Are you interested?")');
    }
    return { style, question, options, multiple: dto.responseMultiple ?? false };
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async list(sessionId: string): Promise<Campaign[]> {
    return this.campaignRepository.find({ where: { sessionId }, order: { createdAt: 'DESC' } });
  }

  async findOne(sessionId: string, id: string): Promise<Campaign> {
    const campaign = await this.campaignRepository.findOne({ where: { id, sessionId } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);
    return campaign;
  }

  async getDetail(sessionId: string, id: string): Promise<CampaignDetailResponseDto> {
    const campaign = await this.findOne(sessionId, id);
    const skipped = await this.recipientRepository
      .createQueryBuilder('r')
      .select('r.errorCode', 'code')
      .addSelect('COUNT(*)', 'count')
      .where('r.campaignId = :id AND r.status = :status', { id, status: CampaignRecipientStatus.SKIPPED })
      .groupBy('r.errorCode')
      .getRawMany<{ code: string | null; count: string | number }>();
    const skippedByReason: Record<string, number> = {};
    for (const row of skipped) skippedByReason[row.code ?? 'UNKNOWN'] = Number(row.count);

    const upcoming = await this.recipientRepository.find({
      where: { campaignId: id, status: CampaignRecipientStatus.PENDING },
      order: { rowNumber: 'ASC' },
      take: PREVIEW_ROWS,
    });
    const attachments = await this.attachmentsOf(id);
    const shared = attachments.filter(a => a.scope === 'all').map(a => a.filename);
    const perRow = new Map(attachments.filter(a => a.scope === 'row').map(a => [a.normalizedName, a.filename]));
    const preview: CampaignPreviewDto[] = upcoming.map(r => {
      const cell = campaign.mediaColumn ? (r.variables[campaign.mediaColumn] ?? '').trim() : '';
      const own = r.attachmentName
        ? perRow.get(r.attachmentName)
        : cell && isMediaUrl(cell)
          ? (filenameFromUrl(cell) ?? cell)
          : undefined;
      return {
        rowNumber: r.rowNumber,
        chatId: r.chatId ?? '',
        text: composeCampaignText(campaign, r.variables),
        attachments: own ? [...shared, own] : shared,
        ...(campaign.responseStyle === 'poll' && campaign.responseOptions
          ? {
              poll: {
                question: renderTemplate(campaign.responseQuestion ?? '', r.variables).slice(
                  0,
                  RESPONSE_QUESTION_MAX_CHARS,
                ),
                options: campaign.responseOptions,
              },
            }
          : {}),
      };
    });

    const rest: Omit<Campaign, 'session'> & { session?: Session } = { ...campaign };
    delete rest.session;
    return {
      ...rest,
      skippedByReason,
      preview,
      attachments: attachments.map(a => this.toAttachmentDto(campaign, a)),
      missingAttachments: await this.missingAttachmentNames(campaign),
      responseSummary: campaign.responseOptions
        ? await this.responseSummary(campaign.id, campaign.responseOptions)
        : null,
    };
  }

  /** Answers per option across the rows that were sent, plus how many have not answered. */
  private async responseSummary(campaignId: string, options: string[]): Promise<CampaignResponseSummaryDto> {
    const rows = await this.recipientRepository.find({
      where: { campaignId, status: CampaignRecipientStatus.SENT },
      select: { id: true, response: true },
    });
    const counts = new Map(options.map(o => [o, 0]));
    let responded = 0;
    for (const { response } of rows) {
      if (!response?.length) continue;
      responded++;
      for (const choice of response) if (counts.has(choice)) counts.set(choice, counts.get(choice)! + 1);
    }
    return {
      options: options.map(option => ({ option, count: counts.get(option)! })),
      responded,
      awaiting: rows.length - responded,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------------------------

  /**
   * Store one uploaded file for a draft campaign. `all` files go to every recipient; a `row` file
   * goes to the rows whose attachment column names it, and uploading it releases exactly those rows
   * from MISSING_ATTACHMENT. One file per request keeps each upload inside the gateway's in-flight
   * body budget, however many files a campaign needs.
   */
  async addAttachment(
    sessionId: string,
    id: string,
    scope: CampaignAttachmentScope,
    file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
  ): Promise<CampaignAttachmentUploadResponseDto> {
    const campaign = await this.findDraft(sessionId, id);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Attach the file as the multipart field `file`');
    }
    if (scope === 'row' && !campaign.mediaColumn) {
      throw new BadRequestException(
        'This campaign has no attachment column, so a per-row file would match no one. Upload it with scope=all to send it to everyone.',
      );
    }
    const filename = decodeUploadFilename(file.originalname);
    const normalizedName = normalizeAttachmentName(filename);
    if (!normalizedName) throw new BadRequestException('The uploaded file has no usable name');

    const max = resolveCampaignMaxRows() + ATTACHMENT_HEADROOM;
    if ((await this.attachmentRepository.count({ where: { campaignId: id } })) >= max) {
      throw new BadRequestException(`A campaign can hold at most ${max} attachments`);
    }
    if (await this.attachmentRepository.exists({ where: { campaignId: id, normalizedName } })) {
      throw new ConflictException(`A file named "${filename}" is already attached; remove it first to replace it`);
    }

    const ext = /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1]?.toLowerCase();
    const storageKey = `${CAMPAIGN_MEDIA_PREFIX}${id}/${randomUUID()}${ext ? `.${ext}` : ''}`;
    await this.storage.putFile(storageKey, file.buffer);
    let attachment: CampaignAttachment;
    try {
      attachment = await this.attachmentRepository.save(
        this.attachmentRepository.create({
          campaignId: id,
          scope,
          filename,
          normalizedName,
          mimetype: resolveMimetype(filename, file.mimetype),
          sizeBytes: file.buffer.length,
          storageKey,
          position: await this.nextAttachmentPosition(id),
        }),
      );
    } catch (error) {
      await this.storage.deleteFile(storageKey).catch(() => undefined);
      // Two uploads of the same name racing: the unique index decides, the loser gets the same 409.
      if (await this.attachmentRepository.exists({ where: { campaignId: id, normalizedName } })) {
        throw new ConflictException(`A file named "${filename}" is already attached; remove it first to replace it`);
      }
      throw error;
    }

    let rowsMatched = 0;
    if (scope === 'row') {
      const released = await this.recipientRepository.update(
        {
          campaignId: id,
          attachmentName: normalizedName,
          status: CampaignRecipientStatus.SKIPPED,
          errorCode: CampaignSkipReason.MISSING_ATTACHMENT,
        },
        { status: CampaignRecipientStatus.PENDING, errorCode: null, errorMessage: null },
      );
      rowsMatched = released.affected ?? 0;
      await this.refreshProgress(id);
    }
    return { attachment: this.toAttachmentDto(campaign, attachment), rowsMatched };
  }

  async removeAttachment(sessionId: string, id: string, attachmentId: string): Promise<void> {
    await this.findDraft(sessionId, id);
    const attachment = await this.attachmentRepository.findOne({ where: { id: attachmentId, campaignId: id } });
    if (!attachment) throw new NotFoundException(`Attachment '${attachmentId}' not found`);
    await this.attachmentRepository.delete({ id: attachment.id });
    if (attachment.scope === 'row') {
      await this.recipientRepository.update(
        { campaignId: id, attachmentName: attachment.normalizedName, status: CampaignRecipientStatus.PENDING },
        {
          status: CampaignRecipientStatus.SKIPPED,
          errorCode: CampaignSkipReason.MISSING_ATTACHMENT,
          errorMessage: missingAttachmentDetail(attachment.filename),
        },
      );
      await this.refreshProgress(id);
    }
    await this.storage
      .deleteFile(attachment.storageKey)
      .catch(error => this.logger.warn(`Could not delete attachment file ${attachment.storageKey}: ${String(error)}`));
  }

  private async findDraft(sessionId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOne(sessionId, id);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(
        `Attachments can only be changed while the campaign is a draft (it is ${campaign.status})`,
      );
    }
    return campaign;
  }

  private attachmentsOf(campaignId: string): Promise<CampaignAttachment[]> {
    return this.attachmentRepository.find({ where: { campaignId }, order: { position: 'ASC', filename: 'ASC' } });
  }

  private async nextAttachmentPosition(campaignId: string): Promise<number> {
    const last = await this.attachmentRepository.findOne({
      where: { campaignId },
      order: { position: 'DESC' },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  }

  private toAttachmentDto(campaign: Pick<Campaign, 'mediaType'>, a: CampaignAttachment): CampaignAttachmentDto {
    return {
      id: a.id,
      scope: a.scope,
      filename: a.filename,
      mimetype: a.mimetype,
      sizeBytes: a.sizeBytes,
      sendAs: sendTypeForMimetype(a.mimetype, campaign.mediaType === 'document'),
      createdAt: a.createdAt,
    };
  }

  /** The filenames rows still wait for, as written in the sheet, so the operator knows what to upload. */
  private async missingAttachmentNames(campaign: Campaign): Promise<string[]> {
    if (!campaign.mediaColumn) return [];
    const rows = await this.recipientRepository.find({
      where: {
        campaignId: campaign.id,
        status: CampaignRecipientStatus.SKIPPED,
        errorCode: CampaignSkipReason.MISSING_ATTACHMENT,
      },
      select: { variables: true, attachmentName: true },
      order: { rowNumber: 'ASC' },
      take: 1000,
    });
    const names = new Map<string, string>();
    for (const r of rows) {
      if (!r.attachmentName || names.has(r.attachmentName)) continue;
      const cell = (r.variables[campaign.mediaColumn] ?? '').trim();
      names.set(r.attachmentName, cell.split(/[\\/]/).pop() || r.attachmentName);
      if (names.size >= 50) break;
    }
    return [...names.values()];
  }

  async listRecipients(
    sessionId: string,
    id: string,
    query: ListRecipientsQueryDto,
  ): Promise<CampaignRecipientPageDto> {
    await this.findOne(sessionId, id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.recipientRepository
      .createQueryBuilder('r')
      .where('r.campaignId = :id', { id })
      .orderBy('r.rowNumber', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.responded === 'yes') qb.andWhere('r.response IS NOT NULL');
    if (query.responded === 'no') {
      qb.andWhere('r.response IS NULL').andWhere('r.status = :sent', { sent: CampaignRecipientStatus.SENT });
    }
    if (query.response) {
      // `response` is a JSON array stored as text; the option's own JSON string (quotes included)
      // matches it exactly, so "Interested" never matches "Not interested".
      const needle = JSON.stringify(query.response).replace(/[\\%_]/g, char => `\\${char}`);
      qb.andWhere(`r.response LIKE :needle ESCAPE '\\'`, { needle: `%${needle}%` });
    }
    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map(row => {
        const item: Partial<CampaignRecipient> = { ...row };
        delete item.campaign;
        delete item.campaignId;
        return item as CampaignRecipientPageDto['items'][number];
      }),
      total,
      page,
      limit,
    };
  }

  /** Every row with its original cells plus the outcome, as CSV — the report an operator reconciles against. */
  async exportResults(sessionId: string, id: string): Promise<{ filename: string; csv: string }> {
    const campaign = await this.findOne(sessionId, id);
    const rows = await this.recipientRepository.find({ where: { campaignId: id }, order: { rowNumber: 'ASC' } });
    const asksResponse = !!campaign.responseOptions;
    const header = [
      'Row',
      ...campaign.columns.map(c => c.header),
      'Chat ID',
      'Status',
      'Error',
      'Message ID',
      'Sent At',
      ...(asksResponse ? ['Response', 'Responded At', 'Responded Via'] : []),
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.rowNumber,
          ...campaign.columns.map(c => r.variables[c.key] ?? ''),
          r.chatId,
          r.status,
          r.errorMessage ?? r.errorCode,
          r.messageId,
          r.sentAt,
          ...(asksResponse ? [r.response?.join('; ') ?? '', r.respondedAt, r.responseVia] : []),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const safeName = campaign.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'campaign';
    // Leading BOM so Excel opens the UTF-8 file with non-ASCII names intact.
    return { filename: `${safeName}-results.csv`, csv: `\uFEFF${lines.join('\r\n')}\r\n` };
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /** Start a draft, or resume a paused campaign. */
  async start(sessionId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOne(sessionId, id);
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.PAUSED) {
      throw new BadRequestException(`Campaign is ${campaign.status}; only a draft or paused campaign can be started`);
    }
    if (!this.engines.get(sessionId)) {
      throw new EngineNotReadyError(`Session '${sessionId}' is not active. Start the session before the campaign.`);
    }
    const updated = await this.campaignRepository.update(
      { id, status: In([CampaignStatus.DRAFT, CampaignStatus.PAUSED]) },
      { status: CampaignStatus.RUNNING, pauseReason: null, ...(campaign.startedAt ? {} : { startedAt: new Date() }) },
    );
    if (!updated.affected) throw new BadRequestException('Campaign changed state; reload and try again');
    this.logger.log(`Campaign ${id} started`);
    this.responses?.invalidate(sessionId);
    this.launch(id);
    return this.findOne(sessionId, id);
  }

  async pause(sessionId: string, id: string): Promise<Campaign> {
    const updated = await this.campaignRepository.update(
      { id, sessionId, status: CampaignStatus.RUNNING },
      { status: CampaignStatus.PAUSED, pauseReason: CampaignPauseReason.MANUAL },
    );
    const campaign = await this.findOne(sessionId, id);
    if (!updated.affected)
      throw new BadRequestException(`Campaign is ${campaign.status}; only a running campaign can be paused`);
    return campaign;
  }

  async cancel(sessionId: string, id: string): Promise<Campaign> {
    const updated = await this.campaignRepository.update(
      { id, sessionId, status: In([CampaignStatus.DRAFT, CampaignStatus.RUNNING, CampaignStatus.PAUSED]) },
      { status: CampaignStatus.CANCELLED, pauseReason: null, completedAt: new Date() },
    );
    const campaign = await this.findOne(sessionId, id);
    if (!updated.affected) throw new BadRequestException(`Campaign is already ${campaign.status}`);
    return campaign;
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const campaign = await this.findOne(sessionId, id);
    if (campaign.status === CampaignStatus.RUNNING) {
      throw new BadRequestException('Pause or cancel the campaign before deleting it');
    }
    const files = await this.attachmentRepository.find({ where: { campaignId: id }, select: { storageKey: true } });
    await this.campaignRepository.delete({ id, sessionId });
    // After the rows are gone: a failed delete leaves a file the boot sweep reclaims, never a row
    // pointing at a missing file.
    for (const { storageKey } of files) {
      await this.storage.deleteFile(storageKey).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Send loop
  // ---------------------------------------------------------------------------------------------

  private launch(id: string): void {
    this.run(id).catch(error => {
      this.logger.error(`Campaign ${id} send loop crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Send pending rows in sheet order until none remain or the campaign stops being RUNNING. Returns
   * the loop already running for this campaign when there is one: a resume issued while the loop is
   * asleep between rows joins it rather than starting a second sender.
   */
  run(id: string): Promise<void> {
    const existing = this.loops.get(id);
    if (existing) return existing;
    const loop = this.sendLoop(id).finally(() => this.loops.delete(id));
    this.loops.set(id, loop);
    return loop;
  }

  /**
   * The status is re-read before every row so a pause or cancel issued from any process — or while
   * this loop was asleep between sends — takes effect at the next row.
   */
  private async sendLoop(id: string): Promise<void> {
    // Files sent to every recipient are read from storage once per loop, not once per row.
    const sharedCache = new Map<string, string>();
    while (!this.shuttingDown) {
      const campaign = await this.campaignRepository.findOne({ where: { id } });
      if (!campaign || campaign.status !== CampaignStatus.RUNNING) return;

      const next = await this.recipientRepository.findOne({
        where: { campaignId: id, status: CampaignRecipientStatus.PENDING },
        order: { rowNumber: 'ASC' },
      });
      if (!next) {
        await this.campaignRepository.update(
          { id, status: CampaignStatus.RUNNING },
          { status: CampaignStatus.COMPLETED, completedAt: new Date() },
        );
        await this.refreshProgress(id);
        this.logger.log(`Campaign ${id} completed`);
        return;
      }

      const outcome = await this.sendRow(campaign, next, sharedCache);
      await this.refreshProgress(id);
      if (outcome === 'pause') return;
      await setTimeout(this.delayFor(campaign));
    }
  }

  private async sendRow(
    campaign: Campaign,
    recipient: CampaignRecipient,
    sharedCache = new Map<string, string>(),
  ): Promise<SendOutcome> {
    if (!this.engines.get(campaign.sessionId)) {
      await this.pauseFor(campaign.id, CampaignPauseReason.SESSION_NOT_READY);
      return 'pause';
    }
    // Claim the row. A row another loop already took (or the operator's edit) is left alone.
    const claimed = await this.recipientRepository.update(
      { id: recipient.id, status: CampaignRecipientStatus.PENDING },
      { status: CampaignRecipientStatus.SENDING },
    );
    if (!claimed.affected) return 'next';

    try {
      const { messageId, responseMessageId } = await this.deliver(campaign, recipient, sharedCache);
      await this.recipientRepository.update(
        { id: recipient.id },
        {
          status: CampaignRecipientStatus.SENT,
          messageId,
          responseMessageId,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      );
      return 'next';
    } catch (error) {
      // Part of the row already reached the recipient: retrying would repeat it, so the row fails
      // with what was sent. If the cause was "not now" (pacing, session) the campaign still pauses.
      if (error instanceof PartialSendError) {
        const cause = sanitizeBatchError(error.cause);
        await this.recipientRepository.update(
          { id: recipient.id },
          {
            status: CampaignRecipientStatus.FAILED,
            errorCode: 'PARTIAL_SEND',
            errorMessage: `${error.message}: ${cause.message}`.slice(0, 1000),
          },
        );
        this.logger.warn(`Campaign ${campaign.id}: row ${recipient.rowNumber} partially sent: ${cause.message}`);
        if (isPacingLimitedError(error.cause)) {
          await this.pauseFor(campaign.id, CampaignPauseReason.PACING_LIMITED);
          return 'pause';
        }
        if (error.cause instanceof EngineNotReadyError || !this.engines.get(campaign.sessionId)) {
          await this.pauseFor(campaign.id, CampaignPauseReason.SESSION_NOT_READY);
          return 'pause';
        }
        return 'next';
      }
      // Refusals that say "not now" rather than "not this row": hand the row back and pause, so the
      // rest of the list is not burned through as failures while the allowance or session is out.
      if (isPacingLimitedError(error)) {
        await this.releaseRow(recipient.id);
        await this.pauseFor(campaign.id, CampaignPauseReason.PACING_LIMITED);
        return 'pause';
      }
      if (error instanceof EngineNotReadyError || !this.engines.get(campaign.sessionId)) {
        await this.releaseRow(recipient.id);
        await this.pauseFor(campaign.id, CampaignPauseReason.SESSION_NOT_READY);
        return 'pause';
      }
      const { code, message } = sanitizeBatchError(error);
      await this.recipientRepository.update(
        { id: recipient.id },
        { status: CampaignRecipientStatus.FAILED, errorCode: code, errorMessage: message.slice(0, 1000) },
      );
      this.logger.warn(`Campaign ${campaign.id}: row ${recipient.rowNumber} failed: ${message}`);
      return 'next';
    }
  }

  /**
   * Send one row: the files for everyone, then the row's own file, with the text as the caption of
   * the first file that can carry one (audio cannot, and WhatsApp caps captions at 1024 characters —
   * otherwise the text goes first as its own message), then the poll when the campaign asks for one.
   * Returns the id of the message carrying the text (or of the first file when there is no text) and
   * of the message recipients answer: the poll, or for numbered replies the message listing them.
   */
  private async deliver(
    campaign: Campaign,
    recipient: CampaignRecipient,
    sharedCache: Map<string, string>,
  ): Promise<{ messageId: string; responseMessageId: string | null }> {
    const chatId = recipient.chatId;
    if (!chatId) throw new BadRequestException('Row has no chat id');
    const text = composeCampaignText(campaign, recipient.variables);
    const maxChars =
      this.configService?.get<number>('template.renderMaxChars', DEFAULT_TEMPLATE_RENDER_MAX_CHARS) ??
      DEFAULT_TEMPLATE_RENDER_MAX_CHARS;
    if (text.length > maxChars) {
      throw new BadRequestException(
        `Rendered message is ${text.length} characters, over the ${maxChars}-character limit`,
      );
    }

    const parts = await this.mediaPartsFor(campaign, recipient);
    const poll =
      campaign.responseStyle === 'poll' && campaign.responseOptions?.length
        ? {
            name: renderTemplate(campaign.responseQuestion ?? '', recipient.variables).slice(
              0,
              RESPONSE_QUESTION_MAX_CHARS,
            ),
            options: campaign.responseOptions,
            allowMultipleAnswers: campaign.responseMultiple,
          }
        : null;
    if (parts.length === 0 && !text && !poll) throw new BadRequestException('Rendered message is empty');

    const captionAt =
      text && text.length <= MEDIA_CAPTION_MAX_CHARS ? parts.findIndex(part => part.type !== 'audio') : -1;
    const textAlone = !!text && captionAt === -1;
    const total = parts.length + (textAlone ? 1 : 0) + (poll ? 1 : 0);
    let sent = 0;
    let primary: string | undefined;
    let textCarrier: string | undefined;
    let pollId: string | undefined;
    try {
      if (textAlone) {
        primary = textCarrier = (await this.messageService.sendText(campaign.sessionId, { chatId, text })).messageId;
        sent++;
      }
      for (const [i, part] of parts.entries()) {
        const caption = i === captionAt ? text : undefined;
        const messageId = await this.sendPart(campaign.sessionId, chatId, part, caption, sharedCache);
        sent++;
        if (caption) primary = textCarrier = messageId;
        else primary ??= messageId;
      }
      if (poll) {
        pollId = (await this.messageService.sendPoll(campaign.sessionId, { chatId, ...poll })).messageId;
        sent++;
      }
    } catch (error) {
      if (sent > 0) throw new PartialSendError(sent, total, error);
      throw error;
    }
    return {
      messageId: primary ?? pollId ?? '',
      responseMessageId: poll ? (pollId ?? null) : campaign.responseStyle === 'reply' ? (textCarrier ?? null) : null,
    };
  }

  private async mediaPartsFor(campaign: Campaign, recipient: CampaignRecipient): Promise<MediaPart[]> {
    const asDocument = campaign.mediaType === 'document';
    const parts: MediaPart[] = (await this.attachmentsOf(campaign.id))
      .filter(a => a.scope === 'all')
      .map(attachment => ({ kind: 'stored', attachment, type: sendTypeForMimetype(attachment.mimetype, asDocument) }));

    if (recipient.attachmentName) {
      const own = await this.attachmentRepository.findOne({
        where: { campaignId: campaign.id, normalizedName: recipient.attachmentName, scope: 'row' },
      });
      // Only possible if the file was removed after the row was queued; never send the row without it.
      if (!own) throw new BadRequestException(missingAttachmentDetail(recipient.attachmentName));
      parts.push({ kind: 'stored', attachment: own, type: sendTypeForMimetype(own.mimetype, asDocument) });
    } else if (campaign.mediaColumn) {
      const cell = (recipient.variables[campaign.mediaColumn] ?? '').trim();
      if (cell && isMediaUrl(cell)) {
        parts.push({ kind: 'url', url: cell, type: asDocument ? 'document' : inferMediaType(cell) });
      }
    }
    return parts;
  }

  private async sendPart(
    sessionId: string,
    chatId: string,
    part: MediaPart,
    caption: string | undefined,
    sharedCache: Map<string, string>,
  ): Promise<string> {
    const source =
      part.kind === 'stored'
        ? {
            base64: await this.readAttachment(part.attachment, sharedCache),
            mimetype: part.attachment.mimetype,
            filename: part.attachment.filename,
          }
        : { url: part.url, filename: filenameFromUrl(part.url) };
    const dto = { chatId, ...source, ...(caption ? { caption } : {}) };
    const result =
      part.type === 'image'
        ? await this.messageService.sendImage(sessionId, dto)
        : part.type === 'video'
          ? await this.messageService.sendVideo(sessionId, dto)
          : part.type === 'audio'
            ? await this.messageService.sendAudio(sessionId, { chatId, ...source })
            : await this.messageService.sendDocument(sessionId, dto);
    if (part.kind === 'stored') await this.dropStoredPayload(sessionId, result.messageId);
    return result.messageId;
  }

  private async readAttachment(attachment: CampaignAttachment, sharedCache: Map<string, string>): Promise<string> {
    const cached = sharedCache.get(attachment.storageKey);
    if (cached) return cached;
    const base64 = (await this.storage.getFile(attachment.storageKey)).toString('base64');
    if (attachment.scope === 'all') {
      const used = [...sharedCache.values()].reduce((sum, v) => sum + v.length, 0);
      if (used + base64.length <= SHARED_ATTACHMENT_CACHE_BYTES) sharedCache.set(attachment.storageKey, base64);
    }
    return base64;
  }

  /**
   * A base64 send persists the whole file inside its `messages` row, so a 5 MB brochure sent to a
   * thousand people would store 5 GB of copies of a file the campaign already keeps once. Swap the
   * payload for the same `{ omitted: true, sizeBytes }` marker the gateway uses for skipped media.
   * Best effort: the message was sent either way.
   */
  private async dropStoredPayload(sessionId: string, waMessageId: string): Promise<void> {
    if (!waMessageId) return;
    try {
      const row = await this.messageRepository.findOne({
        where: { sessionId, waMessageId },
        select: { id: true, metadata: true },
      });
      const metadata = row?.metadata;
      const media = metadata?.media as { data?: unknown } | undefined;
      if (!row || !media || typeof media.data !== 'string' || /^https?:\/\//i.test(media.data)) return;
      const { data, ...rest } = media as { data: string };
      await this.messageRepository.update(
        { id: row.id },
        { metadata: { ...metadata, media: { ...rest, omitted: true, sizeBytes: Buffer.byteLength(data, 'base64') } } },
      );
    } catch (error) {
      this.logger.debug(`Could not drop the stored media copy for ${waMessageId}: ${String(error)}`);
    }
  }

  private async releaseRow(recipientId: string): Promise<void> {
    await this.recipientRepository.update(
      { id: recipientId, status: CampaignRecipientStatus.SENDING },
      { status: CampaignRecipientStatus.PENDING },
    );
  }

  private async pauseFor(id: string, reason: CampaignPauseReason): Promise<void> {
    await this.campaignRepository.update(
      { id, status: CampaignStatus.RUNNING },
      { status: CampaignStatus.PAUSED, pauseReason: reason },
    );
    this.logger.warn(`Campaign ${id} paused: ${reason}`);
  }

  private delayFor(campaign: Pick<Campaign, 'delayMs' | 'randomizeDelay'>): number {
    return campaign.randomizeDelay
      ? campaign.delayMs + Math.floor(Math.random() * campaign.delayMs * 0.5)
      : campaign.delayMs;
  }

  async refreshProgress(id: string): Promise<CampaignProgress> {
    const rows = await this.recipientRepository
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('r.campaignId = :id', { id })
      .groupBy('r.status')
      .getRawMany<{ status: CampaignRecipientStatus; count: string | number }>();
    const progress: CampaignProgress = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const { status, count } of rows) {
      const n = Number(count);
      progress.total += n;
      if (status === CampaignRecipientStatus.SENT) progress.sent += n;
      else if (status === CampaignRecipientStatus.FAILED) progress.failed += n;
      else if (status === CampaignRecipientStatus.SKIPPED) progress.skipped += n;
      else progress.pending += n;
    }
    await this.campaignRepository.update({ id }, { progress });
    return progress;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private async assertSessionExists(sessionId: string): Promise<void> {
    if (!(await this.sessionRepository.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
  }

  private async parseUpload(file: { buffer?: Buffer } | undefined): Promise<ParsedSpreadsheet> {
    if (!file?.buffer) {
      throw new BadRequestException('Attach the spreadsheet as the multipart field `file`');
    }
    return parseSpreadsheet(file.buffer, {
      maxRows: resolveCampaignMaxRows(),
      maxColumns: SPREADSHEET_MAX_COLUMNS,
      maxCellChars: SPREADSHEET_MAX_CELL_CHARS,
    });
  }
}

/** Accept a column by its header as written or by its placeholder key; return the key. */
function resolveColumn(columns: SpreadsheetColumn[], name: string, field: string): string {
  const wanted = name.trim();
  const match =
    columns.find(c => c.key === wanted) ?? columns.find(c => c.header.trim().toLowerCase() === wanted.toLowerCase());
  if (!match) {
    throw new BadRequestException(
      `${field} '${name}' is not a column in the spreadsheet. Columns: ${columns.map(c => c.header).join(', ')}`,
    );
  }
  return match.key;
}

/** The column whose header names a phone, or failing that, whose sample cells mostly read as numbers. */
export function suggestPhoneColumn(sheet: ParsedSpreadsheet): SpreadsheetColumn | undefined {
  const byName = sheet.columns.find(c => /phone|mobile|whats\s*app|contact|number|cell|msisdn/i.test(c.header));
  if (byName) return byName;
  const sample = sheet.rows.slice(0, 20);
  if (sample.length === 0) return undefined;
  return sheet.columns.find(
    c => sample.filter(r => normalizePhoneToChatId(r.values[c.key] ?? '') !== null).length >= sample.length * 0.8,
  );
}

function progressOfPrepared(prepared: { skipReason?: unknown }[]): CampaignProgress {
  const skipped = prepared.filter(r => r.skipReason).length;
  return { total: prepared.length, pending: prepared.length - skipped, sent: 0, failed: 0, skipped };
}
