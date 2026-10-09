jest.mock('../../common/utils/secret-file', () => ({ writeSecretFile: jest.fn() }));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { LoginService, loginKeyName } from './login.service';
import { User, UserRole } from '../tenancy/entities/user.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'a@b.c',
  name: 'Ada',
  passwordHash: null,
  role: UserRole.USER,
  isActive: true,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeOrgMenu = (overrides: Partial<User> = {}): User =>
  makeUser({ id: 'org-1', email: 'org@b.c', name: 'Org', role: UserRole.ORG_MENU, ...overrides });

const makeLoginKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key-1',
  name: loginKeyName('a@b.c'),
  keyHash: 'h',
  keyPrefix: 'owa_k1_1234',
  role: ApiKeyRole.USER,
  allowedIps: null,
  allowedSessions: null,
  allowedChats: null,
  ownerUserId: null,
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  usageCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

interface Harness {
  service: LoginService;
  userRepository: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };
  apiKeyRepository: {
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    remove: jest.Mock;
  };
  audit: { logInfo: jest.Mock; logWarn: jest.Mock };
}

function createHarness(): Harness {
  const userRepository = {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((entity: User) => entity),
    create: jest.fn((dto: Partial<User>) => dto),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    remove: jest.fn().mockResolvedValue([]),
  };
  const apiKeyRepository = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((entity: ApiKey) => ({ ...entity, id: entity.id ?? 'k-new' })),
    create: jest.fn((dto: Partial<ApiKey>) => dto),
    remove: jest.fn().mockResolvedValue([]),
  };
  const audit = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
  const service = new LoginService(userRepository as never, apiKeyRepository as never, audit as never);
  return { service, userRepository, apiKeyRepository, audit };
}

describe('LoginService — user management (orgmenu provisioning)', () => {
  it('listUsers returns every account ordered by creation', async () => {
    const { service, userRepository } = createHarness();
    userRepository.find.mockResolvedValue([makeUser()]);
    await expect(service.listUsers()).resolves.toHaveLength(1);
    expect(userRepository.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' } });
  });

  describe('createUser', () => {
    it('creates a least-privilege account with a hashed password and derived name', async () => {
      const { service, userRepository } = createHarness();
      const saved = await service.createUser({ email: 'op@acme.example', password: 'correct-horse' });

      expect(saved.role).toBe(UserRole.USER);
      expect(saved.name).toBe('op@acme.example'.split('@')[0]);
      expect(saved.isActive).toBe(true);
      expect(saved.passwordHash).toMatch(/^scrypt\$16384\$/);
      expect(userRepository.save).toHaveBeenCalled();
    });

    it('honours an explicit role and name', async () => {
      const { service } = createHarness();
      const saved = await service.createUser({
        email: 'boss@acme.example',
        password: 'correct-horse',
        name: 'Boss',
        role: UserRole.ORG_MENU,
      });
      expect(saved.name).toBe('Boss');
      expect(saved.role).toBe(UserRole.ORG_MENU);
    });

    it('rejects a duplicate email with 409 before hashing', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser());
      await expect(service.createUser({ email: 'a@b.c', password: 'correct-horse' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('registerUser (public self-signup)', () => {
    it('always creates a least-privilege users account with a hashed password', async () => {
      const { service, userRepository } = createHarness();
      const saved = await service.registerUser({
        email: 'Op@Acme.Example',
        password: 'correct-horse',
        name: 'Option A',
      });

      expect(saved.email).toBe('Op@Acme.Example');
      expect(saved.name).toBe('Option A');
      expect(saved.role).toBe(UserRole.USER);
      expect(saved.isActive).toBe(true);
      expect(saved.passwordHash).toMatch(/^scrypt\$16384\$/);
      expect(userRepository.save).toHaveBeenCalled();
    });

    it('derives the name from the email when none is supplied', async () => {
      const { service } = createHarness();
      const saved = await service.registerUser({ email: 'ada@acme.example', password: 'correct-horse' });
      expect(saved.name).toBe('ada');
    });

    it('rejects a duplicate email with 409 before hashing', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser());
      await expect(service.registerUser({ email: 'a@b.c', password: 'correct-horse' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    it('renames an account', async () => {
      const { service, userRepository } = createHarness();
      const before = makeUser();
      userRepository.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, name: 'Ada II' });
      const updated = await service.updateUser('u1', { name: '  Ada II  ' });
      expect(updated.name).toBe('Ada II');
      expect(userRepository.update).toHaveBeenCalledWith('u1', { name: 'Ada II' });
    });

    it('demotes an orgmenu when another active orgmenu remains', async () => {
      const { service, userRepository } = createHarness();
      const before = makeOrgMenu();
      userRepository.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, role: UserRole.USER });
      userRepository.count.mockResolvedValue(2);
      const updated = await service.updateUser('org-1', { role: UserRole.USER });
      expect(updated.role).toBe(UserRole.USER);
      expect(userRepository.update).toHaveBeenCalledWith('org-1', { role: UserRole.USER });
    });

    it('refuses to demote the last active orgmenu', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeOrgMenu());
      userRepository.count.mockResolvedValue(1);
      await expect(service.updateUser('org-1', { role: UserRole.USER })).rejects.toBeInstanceOf(ConflictException);
      expect(userRepository.update).not.toHaveBeenCalled();
      expect(apiKeyRepository.find).not.toHaveBeenCalled();
    });

    it('refuses to disable the last active orgmenu', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeOrgMenu());
      userRepository.count.mockResolvedValue(1);
      await expect(service.updateUser('org-1', { isActive: false })).rejects.toBeInstanceOf(ConflictException);
    });

    it('disabling a plain account deactivates it and revokes its login keys', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const before = makeUser();
      userRepository.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, isActive: false });
      const key = makeLoginKey({ isActive: true });
      apiKeyRepository.find.mockResolvedValue([key]);

      const updated = await service.updateUser('u1', { isActive: false });

      expect(updated.isActive).toBe(false);
      expect(userRepository.update).toHaveBeenCalledWith('u1', { isActive: false });
      expect(key.isActive).toBe(false);
      expect(apiKeyRepository.save).toHaveBeenCalledWith(key);
    });

    it('a password reset re-hashes and revokes live session keys', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const before = makeUser();
      userRepository.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(before);
      apiKeyRepository.find.mockResolvedValue([makeLoginKey({ isActive: true })]);

      await service.updateUser('u1', { password: 'new-correct-horse' });

      const [, patch] = userRepository.update.mock.calls[0] as [string, Partial<User>];
      expect(patch.passwordHash).toMatch(/^scrypt\$16384\$/);
      expect(patch.passwordHash).not.toBe(before.passwordHash);
      expect(apiKeyRepository.save).toHaveBeenCalled();
    });

    it('throws 404 for an unknown id', async () => {
      const { service } = createHarness();
      await expect(service.updateUser('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteUser', () => {
    it('deletes the account and its login keys, but never itself', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const user = makeUser();
      userRepository.findOne.mockResolvedValueOnce(user).mockResolvedValueOnce(user);
      apiKeyRepository.find.mockResolvedValue([makeLoginKey({ id: 'k1' }), makeLoginKey({ id: 'k2' })]);

      // a different actor
      await service.deleteUser('u1', loginKeyName('someone.else@x.y'));

      expect(apiKeyRepository.save).toHaveBeenCalledTimes(2);
      expect(userRepository.remove).toHaveBeenCalledWith(user);
    });

    it('refuses to delete the account the acting key belongs to', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser());
      await expect(service.deleteUser('u1', loginKeyName('a@b.c'))).rejects.toBeInstanceOf(ConflictException);
      expect(userRepository.remove).not.toHaveBeenCalled();
    });

    it('refuses to delete the last active orgmenu', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeOrgMenu());
      userRepository.count.mockResolvedValue(1);
      await expect(service.deleteUser('org-1', loginKeyName('someone.else@x.y'))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows deleting orgmenu while another remains', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const target = makeOrgMenu();
      userRepository.findOne.mockResolvedValueOnce(target).mockResolvedValueOnce(target);
      userRepository.count.mockResolvedValue(2);
      apiKeyRepository.find.mockResolvedValue([]);

      await service.deleteUser('org-1', loginKeyName('someone.else@x.y'));
      expect(userRepository.remove).toHaveBeenCalledWith(target);
    });

    it('throws 404 for an unknown id', async () => {
      const { service } = createHarness();
      await expect(service.deleteUser('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
