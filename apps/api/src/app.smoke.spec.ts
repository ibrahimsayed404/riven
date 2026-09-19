import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { PrismaService } from './infra/prisma/prisma.service';
import { SearchIndexBootstrap } from './infra/search/search-index.bootstrap';
import { SEARCH_SYNC_QUEUE } from './infra/search/search-sync.job';
import { BazaarAutocompleteProcessor } from './modules/bazaars/jobs/bazaar-autocomplete.processor';
import { BazaarJobsService } from './modules/bazaars/jobs/bazaar-jobs.service';
import { OrdersExpiryProcessor } from './modules/orders/jobs/orders-expiry.processor';
import { ORDERS_QUEUE, OrdersJobsService } from './modules/orders/jobs/orders-jobs.service';
import { SearchSyncProcessor } from './modules/search/jobs/search-sync.processor';

/**
 * Boots the REAL HTTP stack — Express, helmet, CORS, the global throttler,
 * validation pipe, exception filter, guards, every controller — and makes real
 * requests. Only the things that need an external service are stubbed:
 * Prisma (no database), the three BullMQ queues and their processors (no
 * Redis). This is what proves the cross-cutting fixes over the wire when no
 * infrastructure is available; the e2e suite covers the data paths.
 */
describe('HTTP stack smoke test (no external services)', () => {
  let app: INestApplication;

  const prismaStub = {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    // Auth lookups: nobody exists, so credentials are always invalid.
    user: { findFirst: async () => null, findUnique: async () => null },
  };
  const queueStub = { add: jest.fn(), addBulk: jest.fn(), upsertJobScheduler: jest.fn(), close: jest.fn() };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prismaStub)
      .overrideProvider(getQueueToken('bazaars')).useValue(queueStub)
      .overrideProvider(getQueueToken(ORDERS_QUEUE)).useValue(queueStub)
      .overrideProvider(getQueueToken(SEARCH_SYNC_QUEUE)).useValue(queueStub)
      .overrideProvider(BazaarAutocompleteProcessor).useValue({})
      .overrideProvider(OrdersExpiryProcessor).useValue({})
      .overrideProvider(SearchSyncProcessor).useValue({})
      .overrideProvider(BazaarJobsService).useValue({})
      .overrideProvider(OrdersJobsService).useValue({})
      .overrideProvider(SearchIndexBootstrap).useValue({ ready: false, ensureReady: async () => undefined })
      .compile();

    app = ref.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('applies the configured trust-proxy setting to Express (P0-01)', async () => {
    // Which client address the rate limiter sees is decided by this setting.
    // .env.example ships it unset, so the default must stay false: X-Forwarded-For
    // ignored, req.ip = the socket. Anything else here would mean a header the
    // client controls had started deciding rate-limit identity.
    const expressApp = app.getHttpAdapter().getInstance() as { get(setting: string): unknown };
    expect(expressApp.get('trust proxy')).toBe(false);
  });

  it('serves /health with helmet headers and throttler headers (VULN-01, VULN-02)', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('CORS allows only the configured origins (VULN-02)', async () => {
    const allowed = await http()
      .options('/health')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await http()
      .options('/health')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('errors are the flat { code, message } body — no envelope (API-01)', async () => {
    const res = await http().get('/users/me').expect(401);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('error');
  });

  it('validation failures are 400 VALIDATION_ERROR with a message array', async () => {
    const res = await http().post('/auth/login').send({ email: 'not-an-email' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.message)).toBe(true);
  });

  it('unbounded pagination is rejected before it reaches the database (API-02)', async () => {
    const big = await http().get('/products?limit=1000').expect(400);
    expect(big.body.code).toBe('VALIDATION_ERROR');
    const nan = await http().get('/products?limit=abc').expect(400);
    expect(nan.body.code).toBe('VALIDATION_ERROR');
    const zero = await http().get('/products?page=0').expect(400);
    expect(zero.body.code).toBe('VALIDATION_ERROR');
  });

  it('the Paymob webhook is reachable at its single route and refuses an unsigned body (PLAN-02, PAY-02)', async () => {
    const res = await http().post('/webhooks/paymob').send({ obj: { success: true, id: 1 } }).expect(401);
    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_MISSING');
    // @SkipThrottle: no rate-limit headers on this route.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('admin routes are closed to anonymous callers', async () => {
    await http().get('/admin/overview').expect(401);
    await http().get('/admin/vendors').expect(401);
    await http().get('/admin/audit-log').expect(401);
  });

  it('login is throttled to 10/min per source and the 11th attempt is a coded 429 with Retry-After (VULN-01)', async () => {
    const attempt = () => http().post('/auth/login').send({ email: 'someone@example.com', password: 'Password1' });

    // Earlier tests already spent attempts on this route; the header says how many are left.
    const first = await attempt();
    expect(first.status).toBe(401);
    expect(first.body.code).toBe('INVALID_CREDENTIALS');
    expect(first.headers['x-ratelimit-limit']).toBe('10');
    const remaining = Number(first.headers['x-ratelimit-remaining']);
    expect(remaining).toBeGreaterThanOrEqual(0);

    for (let i = 0; i < remaining; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
