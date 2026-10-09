import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { User } from './../src/modules/tenancy/entities/user.entity';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { Webhook } from './../src/modules/webhook/entities/webhook.entity';
import { AuthService } from './../src/modules/auth/auth.service';

/**
 * End-to-end proof of the private-sessions-per-account rule: a `users`-role account's login key owns
 * the sessions its dashboard creates and sees exactly those — never another account's, never an
 * orgmenu/API-minted (ownerless) session — while an operator's hand-minted key keeps the
 * pre-existing unrestricted view. This is the regression the live-DB amarnath@sir bug tracked.
 */
describe('Private sessions per account (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;
  let sessionRepo: Repository<Session>;
  let webhookRepo: Repository<Webhook>;
  let authService: AuthService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    userRepo = app.get(getRepositoryToken(User, 'main'));
    sessionRepo = app.get(getRepositoryToken(Session, 'data'));
    webhookRepo = app.get(getRepositoryToken(Webhook, 'data'));
    authService = app.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueEmail = (prefix: string): string => `${prefix}-${Date.now().toString(36)}@private.example`;

  async function signUp(email: string): Promise<{ apiKey: string; userId: string }> {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse' })
      .expect(201);
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-horse' });
    expect(login.status).toBe(200);
    const loginBody = login.body as { apiKey: string };
    const user = (await userRepo.findOne({ where: { email } })) as User;
    return { apiKey: loginBody.apiKey, userId: user.id };
  }

  const call = (apiKey: string, path: string, method: 'get' | 'post' = 'get', body?: unknown): request.Test => {
    const req = request(app.getHttpServer())[method](path);
    if (body !== undefined) req.send(body as never);
    return req.set('X-API-Key', apiKey);
  };

  async function mintOwnerlessOrgMenuKey(): Promise<string> {
    const { rawKey } = await authService.createApiKey({ name: 'e2e operator', role: ApiKeyRole.ORG_MENU });
    return rawKey;
  }

  it('lists for an account only the sessions it owns, and 401s on any other session', async () => {
    const a = await signUp(uniqueEmail('owner'));
    const adminKey = await mintOwnerlessOrgMenuKey();

    // One session owned by A (as its dashboard would create), one ownerless/orgmenu (operator-created).
    const ownedByA = (await sessionRepo.insert({ name: `owned-${Date.now().toString(36)}`, ownerUserId: a.userId }))
      .identifiers[0].id as string;
    const ownerless = (await sessionRepo.insert({ name: `ownerless-${Date.now().toString(36)}`, ownerUserId: null }))
      .identifiers[0].id as string;

    const list = await call(a.apiKey, '/api/sessions').expect(200);
    const ids = new Set((list.body as SessionResponseShape[]).map((s: SessionResponseShape) => s.id));
    expect(ids).toContain(ownedByA);
    expect(ids).not.toContain(ownerless);

    // The protected per-session surface: owned → 200, ownerless → 401 (and an orgmenu key → 200).
    await call(a.apiKey, `/api/sessions/${ownedByA}`).expect(200);
    await call(a.apiKey, `/api/sessions/${ownerless}`).expect(401);
    await call(adminKey, `/api/sessions/${ownedByA}`).expect(200);
    await call(adminKey, `/api/sessions/${ownerless}`).expect(200);

    // Aggregate stats the same: an account's overview counts only its own sessions.
    const stats = await call(a.apiKey, '/api/sessions/stats/overview').expect(200);
    expect((stats.body as { total: number }).total).toBe(1);
  });

  it('a session the account creates via POST /api/sessions is owned by it (and private from a second account)', async () => {
    const a = await signUp(uniqueEmail('creates'));
    const b = await signUp(uniqueEmail('peeker'));

    const created = await call(a.apiKey, '/api/sessions', 'post', { name: `mine-${Date.now().toString(36)}` });
    const createdBody = created.body as SessionResponseShape;

    const row = (await sessionRepo.findOne({ where: { id: createdBody.id } })) as Session;
    expect(row.ownerUserId).toBe(a.userId);

    // The creator lists it and can read its detail; the other account can neither list nor read it.
    const aList = await call(a.apiKey, '/api/sessions').expect(200);
    expect((aList.body as SessionResponseShape[]).some((s: SessionResponseShape) => s.id === createdBody.id)).toBe(
      true,
    );
    await call(a.apiKey, `/api/sessions/${createdBody.id}`).expect(200);

    const bList = await call(b.apiKey, '/api/sessions').expect(200);
    expect((bList.body as SessionResponseShape[]).some((s: SessionResponseShape) => s.id === createdBody.id)).toBe(
      false,
    );
    await call(b.apiKey, `/api/sessions/${createdBody.id}`).expect(401);
  });

  it('GET /api/webhooks for an account shows only webhooks of its own sessions', async () => {
    const a = await signUp(uniqueEmail('hook'));
    const adminKey = await mintOwnerlessOrgMenuKey();

    const ownedByA = (
      await sessionRepo.insert({ name: `hook-owned-${Date.now().toString(36)}`, ownerUserId: a.userId })
    ).identifiers[0].id as string;
    const ownerless = (
      await sessionRepo.insert({ name: `hook-ownerless-${Date.now().toString(36)}`, ownerUserId: null })
    ).identifiers[0].id as string;

    const ownedUrl = `https://owned.example/${Date.now().toString(36)}`;
    const ownerlessUrl = `https://ownerless.example/${Date.now().toString(36)}`;
    await webhookRepo.insert({ sessionId: ownedByA, url: ownedUrl });
    await webhookRepo.insert({ sessionId: ownerless, url: ownerlessUrl });

    const aHooks = await call(a.apiKey, '/api/webhooks').expect(200);
    const aUrls = (aHooks.body as WebhookShape[]).map((w: WebhookShape) => w.url);
    expect(aUrls).toContain(ownedUrl);
    expect(aUrls).not.toContain(ownerlessUrl);

    // The operator key is not account-scoped and keeps the full view.
    const adminHooks = await call(adminKey, '/api/webhooks').expect(200);
    const adminUrls = (adminHooks.body as WebhookShape[]).map((w: WebhookShape) => w.url);
    expect(adminUrls).toContain(ownedUrl);
    expect(adminUrls).toContain(ownerlessUrl);
  });
});

interface SessionResponseShape {
  id: string;
  name: string;
}

interface WebhookShape {
  id: string;
  sessionId: string;
  url: string;
}
