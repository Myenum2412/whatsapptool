import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CampaignService, resolveCampaignUploadMaxBytes } from './campaign.service';
import {
  CampaignAttachmentUploadResponseDto,
  CampaignDetailResponseDto,
  CampaignRecipientPageDto,
  CampaignResponseDto,
  CreateCampaignDto,
  ListRecipientsQueryDto,
  SpreadsheetInspectResponseDto,
  UploadCampaignAttachmentDto,
  CAMPAIGN_ATTACHMENT_SCOPES,
  CAMPAIGN_MEDIA_TYPES,
} from './dto/campaign.dto';
import { Campaign } from './entities/campaign.entity';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { inboundMediaMaxBytes } from '../../engine';

type UploadedSpreadsheet = { buffer?: Buffer; originalname?: string } | undefined;

const SPREADSHEET_FILE_SCHEMA = {
  type: 'string',
  format: 'binary',
  description: 'The recipient list: .xlsx or .csv, first row is the header',
};

@ApiTags('campaigns')
@Controller('sessions/:sessionId/campaigns')
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post('inspect')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: resolveCampaignUploadMaxBytes() } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: { type: 'object', required: ['file'], properties: { file: SPREADSHEET_FILE_SCHEMA } },
  })
  @ApiOperation({ summary: 'Read a spreadsheet’s columns and first rows without creating a campaign' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Columns, row count and sample rows', type: SpreadsheetInspectResponseDto })
  @ApiResponse({ status: 400, description: 'Unreadable or oversized spreadsheet' })
  inspect(
    @Param('sessionId') sessionId: string,
    @UploadedFile() file: UploadedSpreadsheet,
  ): Promise<SpreadsheetInspectResponseDto> {
    return this.campaignService.inspect(sessionId, file);
  }

  @Post()
  @RequireRole(ApiKeyRole.USER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: resolveCampaignUploadMaxBytes() } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file', 'name', 'phoneColumn'],
      properties: {
        file: SPREADSHEET_FILE_SCHEMA,
        name: { type: 'string', example: 'September renewals' },
        templateId: { type: 'string', description: 'Stored template to use. Provide either templateId or body.' },
        body: { type: 'string', example: 'Hi {{Name}}, your plan {{Plan}} renews on {{Renewal_Date}}.' },
        phoneColumn: { type: 'string', example: 'Phone' },
        mediaColumn: {
          type: 'string',
          example: 'Invoice_File',
          description: 'Column naming each row’s own attachment: an uploaded filename or an http(s) link',
        },
        mediaType: { type: 'string', enum: [...CAMPAIGN_MEDIA_TYPES], default: 'auto' },
        defaultCountryCode: { type: 'string', example: '91' },
        delayMs: { type: 'integer', default: 5000, minimum: 1000, maximum: 600000 },
        randomizeDelay: { type: 'boolean', default: true },
        skipRowsWithMissingValues: { type: 'boolean', default: true },
      },
    },
  })
  @ApiOperation({
    summary: 'Create a mail-merge campaign (draft) from a spreadsheet and a template',
    description:
      'Every row is validated up front: invalid or duplicate numbers, empty values the message needs, and ' +
      'non-http(s) media cells are skipped with a reason. Nothing is sent until the campaign is started.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Draft campaign with preview', type: CampaignDetailResponseDto })
  @ApiResponse({ status: 400, description: 'Unreadable spreadsheet, unknown column or placeholder' })
  @ApiResponse({ status: 404, description: 'Session or template not found' })
  create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateCampaignDto,
    @UploadedFile() file: UploadedSpreadsheet,
  ): Promise<CampaignDetailResponseDto> {
    return this.campaignService.create(sessionId, dto, file);
  }

  @Get()
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'List the session’s campaigns, newest first' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Campaigns', type: [CampaignResponseDto] })
  list(@Param('sessionId') sessionId: string): Promise<Campaign[]> {
    return this.campaignService.list(sessionId);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'Get a campaign with progress, skip reasons and a preview of the next rows' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'Campaign', type: CampaignDetailResponseDto })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  get(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<CampaignDetailResponseDto> {
    return this.campaignService.getDetail(sessionId, id);
  }

  @Get(':id/recipients')
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'Page through a campaign’s rows and their outcomes' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'Recipient rows', type: CampaignRecipientPageDto })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  recipients(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Query() query: ListRecipientsQueryDto,
  ): Promise<CampaignRecipientPageDto> {
    return this.campaignService.listRecipients(sessionId, id, query);
  }

  @Get(':id/export')
  @RequireRole(ApiKeyRole.USER)
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Download every row with its outcome as CSV' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'CSV report', schema: { type: 'string' } })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  async export(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<StreamableFile> {
    const { filename, csv } = await this.campaignService.exportResults(sessionId, id);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post(':id/attachments')
  @RequireRole(ApiKeyRole.USER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: inboundMediaMaxBytes(), files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file', 'scope'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Any file: image, video, audio, PDF, Office file…' },
        scope: {
          type: 'string',
          enum: [...CAMPAIGN_ATTACHMENT_SCOPES],
          description:
            '`all`: send to every recipient. `row`: send to the rows whose attachment column names this file.',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload one attachment to a draft campaign',
    description:
      'One file per request. A `row` file releases the rows whose attachment column names it (matched on the ' +
      'filename, case-insensitively) from MISSING_ATTACHMENT. The file is stored once and sent from storage.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 201, description: 'Attachment stored', type: CampaignAttachmentUploadResponseDto })
  @ApiResponse({ status: 400, description: 'Campaign is not a draft, no file, or a per-row file without a column' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  @ApiResponse({ status: 409, description: 'A file with that name is already attached' })
  @ApiResponse({ status: 413, description: 'File larger than MEDIA_DOWNLOAD_MAX_BYTES' })
  addAttachment(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UploadCampaignAttachmentDto,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
  ): Promise<CampaignAttachmentUploadResponseDto> {
    return this.campaignService.addAttachment(sessionId, id, dto.scope, file);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an attachment from a draft campaign' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 204, description: 'Attachment removed' })
  @ApiResponse({ status: 400, description: 'Campaign is not a draft' })
  @ApiResponse({ status: 404, description: 'Campaign or attachment not found' })
  removeAttachment(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    return this.campaignService.removeAttachment(sessionId, id, attachmentId);
  }

  @Post(':id/start')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a draft campaign, or resume a paused one' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'Campaign running', type: CampaignResponseDto })
  @ApiResponse({ status: 400, description: 'Campaign is not a draft or paused' })
  @ApiResponse({ status: 409, description: 'Session is not connected' })
  start(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<Campaign> {
    return this.campaignService.start(sessionId, id);
  }

  @Post(':id/pause')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a running campaign after the row in flight' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'Campaign paused', type: CampaignResponseDto })
  @ApiResponse({ status: 400, description: 'Campaign is not running' })
  pause(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<Campaign> {
    return this.campaignService.pause(sessionId, id);
  }

  @Post(':id/cancel')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a campaign; rows not yet sent stay pending and are never sent' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, description: 'Campaign cancelled', type: CampaignResponseDto })
  @ApiResponse({ status: 400, description: 'Campaign already finished' })
  cancel(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<Campaign> {
    return this.campaignService.cancel(sessionId, id);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a campaign and its rows (not while running)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 204, description: 'Campaign deleted' })
  @ApiResponse({ status: 400, description: 'Campaign is running' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  delete(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<void> {
    return this.campaignService.delete(sessionId, id);
  }
}
