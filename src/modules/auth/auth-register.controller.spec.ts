import type { Request } from 'express';
import { AuthRegisterController } from './auth-register.controller';
import { LoginService } from './login.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('AuthRegisterController', () => {
  const registerUser = jest.fn();
  const logInfo = jest.fn().mockResolvedValue(null);
  const config = { get: jest.fn() };
  let controller: AuthRegisterController;

  beforeEach(() => {
    registerUser.mockReset();
    logInfo.mockReset();
    config.get.mockReset().mockReturnValue(undefined);
    controller = new AuthRegisterController(
      { registerUser } as unknown as LoginService,
      config as never,
      { logInfo } as unknown as AuditService,
    );
  });

  const request = (over: Partial<Request> = {}): Request =>
    ({
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'user-agent': 'test-agent' },
      method: 'POST',
      path: '/api/auth/register',
      get: (name: string) => (name === 'user-agent' ? 'test-agent' : undefined),
      ...over,
    }) as Request;

  it('delegates the signup to LoginService and audits the created account as a self-signup', async () => {
    registerUser.mockResolvedValue({
      id: 'u-new',
      email: 'op@acme.example',
      name: 'Op',
      role: 'users',
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
    });

    const result = await controller.register({ email: 'op@acme.example', password: 'correct-horse' }, request());

    expect(registerUser).toHaveBeenCalledWith({ email: 'op@acme.example', password: 'correct-horse' });
    expect(result.email).toBe('op@acme.example');
    expect(result.role).toBe('users');
    expect(logInfo).toHaveBeenCalledWith(
      AuditAction.USER_CREATED,
      expect.objectContaining({
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        method: 'POST',
        path: '/api/auth/register',
        metadata: expect.objectContaining({
          source: 'self-signup',
          email: 'op@acme.example',
          role: 'users',
        }) as unknown,
      }),
    );
  });

  it('resolves the client IP and trusts X-Forwarded-For only through a configured proxy', async () => {
    registerUser.mockResolvedValue({
      id: 'u',
      email: 'a@b.c',
      name: 'A',
      role: 'users',
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
    });
    config.get.mockReturnValue(['10.0.0.0/8']);
    const req = request({
      socket: { remoteAddress: '10.0.0.5' } as Request['socket'],
      headers: { 'user-agent': 'agent', 'x-forwarded-for': '203.0.113.7' },
    });

    await controller.register({ email: 'a@b.c', password: 'correct-horse' }, req);

    expect(config.get).toHaveBeenCalledWith('security.trustedProxies');
    expect(logInfo).toHaveBeenCalledWith(
      AuditAction.USER_CREATED,
      expect.objectContaining({ ipAddress: '203.0.113.7' }),
    );
  });
});
