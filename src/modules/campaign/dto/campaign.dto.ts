import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  IsBoolean,
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateIf,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import { CampaignStatus, CampaignPauseReason } from '../entities/campaign.entity';
import { CampaignRecipientStatus } from '../entities/campaign-recipient.entity';

export const CAMPAIGN_MEDIA_TYPES = ['auto', 'document'] as const;
export const CAMPAIGN_ATTACHMENT_SCOPES = ['all', 'row'] as const;
export const CAMPAIGN_RESPONSE_STYLES = ['poll', 'reply'] as const;

/**
 * Response options arrive as a JSON array in one multipart field (`["Yes","No"]`) or as the field
 * repeated once per option; a JSON body sends a plain array. All three become a string array.
 */
const toOptionList = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return trimmed ? [trimmed] : [];
};
export const CAMPAIGN_DELAY_MIN_MS = 1000;
export const CAMPAIGN_DELAY_MAX_MS = 600_000;
export const CAMPAIGN_DELAY_DEFAULT_MS = 5000;

/**
 * Multipart fields sent alongside the spreadsheet `file`. Every value arrives as a string; numbers
 * are converted by the global pipe's implicit conversion and booleans by ToStrictBoolean (implicit
 * conversion would read the string "false" as true).
 */
export class CreateCampaignDto {
  @ApiProperty({ description: 'Campaign name', example: 'September renewals', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Stored template to render for each row. Provide either templateId or body.',
    example: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
  })
  @ValidateIf((o: CreateCampaignDto) => !o.body)
  @IsString()
  @IsNotEmpty()
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Inline message text with {{placeholders}}. Provide either templateId or body.',
    example: 'Hi {{Name}}, your plan {{Plan}} renews on {{Renewal_Date}}.',
    maxLength: 4096,
  })
  @ValidateIf((o: CreateCampaignDto) => !o.templateId)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  body?: string;

  @ApiProperty({
    description: 'Column holding each row’s phone number (header text or placeholder key)',
    example: 'Phone',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  phoneColumn!: string;

  @ApiPropertyOptional({
    description:
      'Optional column naming each row’s own attachment: the filename of a file uploaded to the campaign ' +
      '(POST …/attachments with scope=row), or an http(s) link. Empty cells get no per-row attachment.',
    example: 'Invoice_File',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  mediaColumn?: string;

  @ApiPropertyOptional({
    description:
      'How attachments are sent. `auto`: photos, videos and audio play inline and anything else is a document. ' +
      '`document`: everything is sent as a document (keeps photos and videos at full quality).',
    enum: CAMPAIGN_MEDIA_TYPES,
    default: 'auto',
  })
  @IsOptional()
  @IsIn(CAMPAIGN_MEDIA_TYPES)
  mediaType?: (typeof CAMPAIGN_MEDIA_TYPES)[number];

  @ApiPropertyOptional({
    enum: CAMPAIGN_RESPONSE_STYLES,
    description:
      'Ask recipients to answer: `poll` sends a WhatsApp poll after the message (tap to answer, 2-12 options); ' +
      '`reply` lists the options numbered under the message (reply with the number or the text, 2-20 options). ' +
      'Defaults to `poll` when responseOptions are given.',
  })
  @IsOptional()
  @IsIn(CAMPAIGN_RESPONSE_STYLES)
  responseStyle?: (typeof CAMPAIGN_RESPONSE_STYLES)[number];

  @ApiPropertyOptional({
    description:
      'Poll question (required for a poll), or the line above the numbered options. May use {{placeholders}}.',
    example: 'Are you interested in the {{Plan}} upgrade?',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  responseQuestion?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'The answer choices, in order. In multipart, send a JSON array or repeat the field.',
    example: ['Interested', 'Not interested'],
  })
  @IsOptional()
  @Transform(toOptionList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  responseOptions?: string[];

  @ApiPropertyOptional({ description: 'Let a recipient pick more than one option', default: false })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  responseMultiple?: boolean;

  @ApiPropertyOptional({
    description:
      'Country code prepended to numbers written without one (no leading + or 00, at most 10 digits after a trunk 0 is dropped).',
    example: '91',
  })
  @IsOptional()
  @Matches(/^\+?[0-9]{1,4}$/, { message: 'defaultCountryCode must be 1-4 digits, optionally prefixed with +' })
  defaultCountryCode?: string;

  @ApiPropertyOptional({
    description: 'Pause between recipients in ms',
    default: CAMPAIGN_DELAY_DEFAULT_MS,
    minimum: CAMPAIGN_DELAY_MIN_MS,
    maximum: CAMPAIGN_DELAY_MAX_MS,
  })
  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_DELAY_MIN_MS)
  @Max(CAMPAIGN_DELAY_MAX_MS)
  delayMs?: number;

  @ApiPropertyOptional({ description: 'Add a random 0-50% on top of each delay', default: true })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  randomizeDelay?: boolean;

  @ApiPropertyOptional({
    description: 'Skip rows where a column the message uses is empty (otherwise the placeholder renders as blank)',
    default: true,
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  skipRowsWithMissingValues?: boolean;
}

export class ListRecipientsQueryDto {
  @ApiPropertyOptional({ enum: CampaignRecipientStatus })
  @IsOptional()
  @IsIn(Object.values(CampaignRecipientStatus))
  status?: CampaignRecipientStatus;

  @ApiPropertyOptional({ description: 'Only rows whose answer includes this option', example: 'Interested' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  response?: string;

  @ApiPropertyOptional({
    enum: ['yes', 'no'],
    description: '`yes`: rows that answered. `no`: sent rows still without an answer.',
  })
  @IsOptional()
  @IsIn(['yes', 'no'])
  responded?: 'yes' | 'no';

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class SpreadsheetColumnDto {
  @ApiProperty({ example: 'First Name' })
  header!: string;

  @ApiProperty({ description: 'Placeholder key: use as {{key}} in the message', example: 'First_Name' })
  key!: string;
}

export class SpreadsheetInspectResponseDto {
  @ApiProperty({ type: [SpreadsheetColumnDto] })
  columns!: SpreadsheetColumnDto[];

  @ApiProperty({ example: 1250 })
  rowCount!: number;

  @ApiProperty({
    description: 'First few data rows, keyed by placeholder key',
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'string' } },
  })
  sampleRows!: Record<string, string>[];

  @ApiPropertyOptional({ description: 'Column that looks like it holds phone numbers', example: 'Phone' })
  suggestedPhoneColumn?: string;
}

export class CampaignProgressDto {
  @ApiProperty() total!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() skipped!: number;
}

export class CampaignPreviewDto {
  @ApiProperty({ example: 2 })
  rowNumber!: number;

  @ApiProperty({ example: '919876543210@c.us' })
  chatId!: string;

  @ApiProperty({ example: 'Hi Asha, your plan Gold renews on 2026-10-01.' })
  text!: string;

  @ApiProperty({
    type: [String],
    description: 'Filenames (or links) this row will receive, in send order',
    example: ['brochure.pdf', 'INV-1001.pdf'],
  })
  attachments!: string[];

  @ApiPropertyOptional({
    description: 'The poll this row receives after the message (poll-style campaigns)',
    example: { question: 'Interested, Asha?', options: ['Interested', 'Not interested'] },
  })
  poll?: { question: string; options: string[] };
}

export class UploadCampaignAttachmentDto {
  @ApiProperty({
    enum: CAMPAIGN_ATTACHMENT_SCOPES,
    description: '`all`: sent to every recipient. `row`: sent to the rows whose attachment column names this file.',
  })
  @IsIn(CAMPAIGN_ATTACHMENT_SCOPES)
  scope!: (typeof CAMPAIGN_ATTACHMENT_SCOPES)[number];
}

export class CampaignAttachmentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: CAMPAIGN_ATTACHMENT_SCOPES }) scope!: string;
  @ApiProperty({ example: 'INV-1001.pdf' }) filename!: string;
  @ApiProperty({ example: 'application/pdf' }) mimetype!: string;
  @ApiProperty({ example: 184320 }) sizeBytes!: number;
  @ApiProperty({ enum: ['image', 'video', 'audio', 'document'], description: 'How it will be sent' }) sendAs!: string;
  @ApiProperty() createdAt!: Date;
}

export class CampaignAttachmentUploadResponseDto {
  @ApiProperty({ type: CampaignAttachmentDto }) attachment!: CampaignAttachmentDto;
  @ApiProperty({ description: 'Rows that were waiting for this file and are now ready to send', example: 1 })
  rowsMatched!: number;
}

export class CampaignResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CampaignStatus }) status!: CampaignStatus;
  @ApiPropertyOptional({ enum: CampaignPauseReason, nullable: true }) pauseReason!: CampaignPauseReason | null;
  @ApiPropertyOptional({ type: String, nullable: true }) templateId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) header!: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) footer!: string | null;
  @ApiProperty({ type: [SpreadsheetColumnDto] }) columns!: SpreadsheetColumnDto[];
  @ApiProperty() phoneColumn!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) mediaColumn!: string | null;
  @ApiProperty({ enum: CAMPAIGN_MEDIA_TYPES }) mediaType!: string;
  @ApiProperty() delayMs!: number;
  @ApiProperty() randomizeDelay!: boolean;
  @ApiProperty({ type: CampaignProgressDto }) progress!: CampaignProgressDto;
  @ApiPropertyOptional({ type: String, nullable: true }) sourceFilename!: string | null;
  @ApiPropertyOptional({ enum: CAMPAIGN_RESPONSE_STYLES, nullable: true }) responseStyle!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) responseQuestion!: string | null;
  @ApiPropertyOptional({ type: [String], nullable: true }) responseOptions!: string[] | null;
  @ApiProperty() responseMultiple!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) startedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) completedAt!: Date | null;
}

export class CampaignResponseCountDto {
  @ApiProperty({ example: 'Interested' }) option!: string;
  @ApiProperty({ example: 312 }) count!: number;
}

export class CampaignResponseSummaryDto {
  @ApiProperty({ type: [CampaignResponseCountDto], description: 'Answers per option, in option order' })
  options!: CampaignResponseCountDto[];
  @ApiProperty({ description: 'Sent rows that answered', example: 401 }) responded!: number;
  @ApiProperty({ description: 'Sent rows with no answer yet', example: 599 }) awaiting!: number;
}

export class CampaignDetailResponseDto extends CampaignResponseDto {
  @ApiPropertyOptional({ type: CampaignResponseSummaryDto, nullable: true })
  responseSummary!: CampaignResponseSummaryDto | null;

  @ApiProperty({
    description: 'Rows skipped before sending, by reason',
    example: { INVALID_PHONE: 3, DUPLICATE_PHONE: 1 },
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  skippedByReason!: Record<string, number>;

  @ApiProperty({ type: [CampaignPreviewDto], description: 'Rendered messages for the first few sendable rows' })
  preview!: CampaignPreviewDto[];

  @ApiProperty({ type: [CampaignAttachmentDto] })
  attachments!: CampaignAttachmentDto[];

  @ApiProperty({
    type: [String],
    description: 'Filenames rows name in the attachment column that have not been uploaded yet (first 50)',
    example: ['INV-1007.pdf'],
  })
  missingAttachments!: string[];
}

export class CampaignRecipientDto {
  @ApiProperty() id!: string;
  @ApiProperty() rowNumber!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) chatId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) attachmentName!: string | null;
  @ApiProperty({ enum: CampaignRecipientStatus }) status!: CampaignRecipientStatus;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) variables!: Record<string, string>;
  @ApiPropertyOptional({ type: String, nullable: true }) errorCode!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) errorMessage!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) messageId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) responseMessageId!: string | null;
  @ApiPropertyOptional({ type: [String], nullable: true, description: 'The chosen option(s)' })
  response!: string[] | null;
  @ApiPropertyOptional({ enum: ['poll', 'reply'], nullable: true }) responseVia!: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) respondedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) sentAt!: Date | null;
}

export class CampaignRecipientPageDto {
  @ApiProperty({ type: [CampaignRecipientDto] }) items!: CampaignRecipientDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
