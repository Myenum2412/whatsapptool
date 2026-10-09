import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { User } from './../src/modules/tenancy/entities/user.entity';
import { AuditLog, AuditAction } from './../src/modules/audit/entities/audit-log.entity';

/**
 * End-to-end proof of POST /api/auth/register, the public self-signup surface: it answers with no
 * API key at all, and what it creates is always a least-privilege `users` account — the body has no
 * role field, and a client that smuggles one in (or names, or impersonates) is met with 400/409.
 */
describe('Public self-signup (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;
  let auditRepo: Repository<AuditLog>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    userRepo = app.get(getRepositoryToken(User, 'main'));
    auditRepo = app.get(getRepositoryToken(AuditLog, 'main'));
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueEmail = (prefix: string): string => `${prefix}-${Date.now().toString(36)}@self.example`;

  const registerAs = (email: string, over: Record<string, unknown> = {}): request.Test =>
    request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse', ...over });

  it('creates a users account with no API key, and the account can sign in', async () => {
    const email = uniqueEmail('open');
    const created = await registerAs(email).expect(201);

    expect((created.body as { role: string }).role).toBe('users');
    expect((created.body as { email: string }).email).toBe(email);
    expect(JSON.stringify(created.body)).not.toContain('passwordHash');

    const row = (await userRepo.findOne({ where: { email } })) as User;
    expect(row.role).toBe('users');
    expect(row.passwordHash).toMatch(/^scrypt\$/);

    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-horse' });
    expect(login.status).toBe(200);
    expect((login.body as { role: string }).role).toBe('users');
  });

  it('refuses a body that smuggles a role (no self-promotion to orgmenu)', async () => {
    await registerAs(uniqueEmail('smuggle'), { role: 'orgmenu', name: 'Sneaky' }).expect(400);
  });

  it('rejects a duplicate email with 409 even without a key', async () => {
    const email = uniqueEmail('dup');
    await registerAs(email).expect(201);
    await registerAs(email).expect(409);
  });

  it('rejects a short password with 400', async () => {
    await registerAs(uniqueEmail('short'), { password: 'short' }).expect(400);
  });

  it("audits the self-signup as USER_CREATED with source 'self-signup'", async () => {
    const email = uniqueEmail('audit');
    const created = await registerAs(email).expect(201);
    const id = (created.body as { id: string }).id;

    const deadline = Date.now() + 5000;
    let row: AuditLog | null = null;
    while (Date.now() < deadline) {
      row = await auditRepo.findOne({ where: { action: AuditAction.USER_CREATED } });
      const meta = row?.metadata ?? {};
      if (meta.targetUserId === id) break;
    }
    expect(row).not.toBeNull();
    expect((row?.metadata as Record<string, unknown>).source).toBe('self-signup');
  });

  it('leaves the self-signed-up account no reach to account-management, key or audit data (403)', async () => {
    // The account public signup mints is least-privilege: its login key carries `users`, so every
    // surface where another account's data (emails, names, roles, keys, audit entries) lives must
    // refuse it. This locks the isolation so a later change cannot quietly widen signup's blast radius.
    const email = uniqueEmail('fence');
    await registerAs(email).expect(201);

    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-horse' });
    expect(login.status).toBe(200);
    expect((login.body as { role: string }).role).toBe('users');
    const signupKey = (login.body as { apiKey: string }).apiKey;
    expect(signupKey).toBeTruthy();

    const asSignup = (path: string, method: 'get' | 'post' | 'patch' | 'delete' = 'get'): request.Test => {
      const call = request(app.getHttpServer())[method](path);
      return call.set('X-API-Key', signupKey);
    };

    // Whole surfaces (class/route-level @RequireRole(ORG_MENU), the api-keys fence @RequireUnscopedKey):
    await asSignup('/api/auth/users').expect(403);
    await asSignup('/api/auth/users', 'post')
      .send({ email: uniqueEmail('fence2'), password: 'correct-horse' })
      .expect(403);
    await asSignup('/api/auth/users/00000000-0000-4000-8000-000000000000', 'patch').send({ name: 'Nope' }).expect(403);
    await asSignup('/api/auth/users/00000000-0000-4000-8000-000000000000', 'delete').expect(403);
    await asSignup('/api/auth/api-keys').expect(403);
    await asSignup('/api/audit').expect(403);
  });
});
