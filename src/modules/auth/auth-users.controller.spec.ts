import type { Request } from 'express';
import { AuthUsersController } from './auth-users.controller';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { UserRole } from '../tenancy/entities/user.entity';
import type { ApiKey } from './entities/api-key.entity';

// The user-management routes are orgmenu-only and must never leak credential material (passwordHash)
// in their responses, and each mutation must leave an audit row naming the acting key, the client IP
// and the target account.
describe('AuthUsersController — orgmenu account provisioning', () => {
  const actor = { id: 'admin-key', name: 'Default Admin Key' } as unknown as ApiKey;
  const makeReq = (): Request =>
    ({ method: 'POST', path: '/auth/users', clientIp: '203.0.113.7' }) as unknown as Request;

  let loginService: {
    listUsers: jest.Mock;
    createUser: jest.Mock;
    updateUser: jest.Mock;
    deleteUser: jest.Mock;
    findUserForAudit: jest.Mock;
  };
  let auditService: { logInfo: jest.Mock };
  let controller: AuthUsersController;

  beforeEach(() => {
    const user = {
      id: 'u1',
      email: 'op@acme.example',
      name: 'Op',
      role: UserRole.USER,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      passwordHash: 'scrypt$16384$NEVER-EXPOSE',
    };
    loginService = {
      listUsers: jest.fn().mockResolvedValue([user]),
      createUser: jest.fn().mockResolvedValue(user),
      updateUser: jest.fn().mockResolvedValue({ ...user, name: 'Op II' }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
      findUserForAudit: jest.fn().mockResolvedValue(user),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    controller = new AuthUsersController(loginService as never, auditService as never);
  });

  const lastContextFor = (action: AuditAction): Record<string, unknown> | undefined => {
    const calls = auditService.logInfo.mock.calls as Array<[AuditAction, Record<string, unknown>]>;
    return calls.find(c => c[0] === action)?.[1];
  };

  it('lists users without credentials', async () => {
    const result = await controller.list();
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(result[0].role).toBe(UserRole.USER);
  });

  it('creates a user and audits USER_CREATED', async () => {
    const result = await controller.create({ email: 'op@acme.example', password: 'correct-horse' }, makeReq(), actor);
    expect(result).not.toHaveProperty('passwordHash');
    expect(loginService.createUser).toHaveBeenCalledWith({ email: 'op@acme.example', password: 'correct-horse' });
    const ctx = lastContextFor(AuditAction.USER_CREATED);
    expect(ctx?.apiKey).toBe(actor);
    expect((ctx?.metadata as { targetUserId: string }).targetUserId).toBe('u1');
  });

  it('updates a user and audits USER_UPDATED with before/after state', async () => {
    const result = await controller.update('u1', { name: 'Op II' }, makeReq(), actor);
    expect(result.name).toBe('Op II');
    const ctx = lastContextFor(AuditAction.USER_UPDATED);
    const metadata = ctx?.metadata as { before: { role: string }; after: { name: string } };
    expect(metadata.before.role).toBe(UserRole.USER);
    expect(metadata.after.name).toBe('Op II');
  });

  it('deletes a user and audits USER_DELETED', async () => {
    await controller.remove('u1', makeReq(), actor);
    expect(loginService.deleteUser).toHaveBeenCalledWith('u1', actor.name);
    const ctx = lastContextFor(AuditAction.USER_DELETED);
    expect((ctx?.metadata as { email: string }).email).toBe('op@acme.example');
  });
});
