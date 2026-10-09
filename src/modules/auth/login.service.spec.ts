jest.mock('../../common/utils/secret-file', () => ({ writeSecretFile: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import { LoginService, loginKeyName } from './login.service';
import { User, UserRole } from '../tenancy/entities/user.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { hashPassword } from './password-hash';
import { hashApiKey } from './api-key-hash';
import { writeSecretFile } from '../../common/utils/secret-file';
import { AuditAction } from '../audit/entities/audit-log.entity';

const writeSecretFileMock = writeSecretFile as jest.MockedFunction<typeof writeSecretFile>;

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'admin@localhost',
  name: 'Administrator',
  passwordHash: null,
  role: UserRole.ORG_MENU,
  isActive: true,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'k-existing',
  name: 'user:admin@localhost',
  keyHash: 'old-hash',
  keyPrefix: 'old-prefix',
  role: ApiKeyRole.ORG_MENU,
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
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock<Partial<User>, [Partial<User>]>;
    update: jest.Mock;
  };
  apiKeyRepository: {
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock<Partial<ApiKey>, [Partial<ApiKey>]>;
    remove: jest.Mock;
  };
  audit: { logInfo: jest.Mock; logWarn: jest.Mock };
}

function createHarness(): Harness {
  const userRepository = {
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((entity: User) => entity),
    create: jest.fn((dto: Partial<User>) => dto),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
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

describe('LoginService', () => {
  const ORIGINAL_ENV = process.env;
  const CONTEXT = { ipAddress: '10.0.0.9', userAgent: 'test-agent', method: 'POST', path: '/api/auth/login' };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    delete process.env.BOOTSTRAP_ADMIN_FILE;
    delete process.env.API_KEY_PEPPER;
    writeSecretFileMock.mockReset();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('first-boot bootstrap admin seeding', () => {
    it('seeds admin@localhost with a generated password written to the credentials file', async () => {
      const { service, userRepository } = createHarness();

      await service.onModuleInit();

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'admin@localhost',
          name: 'Administrator',
          role: UserRole.ORG_MENU,
          isActive: true,
          passwordHash: expect.stringContaining('scrypt$') as unknown,
        }),
      );
      expect(writeSecretFileMock).toHaveBeenCalledWith(
        expect.stringContaining('.admin-credentials'),
        expect.stringMatching(/^email=admin@localhost\npassword=/),
      );
    });

    it('honours BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD without writing a file', async () => {
      process.env.BOOTSTRAP_ADMIN_EMAIL = '  Boss@Corp.com  ';
      process.env.BOOTSTRAP_ADMIN_PASSWORD = 'from-env';
      const { service, userRepository } = createHarness();

      await service.onModuleInit();

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'boss@corp.com', passwordHash: expect.any(String) as unknown }),
      );
      expect(writeSecretFileMock).not.toHaveBeenCalled();
    });

    it('does nothing when users already exist', async () => {
      const { service, userRepository } = createHarness();
      userRepository.count.mockResolvedValue(3);

      await service.onModuleInit();

      expect(userRepository.create).not.toHaveBeenCalled();
      expect(writeSecretFileMock).not.toHaveBeenCalled();
    });

    it('never throws when the database is unavailable', async () => {
      const { service, userRepository } = createHarness();
      userRepository.count.mockRejectedValue(new Error('db down'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('login', () => {
    let storedHash: string;

    beforeAll(async () => {
      storedHash = await hashPassword('password123');
    });

    it('returns a fresh owa key carrying the account role, and audits success', async () => {
      const { service, userRepository, apiKeyRepository, audit } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: storedHash }));

      const result = await service.login({ email: '  Admin@Localhost  ', password: 'password123' }, CONTEXT);

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { email: 'admin@localhost' } });
      expect(result.apiKey).toMatch(/^owa_k1_[a-f0-9]{64}$/);
      expect(result.role).toBe(UserRole.ORG_MENU);
      expect(result.user).toEqual({ id: 'u1', email: 'admin@localhost', name: 'Administrator' });

      expect(apiKeyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'user:admin@localhost',
          keyHash: hashApiKey(result.apiKey, undefined),
          role: ApiKeyRole.ORG_MENU,
        }),
      );
      expect(userRepository.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ lastLoginAt: expect.any(Date) as unknown }),
      );
      expect(audit.logInfo).toHaveBeenCalledWith(
        AuditAction.AUTH_LOGIN_SUCCEEDED,
        expect.objectContaining({
          ipAddress: '10.0.0.9',
          userAgent: 'test-agent',
          metadata: expect.objectContaining({
            userId: 'u1',
            email: 'admin@localhost',
            role: UserRole.ORG_MENU,
          }) as unknown,
        }),
      );
    });

    it('mirrors the account role onto the issued key', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser({ role: UserRole.USER, passwordHash: storedHash }));

      const result = await service.login({ email: 'admin@localhost', password: 'password123' });

      expect(apiKeyRepository.create).toHaveBeenCalledWith(expect.objectContaining({ role: ApiKeyRole.USER }));
      expect(result.role).toBe(UserRole.USER);
    });

    it('rotates the existing user key instead of creating a second row', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const existing = makeKey();
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: storedHash }));
      apiKeyRepository.find.mockResolvedValue([existing]);

      const result = await service.login({ email: 'admin@localhost', password: 'password123' });

      expect(apiKeyRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'k-existing', keyHash: hashApiKey(result.apiKey, undefined), isActive: true }),
      );
      expect(apiKeyRepository.create).not.toHaveBeenCalled();
      expect(apiKeyRepository.remove).not.toHaveBeenCalled();
    });

    it('removes duplicate user-key rows left by a double-click race', async () => {
      const { service, userRepository, apiKeyRepository } = createHarness();
      const current = makeKey({ id: 'k1' });
      const stale1 = makeKey({ id: 'k2' });
      const stale2 = makeKey({ id: 'k3' });
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: storedHash }));
      apiKeyRepository.find.mockResolvedValue([current, stale1, stale2]);

      await service.login({ email: 'admin@localhost', password: 'password123' });

      expect(apiKeyRepository.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'k1' }));
      expect(apiKeyRepository.remove).toHaveBeenCalledWith([stale1, stale2]);
    });

    it('rejects an unknown email with a single message and audits the failure', async () => {
      const { service, audit } = createHarness();

      await expect(service.login({ email: 'nobody@localhost', password: 'password123' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.logWarn).toHaveBeenCalledWith(
        AuditAction.AUTH_LOGIN_FAILED,
        expect.objectContaining({
          metadata: expect.objectContaining({ email: 'nobody@localhost', reason: 'unknown_email' }) as unknown,
        }),
      );
    });

    it('rejects a wrong password without revealing the account exists', async () => {
      const { service, userRepository, audit } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: storedHash }));

      await expect(service.login({ email: 'admin@localhost', password: 'nope' })).rejects.toThrow(
        new UnauthorizedException('Invalid email or password'),
      );
      expect(audit.logWarn).toHaveBeenCalledWith(
        AuditAction.AUTH_LOGIN_FAILED,
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'invalid_password' }) as unknown }),
      );
    });

    it('rejects an account with no stored password hash (legacy API-only row)', async () => {
      const { service, userRepository } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: null }));

      await expect(service.login({ email: 'admin@localhost', password: 'password123' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a disabled account with the same single message', async () => {
      const { service, userRepository, audit } = createHarness();
      userRepository.findOne.mockResolvedValue(makeUser({ passwordHash: storedHash, isActive: false }));

      await expect(service.login({ email: 'admin@localhost', password: 'password123' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.logWarn).toHaveBeenCalledWith(
        AuditAction.AUTH_LOGIN_FAILED,
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'inactive_account' }) as unknown }),
      );
    });
  });

  describe('loginKeyName', () => {
    it('names the account key after its normalized email', () => {
      expect(loginKeyName('admin@localhost')).toBe('user:admin@localhost');
    });
  });
});
