import type { Request } from 'express';
import { AuthLoginController } from './auth-login.controller';
import { LoginService } from './login.service';

describe('AuthLoginController', () => {
  const login = jest.fn();
  const config = { get: jest.fn() };
  let controller: AuthLoginController;

  beforeEach(() => {
    login.mockReset();
    config.get.mockReset().mockReturnValue(undefined);
    controller = new AuthLoginController({ login } as unknown as LoginService, config as never);
  });

  const request = (over: Partial<Request> = {}): Request =>
    ({
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'user-agent': 'test-agent' },
      method: 'POST',
      path: '/api/auth/login',
      get: (name: string) => (name === 'user-agent' ? 'test-agent' : undefined),
      ...over,
    }) as Request;

  it('delegates the credentials to LoginService with resolved client metadata', async () => {
    login.mockResolvedValue({ apiKey: 'owa_k1_x', role: 'orgmenu', user: { id: 'u1', email: 'a@b.c', name: 'A' } });

    const result = await controller.login({ email: 'a@b.c', password: 'pw' }, request());

    expect(login).toHaveBeenCalledWith(
      { email: 'a@b.c', password: 'pw' },
      { ipAddress: '127.0.0.1', userAgent: 'test-agent', method: 'POST', path: '/api/auth/login' },
    );
    expect(result.apiKey).toBe('owa_k1_x');
  });

  it('resolves the client IP and trusts X-Forwarded-For only through a configured proxy', async () => {
    const trustedProxies = ['10.0.0.0/8'];
    config.get.mockReturnValue(trustedProxies);
    const req = request({
      socket: { remoteAddress: '10.0.0.5' } as Request['socket'],
      headers: { 'user-agent': 'agent', 'x-forwarded-for': '203.0.113.7' },
    });

    await controller.login({ email: 'a@b.c', password: 'pw' }, req);

    expect(config.get).toHaveBeenCalledWith('security.trustedProxies');
    expect(login).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ipAddress: '203.0.113.7' }));
  });
});
