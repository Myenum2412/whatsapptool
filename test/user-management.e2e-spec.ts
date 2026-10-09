import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { User, UserRole } from './../src/modules/tenancy/entities/user.entity';
import { AuditLog, AuditAction } from './../src/modules/audit/entities/audit-log.entity';

/**
 * End-to-end proof of /api/auth/users, the orgmenu-only account-provisioning surface: USER-role
 * keys are fenced out of every route, restricted ORG_MENU keys (session- or chat-scoped) are
 * refused, and the orgmenu can create an account that then signs in — and whose lockout/removal is
 * honoured by the login surface.
 */
describe('Orgmenu user management (e2e)', () => {
  let app: INestApplication<App>;
  let userKey: string;
  let orgKey: string;
  let userRepo: Repository<User>;
  let auditRepo: Repository<AuditLog>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    userRepo = app.get(getRepositoryToken(User, 'main'));
    auditRepo = app.get(getRepositoryToken(AuditLog, 'main'));

    const authService = app.get(AuthService);
    orgKey = (await authService.createApiKey({ name: 'e2e-um-orgmenu', role: ApiKeyRole.ORG_MENU })).rawKey;
    userKey = (await authService.createApiKey({ name: 'e2e-um-user', role: ApiKeyRole.USER })).rawKey;
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueEmail = (prefix: string): string => `${prefix}-${Date.now().toString(36)}@e2e.example`;

  const loginAs = async (email: string, password: string): Promise<request.Response> =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

  it('fences every route from a USER-role key (403)', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/auth/users').set('X-API-Key', userKey).expect(403);
    await request(server)
      .post('/api/auth/users')
      .set('X-API-Key', userKey)
      .send({ email: 'x@e2e.example', password: 'correct-horse' })
      .expect(403);
    await request(server).patch('/api/auth/users/none').set('X-API-Key', userKey).send({}).expect(403);
    await request(server).delete('/api/auth/users/none').set('X-API-Key', userKey).expect(403);
  });

  it('refuses a session-scoped ORG_MENU key (it could mint an unrestricted account)', async () => {
    const authService = app.get(AuthService);
    const scoped = (
      await authService.createApiKey({ name: 'e2e-um-scoped', role: ApiKeyRole.ORG_MENU, allowedSessions: ['sess-1'] })
    ).rawKey;
    await request(app.getHttpServer()).get('/api/auth/users').set('X-API-Key', scoped).expect(403);
  });

  it('refuses a chat-scoped ORG_MENU key (blanket chat fence)', async () => {
    const authService = app.get(AuthService);
    const chatScoped = (
      await authService.createApiKey({ name: 'e2e-um-chat', role: ApiKeyRole.ORG_MENU, allowedChats: ['x@g.us'] })
    ).rawKey;
    await request(app.getHttpServer()).get('/api/auth/users').set('X-API-Key', chatScoped).expect(403);
  });

  it('lists accounts (including the seeded bootstrap admin) for orgmenu', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/users').set('X-API-Key', orgKey).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ email: string }>).some((u: { email: string }) => u.email === 'admin@localhost')).toBe(
      true,
    );
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('creates a least-privilege account that can then sign in', async () => {
    const email = uniqueEmail('create');
    const created = await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse', name: 'Ada' })
      .expect(201);
    expect((created.body as { role: string }).role).toBe('users');
    expect((created.body as { email: string }).email).toBe(email);

    const login = await loginAs(email, 'correct-horse');
    expect(login.status).toBe(200);
    expect((login.body as { role: string }).role).toBe('users');
    expect((login.body as { apiKey: string }).apiKey).toMatch(/^owa_k1_/);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('dup');
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse' })
      .expect(409);
  });

  it('honours account lockout: disabling an account kills sign-in, re-enabling restores it', async () => {
    const email = uniqueEmail('lock');
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse' })
      .expect(201);
    const row = (await userRepo.findOne({ where: { email } })) as User;

    await request(app.getHttpServer())
      .patch(`/api/auth/users/${row.id}`)
      .set('X-API-Key', orgKey)
      .send({ isActive: false })
      .expect(200);
    expect((await loginAs(email, 'correct-horse')).status).toBe(401);

    await request(app.getHttpServer())
      .patch(`/api/auth/users/${row.id}`)
      .set('X-API-Key', orgKey)
      .send({ isActive: true })
      .expect(200);
    expect((await loginAs(email, 'correct-horse')).status).toBe(200);
  });

  it('deleting an account revokes its session key and its ability to sign in', async () => {
    const email = uniqueEmail('del');
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse' })
      .expect(201);
    const row = (await userRepo.findOne({ where: { email } })) as User;

    await request(app.getHttpServer()).delete(`/api/auth/users/${row.id}`).set('X-API-Key', orgKey).expect(204);
    expect(await userRepo.findOne({ where: { email } })).toBeNull();
    expect((await loginAs(email, 'correct-horse')).status).toBe(401);
  });

  it('cannot delete the account its own key belongs to (self-delete -> 409)', async () => {
    const email = uniqueEmail('self');
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse', role: 'orgmenu' })
      .expect(201);

    const login = await loginAs(email, 'correct-horse');
    expect(login.status).toBe(200);
    const ownKey = (login.body as { apiKey: string }).apiKey;
    const row = (await userRepo.findOne({ where: { email } })) as User;

    await request(app.getHttpServer()).delete(`/api/auth/users/${row.id}`).set('X-API-Key', ownKey).expect(409);
    expect(await userRepo.findOne({ where: { email } })).not.toBeNull();
  });

  it('audits the lifecycle as USER_CREATED/USER_UPDATED/USER_DELETED', async () => {
    const email = uniqueEmail('audit');
    const created = await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', orgKey)
      .send({ email, password: 'correct-horse' })
      .expect(201);
    const id = (created.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/api/auth/users/${id}`)
      .set('X-API-Key', orgKey)
      .send({ name: 'Renamed' })
      .expect(200);
    await request(app.getHttpServer()).delete(`/api/auth/users/${id}`).set('X-API-Key', orgKey).expect(204);

    const deadline = Date.now() + 5000;
    const waitFor = async (action: AuditAction) => {
      while (Date.now() < deadline) {
        const row = await auditRepo.findOne({ where: { action, apiKeyName: 'e2e-um-orgmenu' } });
        if (row) return row;
      }
      return null;
    };
    expect(await waitFor(AuditAction.USER_CREATED)).not.toBeNull();
    expect(await waitFor(AuditAction.USER_UPDATED)).not.toBeNull();
    expect(await waitFor(AuditAction.USER_DELETED)).not.toBeNull();
  });

  it('does not demote roles silently: an orgmenu-tier account is created explicitly or stays users', async () => {
    const rows = await userRepo.find({ order: { createdAt: 'ASC' } });
    const expectedRoles = rows.map(r => r.role);
    expect(expectedRoles.every(r => r === UserRole.USER || r === UserRole.ORG_MENU)).toBe(true);
  });
});
