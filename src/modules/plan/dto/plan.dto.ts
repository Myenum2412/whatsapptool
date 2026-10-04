import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { IsFlowBlocks } from '../flow/flow-block-validator';
import { IsMindMap } from '../flow/mind-map-validator';
import {
  FLOW_BLOCK_TYPES,
  FLOW_LIMITS,
  PLAN_DESCRIPTION_MAX_LENGTH,
  PLAN_TITLE_MAX_LENGTH,
  PlanFlowBlock,
} from '../flow/flow-block-types';
import type { PlanMindMap } from '../flow/mind-map-types';

/**
 * `flow` is stored as ONE array of a discriminated union, and that union is validated by
 * `IsFlowBlocks` rather than by nested DTO classes.
 *
 * `@Type(() => Object)` is load-bearing, not decoration. The global ValidationPipe runs with
 * `enableImplicitConversion`, and without this annotation class-transformer tries to build each
 * element from the declared type: it cannot choose one class out of the multi-member union, so every
 * block silently became `{}` on the way in - the request validated, then persisted an empty flow.
 * This annotation tells the transformer to pass the block objects through untouched; the constraint
 * is what decides whether they are acceptable.
 */

/* ---- Flow block schemas (documentation shapes; runtime validation lives in flow-block-validator) ---- */

export class TextFlowBlockDto {
  @ApiProperty({ example: 'block-1' })
  id!: string;

  @ApiProperty({ enum: FLOW_BLOCK_TYPES, example: 'text' })
  type!: 'text';

  @ApiProperty({
    description: 'Message body. May be blank while the operator is still typing.',
    maxLength: FLOW_LIMITS.text,
  })
  text!: string;
}

export class MediaFlowBlockDto {
  @ApiProperty({ example: 'block-2' })
  id!: string;

  @ApiProperty({ enum: FLOW_BLOCK_TYPES, example: 'image' })
  type!: 'image' | 'video';

  @ApiProperty({ description: 'Media link.', maxLength: FLOW_LIMITS.mediaUrl })
  mediaUrl!: string;

  @ApiPropertyOptional({ description: 'Optional caption.', maxLength: FLOW_LIMITS.caption })
  caption!: string;
}

export class FileFlowBlockDto {
  @ApiProperty({ example: 'block-5' })
  id!: string;

  @ApiProperty({ enum: FLOW_BLOCK_TYPES, example: 'file' })
  type!: 'file';

  @ApiProperty({ description: 'Document link.', maxLength: FLOW_LIMITS.mediaUrl })
  mediaUrl!: string;

  @ApiProperty({ description: 'Name shown with the document.', maxLength: FLOW_LIMITS.filename })
  filename!: string;

  @ApiPropertyOptional({ description: 'Optional caption.', maxLength: FLOW_LIMITS.caption })
  caption!: string;
}

export class PollFlowBlockDto {
  @ApiProperty({ example: 'block-3' })
  id!: string;

  @ApiProperty({ enum: FLOW_BLOCK_TYPES, example: 'poll' })
  type!: 'poll';

  @ApiProperty({ maxLength: FLOW_LIMITS.question })
  question!: string;

  @ApiProperty({ type: [String], description: 'Poll options. Blank entries are allowed mid-edit.' })
  options!: string[];
}

export class YesNoFlowBlockDto {
  @ApiProperty({ example: 'block-4' })
  id!: string;

  @ApiProperty({ enum: FLOW_BLOCK_TYPES, example: 'yesno' })
  type!: 'yesno';

  @ApiProperty({ maxLength: FLOW_LIMITS.question })
  question!: string;

  @ApiProperty({ description: 'Label of the affirmative quick reply.', maxLength: FLOW_LIMITS.label })
  yesLabel!: string;

  @ApiProperty({ description: 'Label of the negative quick reply.', maxLength: FLOW_LIMITS.label })
  noLabel!: string;
}

export class FlowBlockDto {
  @ApiProperty({
    oneOf: [
      { $ref: '#/components/schemas/TextFlowBlockDto' },
      { $ref: '#/components/schemas/MediaFlowBlockDto' },
      { $ref: '#/components/schemas/FileFlowBlockDto' },
      { $ref: '#/components/schemas/PollFlowBlockDto' },
      { $ref: '#/components/schemas/YesNoFlowBlockDto' },
    ],
    description: 'A discriminated union on `type`.',
  })
  block!: TextFlowBlockDto | MediaFlowBlockDto | FileFlowBlockDto | PollFlowBlockDto | YesNoFlowBlockDto;
}

/* ---- Mind-map layout (documentation shapes; runtime validation lives in mind-map-validator) ---- */

export class MindMapPositionDto {
  @ApiProperty({ description: 'Node x, in canvas pixels.', example: 40 })
  x!: number;

  @ApiProperty({ description: 'Node y, in canvas pixels.', example: 80 })
  y!: number;
}

export class MindMapEdgeDto {
  @ApiProperty({ example: 'edge-1' })
  id!: string;

  @ApiProperty({ description: 'Source block id.', example: 'block-1' })
  from!: string;

  @ApiProperty({ description: 'Target block id.', example: 'block-2' })
  to!: string;
}

export class MindMapDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/MindMapPositionDto' },
    description: 'Node positions keyed by block id. Blocks without an entry are auto-laid-out.',
    example: { 'block-1': { x: 40, y: 80 } },
  })
  positions!: Record<string, MindMapPositionDto>;

  @ApiProperty({ type: [MindMapEdgeDto], description: 'Drawn connections between blocks.' })
  edges!: MindMapEdgeDto[];
}

/* ---- Plan payloads ---- */

export class CreatePlanDto {
  @ApiProperty({
    description: 'Plan title, unique within the session',
    example: 'Welcome flow',
    maxLength: PLAN_TITLE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAN_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({ description: 'Optional description', maxLength: PLAN_DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_DESCRIPTION_MAX_LENGTH)
  description?: string;

  // Optional so the title/description form can create a plan on its own; the flow is built after.
  @ApiPropertyOptional({
    type: FlowBlockDto,
    isArray: true,
    description: 'Ordered message flow. Defaults to an empty flow.',
  })
  @IsOptional()
  @Type(() => Object)
  @IsFlowBlocks()
  flow?: PlanFlowBlock[];

  // Optional and parallel to `flow`: creating a plan never requires a layout.
  @ApiPropertyOptional({
    type: MindMapDto,
    description: 'Mind-map layout over the flow. Defaults to an empty layout.',
  })
  @IsOptional()
  @Type(() => Object)
  @IsMindMap()
  mindmap?: PlanMindMap;
}

export class UpdatePlanDto {
  @ApiPropertyOptional({ description: 'Plan title', maxLength: PLAN_TITLE_MAX_LENGTH })
  // Not @IsOptional: that also skips null, which then reaches the NOT NULL column as a 500.
  @ValidateIf((o: UpdatePlanDto) => o.title !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAN_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({ description: 'Plan description', maxLength: PLAN_DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_DESCRIPTION_MAX_LENGTH)
  description?: string;

  // The dashboard's flow autosave sends only this field, leaving title/description untouched.
  @ApiPropertyOptional({ type: FlowBlockDto, isArray: true, description: 'Replaces the whole flow.' })
  @ValidateIf((o: UpdatePlanDto) => o.flow !== undefined)
  @Type(() => Object)
  @IsFlowBlocks()
  flow?: PlanFlowBlock[];

  // The map autosave sends `{ mindmap }` alone, so an absent key must remain a no-op.
  @ApiPropertyOptional({ type: MindMapDto, description: 'Replaces the mind-map layout.' })
  @ValidateIf((o: UpdatePlanDto) => o.mindmap !== undefined)
  @Type(() => Object)
  @IsMindMap()
  mindmap?: PlanMindMap;
}

export class PlanResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null;

  @ApiProperty({ type: FlowBlockDto, isArray: true })
  flow!: PlanFlowBlock[];

  @ApiProperty({ type: MindMapDto })
  mindmap!: PlanMindMap;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PlanMediaUploadResponseDto {
  @ApiProperty({
    description: 'API-relative URL to store on the block.',
    example: '/sessions/s1/plans/p1/media/uuid.png',
  })
  url!: string;

  @ApiProperty({ description: 'Original file name, for documents.' })
  filename!: string;

  @ApiProperty({ description: 'Resolved MIME type.' })
  mimetype!: string;

  @ApiProperty({ description: 'Stored size in bytes.' })
  sizeBytes!: number;
}
