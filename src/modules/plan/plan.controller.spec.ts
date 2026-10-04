import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';

describe('PlanController', () => {
  const service = {
    create: jest.fn(),
    findBySession: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    saveMedia: jest.fn(),
    getMedia: jest.fn(),
  };
  const controller = new PlanController(service as unknown as PlanService);

  beforeEach(() => jest.clearAllMocks());

  it('create delegates with the session id and DTO', async () => {
    const dto = { title: 'Welcome flow' };
    service.create.mockResolvedValue({ id: 'p1' });
    await controller.create('s1', dto);
    expect(service.create).toHaveBeenCalledWith('s1', dto);
  });

  it('findBySession delegates', async () => {
    service.findBySession.mockResolvedValue([]);
    await controller.findBySession('s1');
    expect(service.findBySession).toHaveBeenCalledWith('s1');
  });

  it('findOne delegates with session + id', async () => {
    service.findOne.mockResolvedValue({ id: 'p1' });
    await controller.findOne('s1', 'p1');
    expect(service.findOne).toHaveBeenCalledWith('s1', 'p1');
  });

  it('update delegates with session, id and DTO', async () => {
    const dto = { flow: [] };
    service.update.mockResolvedValue({ id: 'p1' });
    await controller.update('s1', 'p1', dto);
    expect(service.update).toHaveBeenCalledWith('s1', 'p1', dto);
  });

  it('delete delegates and resolves void', async () => {
    service.delete.mockResolvedValue(undefined);
    await expect(controller.delete('s1', 'p1')).resolves.toBeUndefined();
    expect(service.delete).toHaveBeenCalledWith('s1', 'p1');
  });
});
