import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

/**
 * The account-private session fence in validateApiKey — the chokepoint that keeps a `users`-role
 * account key off every `:sessionId` route of another account's (or the operator's) sessions.
 */
describe('AuthService.validateApiKey — account-private sessions', () => {
  const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');

  const ACCOUNT_A = 'user-a-uuid';
  const ACCOUNT_B = 'user-b-uuid';
  const SESSION_OWNED = 'session-owned-by-a';
  const SESSION_FOREIGN = 'session-owned-by-b';
  const SESSION_UNOWNED = 'session-minted-via-api';

  function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
    return {
      id: 'key-1',
      name: 'probe',
      keyHash: hashKey('raw'),
      keyPrefix: 'probe-prefix',
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
    };
  }

  const sessionOwners: Record<string, string | null> = {
    [SESSION_OWNED]: ACCOUNT_A,
    [SESSION_FOREIGN]: ACCOUNT_B,
    [SESSION_UNOWNED]: null,
  };

  function buildService(apiKey: ApiKey) {
    const apiKeyRepo = { findOne: jest.fn().mockResolvedValue(apiKey) } as never;
    const tracker = { record: jest.fn().mockResolvedValue(null), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const sessionRepo = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id in sessionOwners ? { id: where.id, ownerUserId: sessionOwners[where.id] } : null),
      ),
    } as never;
    return new AuthService(apiKeyRepo, tracker, {} as never, sessionRepo);
  }

  it('lets an account users key reach a session it owns', async () => {
    const service = buildService(makeKey({ ownerUserId: ACCOUNT_A }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_OWNED)).resolves.toMatchObject({
      ownerUserId: ACCOUNT_A,
    });
  });

  it('refuses an account users key a session ANOTHER account owns', async () => {
    const service = buildService(makeKey({ ownerUserId: ACCOUNT_A }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_FOREIGN)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an account users key an orgmenu/API-created (ownerless) session', async () => {
    const service = buildService(makeKey({ ownerUserId: ACCOUNT_A }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_UNOWNED)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an account users key a session id that does not exist (no existence oracle)', async () => {
    const service = buildService(makeKey({ ownerUserId: ACCOUNT_A }));
    await expect(service.validateApiKey('raw', '127.0.0.1', 'no-such-session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('skips the owner lookup when no session id is in scope (list/aggregate routes)', async () => {
    const sessionRepo = { findOne: jest.fn() };
    const apiKeyRepo = { findOne: jest.fn().mockResolvedValue(makeKey({ ownerUserId: ACCOUNT_A })) } as never;
    const tracker = { record: jest.fn().mockResolvedValue(null), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const service = new AuthService(apiKeyRepo, tracker, {} as never, sessionRepo as never);

    await expect(service.validateApiKey('raw', '127.0.0.1')).resolves.toBeDefined();
    expect(sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('an ORGMENU account key keeps the pre-existing unrestricted model', async () => {
    const service = buildService(makeKey({ ownerUserId: ACCOUNT_B, role: ApiKeyRole.ORG_MENU }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_OWNED)).resolves.toBeDefined();
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_UNOWNED)).resolves.toBeDefined();
  });

  it('a hand-minted key (ownerUserId NULL) keeps the pre-existing model, scoped only by allowlist', async () => {
    const service = buildService(makeKey({ role: ApiKeyRole.ORG_MENU }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_OWNED)).resolves.toBeDefined();
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_UNOWNED)).resolves.toBeDefined();
  });

  it('still enforces the explicit allowedSessions allowlist (unchanged behaviour)', async () => {
    const service = buildService(makeKey({ role: ApiKeyRole.ORG_MENU, allowedSessions: [SESSION_UNOWNED] }));
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_UNOWNED)).resolves.toBeDefined();
    await expect(service.validateApiKey('raw', '127.0.0.1', SESSION_OWNED)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
