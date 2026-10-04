import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './entities/plan.entity';
import { Session } from '../session/entities/session.entity';
import { CreatePlanDto, UpdatePlanDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { resolveMimetype } from '../../common/media/media-mimetype';
import { StorageService, isMissingObjectError } from '../../common/storage/storage.service';
import { emptyMindMap } from './flow/mind-map-types';
import {
  assertPlanMediaId,
  decodePlanMediaFilename,
  PLAN_MEDIA_PREFIX,
  planMediaKey,
  planMediaStoredName,
  planMediaUrl,
  storedMediaMimetype,
  UploadedPlanMedia,
  PlanMediaUploadResult,
  StoredPlanMedia,
} from './plan-media';

@Injectable()
export class PlanService {
  private readonly logger = createLogger('PlanService');

  constructor(
    @InjectRepository(Plan, 'data')
    private readonly planRepository: Repository<Plan>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly storage: StorageService,
  ) {}

  async create(sessionId: string, dto: CreatePlanDto): Promise<Plan> {
    // The plans.sessionId FK turns a missing session into a driver error (500) at save time; check
    // first so the caller gets a truthful 404.
    if (!(await this.sessionRepository.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
    const plan = this.planRepository.create({
      sessionId,
      title: dto.title,
      description: dto.description ?? null,
      flow: dto.flow ?? [],
      mindmap: dto.mindmap ?? emptyMindMap(),
    });

    try {
      const saved = await this.planRepository.save(plan);
      this.logger.log('Plan created', { sessionId, planId: saved.id, title: saved.title });
      return saved;
    } catch (err) {
      throw this.rethrowConflict(err, dto.title);
    }
  }

  async findBySession(sessionId: string): Promise<Plan[]> {
    return this.planRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(sessionId: string, id: string): Promise<Plan> {
    // Scoped by sessionId as well as id: a plan belonging to another session must read as absent,
    // not as a row the caller may reach by guessing its id.
    const plan = await this.planRepository.findOne({ where: { id, sessionId } });
    if (!plan) {
      throw new NotFoundException(`Plan with id '${id}' not found`);
    }
    return plan;
  }

  async update(sessionId: string, id: string, dto: UpdatePlanDto): Promise<Plan> {
    const plan = await this.findOne(sessionId, id);

    // Assigned field-by-field rather than merged, so an absent key never clears a column: the flow
    // autosave sends `{ flow }` alone and must not wipe the title.
    if (dto.title !== undefined) plan.title = dto.title;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.flow !== undefined) plan.flow = dto.flow;
    if (dto.mindmap !== undefined) plan.mindmap = dto.mindmap;

    try {
      const saved = await this.planRepository.save(plan);
      this.logger.log('Plan updated', { sessionId, planId: id, fields: Object.keys(dto).join(',') });
      return saved;
    } catch (err) {
      throw this.rethrowConflict(err, plan.title);
    }
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const plan = await this.findOne(sessionId, id);
    await this.planRepository.remove(plan);
    await this.sweepMedia(sessionId, id);
    this.logger.log('Plan deleted', { sessionId, planId: id });
  }

  /**
   * Store one uploaded file for a plan and hand back the block-ready descriptor. The plan is checked
   * first so an upload naming an unknown/foreign plan is a 404 rather than bytes written to the
   * store for a plan that will never reference them.
   */
  async saveMedia(sessionId: string, id: string, file: UploadedPlanMedia | undefined): Promise<PlanMediaUploadResult> {
    await this.findOne(sessionId, id);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Attach the file as the multipart field `file`');
    }
    const filename = decodePlanMediaFilename(file.originalname);
    if (!filename) throw new BadRequestException('The uploaded file has no usable name');

    const storedName = planMediaStoredName(filename);
    await this.storage.putFile(planMediaKey(sessionId, id, storedName), file.buffer);
    this.logger.log('Plan media stored', { sessionId, planId: id, filename, sizeBytes: file.buffer.length });
    return {
      url: planMediaUrl(sessionId, id, storedName),
      filename,
      mimetype: resolveMimetype(filename, file.mimetype),
      sizeBytes: file.buffer.length,
    };
  }

  /** Read one stored plan file back, scoped to the plan so a foreign media id cannot be fetched. */
  async getMedia(sessionId: string, id: string, mediaId: string): Promise<StoredPlanMedia> {
    await this.findOne(sessionId, id);
    assertPlanMediaId(mediaId);
    try {
      const buffer = await this.storage.getFile(planMediaKey(sessionId, id, mediaId));
      return { buffer, mimetype: storedMediaMimetype(mediaId), filename: mediaId };
    } catch (err) {
      if (isMissingObjectError(err)) {
        throw new NotFoundException(`Media '${mediaId}' not found`);
      }
      throw err;
    }
  }

  /**
   * Best-effort sweep of a deleted plan's uploads. The row is already gone, so a storage failure
   * must not turn the delete into a 500; it is logged for an operator to reconcile.
   */
  private async sweepMedia(sessionId: string, id: string): Promise<void> {
    const prefix = `${PLAN_MEDIA_PREFIX}${sessionId}/${id}/`;
    try {
      const keys: string[] = [];
      for await (const key of this.storage.iterateFiles(prefix)) keys.push(key);
      for (const key of keys) {
        await this.storage.deleteFile(key).catch(error => {
          this.logger.warn('Failed to delete plan media', { key, error: String(error) });
        });
      }
    } catch (error) {
      this.logger.warn('Failed to enumerate plan media for deletion', { sessionId, planId: id, error: String(error) });
    }
  }

  /** The unique (sessionId, title) index makes a duplicate a 409, not a second row. */
  private rethrowConflict(err: unknown, title: string): unknown {
    if (isUniqueViolation(err)) {
      return new ConflictException(`A plan titled '${title}' already exists for this session`);
    }
    return err;
  }
}
