import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlanService } from './plan.service';
import { CreatePlanDto, UpdatePlanDto, PlanMediaUploadResponseDto, PlanResponseDto } from './dto';
import { Plan } from './entities/plan.entity';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { inboundMediaMaxBytes } from '../../engine';

type UploadedPlanMedia = { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined;

@ApiTags('plans')
@Controller('sessions/:sessionId/plans')
export class PlanController {
  constructor(private readonly planService: PlanService) {}

  @Post()
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'Create a flow plan for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Plan created', type: PlanResponseDto })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: 'A plan with that title already exists for the session' })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreatePlanDto): Promise<Plan> {
    return this.planService.create(sessionId, dto);
  }

  @Get()
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'List all flow plans for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of plans', type: [PlanResponseDto] })
  async findBySession(@Param('sessionId') sessionId: string): Promise<Plan[]> {
    return this.planService.findBySession(sessionId);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'Get a flow plan by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({ status: 200, description: 'Plan details', type: PlanResponseDto })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<Plan> {
    return this.planService.findOne(sessionId, id);
  }

  // PUT rather than PATCH, matching the other session-scoped resources. The dashboard's flow
  // autosave sends `{ flow }` on its own, so every field is optional and an absent key is a no-op.
  @Put(':id')
  @RequireRole(ApiKeyRole.USER)
  @ApiOperation({ summary: 'Update a flow plan' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({ status: 200, description: 'Plan updated', type: PlanResponseDto })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  @ApiResponse({ status: 409, description: 'A plan with that title already exists for the session' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<Plan> {
    return this.planService.update(sessionId, id, dto);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.USER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a flow plan' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({ status: 204, description: 'Plan deleted' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async delete(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<void> {
    return this.planService.delete(sessionId, id);
  }

  @Post(':id/media')
  @RequireRole(ApiKeyRole.USER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: inboundMediaMaxBytes(), files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Any file: image, video, audio, PDF, Office file…',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a media file for a plan block',
    description:
      'One file per request. The stored URL is returned for the dashboard to save into the block, and the ' +
      'file is served back from the authenticated media route below.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({ status: 201, description: 'File stored', type: PlanMediaUploadResponseDto })
  @ApiResponse({ status: 400, description: 'No file, or a file with no usable name' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  @ApiResponse({ status: 413, description: 'File larger than MEDIA_DOWNLOAD_MAX_BYTES' })
  saveMedia(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @UploadedFile() file: UploadedPlanMedia,
  ): Promise<PlanMediaUploadResponseDto> {
    return this.planService.saveMedia(sessionId, id, file);
  }

  @Get(':id/media/:mediaId')
  @RequireRole(ApiKeyRole.USER)
  @ApiProduces('application/octet-stream')
  @ApiOperation({ summary: 'Download a media file uploaded to a plan' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiParam({ name: 'mediaId', description: 'Stored file name returned by the upload' })
  @ApiResponse({ status: 200, description: 'The stored file', schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 404, description: 'Plan or media not found' })
  async getMedia(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ): Promise<StreamableFile> {
    const { buffer, mimetype, filename } = await this.planService.getMedia(sessionId, id, mediaId);
    return new StreamableFile(buffer, {
      type: mimetype,
      disposition: `attachment; filename="${filename}"`,
      length: buffer.length,
    });
  }
}
