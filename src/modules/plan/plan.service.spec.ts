import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PlanService } from './plan.service';
import { Plan } from './entities/plan.entity';
import { Session } from '../session/entities/session.entity';
import { StorageService } from '../../common/storage/storage.service';
import { PlanFlowBlock } from './flow/flow-block-types';
import { PlanMindMap } from './flow/mind-map-types';

function createMockPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-uuid-1',
    sessionId: 'sess-1',
    title: 'Welcome flow',
    description: null,
    flow: [],
    mindmap: { positions: {}, edges: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

const TEXT_BLOCK: PlanFlowBlock = { id: 'b1', type: 'text', text: 'Hi there' };
const LAYOUT: PlanMindMap = { positions: { b1: { x: 0, y: 0 } }, edges: [] };

/**
 * Typed as loose `jest.Mock`s rather than `jest.Mocked<Partial<Repository<Plan>>>`: the partial form
 * leaves the members `Partial`, so reaching one through a non-null assertion produces an
 * unresolvable call and trips `no-unsafe-call`.
 */
interface PlanRepositoryMock {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
}

describe('PlanService', () => {
  let service: PlanService;
  let repository: PlanRepositoryMock;
  let sessionRepository: { exists: jest.Mock };
  let storage: {
    putFile: jest.Mock;
    getFile: jest.Mock;
    deleteFile: jest.Mock;
    iterateFiles: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data: Partial<Plan>) => ({ id: 'plan-uuid-1', ...data }) as Plan),
      save: jest.fn().mockImplementation((plan: Plan) => Promise.resolve(plan)),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    sessionRepository = { exists: jest.fn().mockResolvedValue(true) };

    storage = {
      putFile: jest.fn().mockResolvedValue(undefined),
      getFile: jest.fn(),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      iterateFiles: jest.fn().mockImplementation(async function* () {
        // No stored files by default.
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanService,
        { provide: getRepositoryToken(Plan, 'data'), useValue: repository },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get<PlanService>(PlanService);
  });

  describe('create', () => {
    it('rejects a session that does not exist with 404 before touching the plans table', async () => {
      sessionRepository.exists.mockResolvedValue(false);

      await expect(service.create('ghost', { title: 'x' })).rejects.toThrow(
        new NotFoundException("Session with id 'ghost' not found"),
      );
      expect(sessionRepository.exists).toHaveBeenCalledWith({ where: { id: 'ghost' } });
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('creates a title-only plan with a null description and empty flow/mindmap', async () => {
      await service.create('sess-1', { title: 'Welcome flow' });

      expect(repository.create).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        title: 'Welcome flow',
        description: null,
        flow: [],
        mindmap: { positions: {}, edges: [] },
      });
      expect(repository.save).toHaveBeenCalled();
    });

    it('persists a supplied description, flow and mindmap layout', async () => {
      await service.create('sess-1', { title: 'Onboarding', description: 'd', flow: [TEXT_BLOCK], mindmap: LAYOUT });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'd', flow: [TEXT_BLOCK], mindmap: LAYOUT }),
      );
    });

    it('maps a unique violation onto 409 rather than surfacing a driver error', async () => {
      repository.save.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed: plans.sessionId, plans.title'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        }),
      );

      await expect(service.create('sess-1', { title: 'Welcome flow' })).rejects.toThrow(ConflictException);
    });

    // SQLite prefixes EVERY constraint failure with SQLITE_CONSTRAINT, so the classifier only
    // accepts the unique/primarykey suffixes. A bare prefixed code must NOT become a 409.
    it('does not turn a non-unique constraint failure into a 409', async () => {
      const fkFailure = Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT' });
      repository.save.mockRejectedValueOnce(fkFailure);

      await expect(service.create('sess-1', { title: 'x' })).rejects.toBe(fkFailure);
    });

    it('rethrows a non-unique save error untouched', async () => {
      const boom = new Error('disk gone');
      repository.save.mockRejectedValueOnce(boom);

      await expect(service.create('sess-1', { title: 'x' })).rejects.toBe(boom);
    });
  });

  describe('findBySession', () => {
    it('scopes the query to the session and orders newest first', async () => {
      repository.find.mockResolvedValue([createMockPlan()]);

      await service.findBySession('sess-1');

      expect(repository.find).toHaveBeenCalledWith({ where: { sessionId: 'sess-1' }, order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it("looks the plan up by id AND sessionId, so another session's plan reads as absent", async () => {
      repository.findOne.mockResolvedValue(createMockPlan());

      await service.findOne('sess-1', 'plan-uuid-1');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'plan-uuid-1', sessionId: 'sess-1' } });
    });

    it('throws 404 when no plan matches', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findOne('sess-1', 'nope')).rejects.toThrow(
        new NotFoundException("Plan with id 'nope' not found"),
      );
    });
  });

  describe('update', () => {
    it('replaces the whole flow when only `flow` is sent (the autosave shape)', async () => {
      repository.findOne.mockResolvedValue(createMockPlan({ flow: [{ id: 'old', type: 'text', text: 'old' }] }));

      const saved = await service.update('sess-1', 'plan-uuid-1', { flow: [TEXT_BLOCK] });

      expect(saved.flow).toEqual([TEXT_BLOCK]);
      // The title/description the autosave body omits must survive untouched.
      expect(saved.title).toBe('Welcome flow');
      expect(saved.description).toBeNull();
    });

    it('leaves the flow alone when only metadata is sent', async () => {
      repository.findOne.mockResolvedValue(createMockPlan({ flow: [TEXT_BLOCK] }));

      const saved = await service.update('sess-1', 'plan-uuid-1', { title: 'Renamed' });

      expect(saved.title).toBe('Renamed');
      expect(saved.flow).toEqual([TEXT_BLOCK]);
    });

    it('replaces the mindmap when only `mindmap` is sent (the map autosave shape)', async () => {
      repository.findOne.mockResolvedValue(createMockPlan({ flow: [TEXT_BLOCK] }));

      const saved = await service.update('sess-1', 'plan-uuid-1', { mindmap: LAYOUT });

      expect(saved.mindmap).toEqual(LAYOUT);
      // The metadata and flow the map autosave body omits must survive untouched.
      expect(saved.flow).toEqual([TEXT_BLOCK]);
      expect(saved.title).toBe('Welcome flow');
    });

    it('leaves the mindmap alone when only metadata is sent', async () => {
      repository.findOne.mockResolvedValue(createMockPlan({ mindmap: LAYOUT }));

      const saved = await service.update('sess-1', 'plan-uuid-1', { title: 'Renamed' });

      expect(saved.title).toBe('Renamed');
      expect(saved.mindmap).toEqual(LAYOUT);
    });

    it('throws 404 for a plan in another session, without saving', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.update('sess-2', 'plan-uuid-1', { title: 'x' })).rejects.toThrow(NotFoundException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('maps a duplicate title onto 409', async () => {
      repository.findOne.mockResolvedValue(createMockPlan());
      repository.save.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed: plans.sessionId, plans.title'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        }),
      );

      await expect(service.update('sess-1', 'plan-uuid-1', { title: 'Taken' })).rejects.toThrow(ConflictException);
    });
  });

  describe('media', () => {
    const upload = { buffer: Buffer.from('hello'), originalname: 'report.pdf', mimetype: 'application/pdf' };

    it('stores an upload under the plan prefix and returns a block-ready URL', async () => {
      repository.findOne.mockResolvedValue(createMockPlan());

      const result = await service.saveMedia('sess-1', 'plan-uuid-1', upload);

      expect(storage.putFile).toHaveBeenCalledWith(
        expect.stringMatching(/^plan-media\/sess-1\/plan-uuid-1\/.+\.pdf$/),
        upload.buffer,
      );
      expect(result).toMatchObject({ filename: 'report.pdf', mimetype: 'application/pdf', sizeBytes: 5 });
      expect(result.url).toMatch(/^\/sessions\/sess-1\/plans\/plan-uuid-1\/media\/.+\.pdf$/);
    });

    it('404s an upload to a plan outside the session, without storing bytes', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.saveMedia('sess-2', 'plan-uuid-1', upload)).rejects.toThrow(NotFoundException);
      expect(storage.putFile).not.toHaveBeenCalled();
    });

    it('rejects an upload with no file', async () => {
      repository.findOne.mockResolvedValue(createMockPlan());

      await expect(service.saveMedia('sess-1', 'plan-uuid-1', undefined)).rejects.toThrow(BadRequestException);
    });

    it('reads stored media back with an inert, extension-derived mime', async () => {
      repository.findOne.mockResolvedValue(createMockPlan());
      storage.getFile.mockResolvedValue(Buffer.from('bytes'));

      const result = await service.getMedia('sess-1', 'plan-uuid-1', 'abc.png');

      expect(storage.getFile).toHaveBeenCalledWith('plan-media/sess-1/plan-uuid-1/abc.png');
      expect(result.buffer.toString()).toBe('bytes');
      expect(result.mimetype).toBe('image/png');
    });

    it('404s a missing media object', async () => {
      repository.findOne.mockResolvedValue(createMockPlan());
      storage.getFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(service.getMedia('sess-1', 'plan-uuid-1', 'abc.png')).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes the plan it found', async () => {
      const plan = createMockPlan();
      repository.findOne.mockResolvedValue(plan);

      await service.delete('sess-1', 'plan-uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(plan);
    });

    it('throws 404 and removes nothing when the plan is absent', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.delete('sess-1', 'nope')).rejects.toThrow(NotFoundException);
      expect(repository.remove).not.toHaveBeenCalled();
    });
  });
});
