# Riven API — pre-launch production readiness audit

**Generated:** 2026-09-19T17:37:01Z
**Baseline:** `main` @ `a4009e3` (clean working tree, nothing uncommitted)
**Scope:** `apps/api` — 171 source files + 39 spec files, 26 controllers, **97 HTTP routes** + `/health`, 16 modules
**Method:** read-only pass over entry point, config, every controller/service/repository, schema, migrations, jobs, CI and compose. Every finding below was grep-verified against the existing protections (global pipe, guards, filter, DB constraints) before being written down.

## 1. Verdict

**Not ship-ready — but close.** One P0, ten P1, fifteen P2. There is no broken object-level authorization, no injection, no plaintext or weak password storage, and no unprotected mutating route anywhere in the 97; the security work from the 2026-09-19 fix sweep held up under adversarial re-reading. What blocks launch is a deployment-shaped defect: the rate limiter cannot tell one anonymous caller from another once the API sits behind a reverse proxy, which turns the 10/min login limit into a platform-wide lockout an attacker can trigger with ten requests. The P1s are the usual pre-traffic set — three list endpoints that never got the shared pagination DTO, an outbound HTTP call with no timeout, no graceful shutdown, and two money-path assumptions that have still never met a real Paymob payload.

| Severity | Count | Meaning |
|---|---|---|
| **P0** | 1 | Exploitable / data-destroying / process-breaking. Blocks launch. |
| **P1** | 10 | Will cause real incidents as traffic arrives. |
| **P2** | 15 | Maintainability and consistency. Capped at the 15 most useful. |

## 2. P0 findings

### P0-01 — Rate limiting keys every anonymous request by the proxy's IP, so ten requests lock out login for everyone

| | |
|---|---|
| **Status** | **Mechanism fixed** `3a7ec6b` — the value is still a deployment decision |
| **Files** | `apps/api/src/app.setup.ts:11-25` · `apps/api/src/common/guards/user-throttler.guard.ts:15-19` · `apps/api/src/modules/auth/auth.controller.ts:39-43` |
| **Effort** | ~15 min |
| **Risk of the fix** | Low — one line, but it changes how every client IP is derived, so it needs a deliberate value (see below), not a blind `true`. |

`configureApp` installs helmet, CORS, the pipe and the filter, and never touches Express's `trust proxy` setting, which defaults to **false**:

```ts
// app.setup.ts:11-25
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);
  app.use(helmet());
  const corsOrigins = configService.get<string[]>('CORS_ORIGINS') ?? [];
  app.enableCors({ origin: corsOrigins, credentials: true, ... });
```

The throttler keys unauthenticated callers off that value:

```ts
// user-throttler.guard.ts:15-19
protected async getTracker(req: RequestLike): Promise<string> {
  if (req.user?.id) return `user:${req.user.id}`;
  const ip = req.ips?.length ? req.ips[0] : req.ip;
  return `ip:${ip ?? 'unknown'}`;
}
```

With `trust proxy` off, `req.ips` is always empty and `req.ip` is the **socket** address — the load balancer, ingress or Cloudflare node, identical for every anonymous user. `X-Forwarded-For` is ignored.

**How this breaks in production:** deployed behind any reverse proxy (nginx, an ALB, Render/Railway/Fly's router, Cloudflare), one attacker sends eleven `POST /auth/login` requests in a minute; the eleventh trips `@Throttle({ default: { limit: 10, ttl: 60_000 } })` for the shared `ip:<proxy>` bucket, and **every other user's login and registration returns 429 for the rest of that window** — repeatable indefinitely at eleven requests a minute. The same bucket also governs the 300/min global default, so all anonymous browsing, search and discovery traffic shares one counter and starts 429-ing at real traffic levels with no attacker at all.

**The fix:** enable proxy trust to exactly the depth of the real deployment — `app.getHttpAdapter().getInstance().set('trust proxy', <n hops or the proxy CIDR>)` in `configureApp`, driven by a config value rather than hardcoded `true`. `trust proxy = true` blindly trusts a client-supplied `X-Forwarded-For` and lets an attacker forge a fresh key per request, which is the opposite failure; the hop count or CIDR form is the safe one. No change to the guard is needed once `req.ips` is populated.

## 2b. Added after the first fix session — N-01

### N-01 — The rate limiter keyed every request by IP, because its `user:` branch could never run

| | |
|---|---|
| **Status** | **Fixed** `e646c12` |
| **Files** | `apps/api/src/common/guards/user-throttler.guard.ts:15-19` (before the fix) · `apps/api/src/modules/auth/auth.module.ts:33` |
| **Found** | 2026-09-19, while verifying P0-01 — not part of the original audit |

`UserThrottlerGuard` is registered as `APP_GUARD` (`app.module.ts:74`), while `JwtAuthGuard` is applied at controller or handler level everywhere. Nest assembles guards as `[...global, ...class, ...method]` (`@nestjs/core/helpers/context-creator.js:11-15`) and runs them in that order (`guards/guards-consumer.js:14`), so **the throttler always ran before authentication** and `req.user` was undefined every time `getTracker` was called. Combined with the dead `req.ips` branch (P2-10), both non-IP branches were unreachable and every limit on every route was per-IP.

This contradicted what three code comments and the previous fix-sweep report (ROBUST-01) claimed was fixed behaviour.

**What was actually broken in production terms:** the `@Throttle({ limit: 1, ttl: 60_000 })` on `PATCH /users/me/location` and `PATCH /vendors/me/location` applied per IP, so two users behind one NAT — or a carrier-grade NAT, which is normal on Egyptian mobile networks — blocked each other. And because the throttler runs before authentication, an **unauthenticated** caller could spend that bucket: the request is counted, then rejected 401. Under P0-01 (a proxy in front), both collapse further to one location update per minute platform-wide.

**Fix:** the guard resolves the caller from the bearer token itself, verifying the signature rather than decoding it — an unverified `sub` would let anyone mint a fresh bucket per request with a forged token, which is a worse failure than the one being fixed. A missing, malformed, forged or expired token falls back to the IP tracker. No authentication or authorization decision moved; `JwtAuthGuard` still owns that. `AuthModule` exports `JwtModule` so the guard declared in `AppModule` can resolve the already-configured `JwtService`.

**Verification:** `user-throttler.guard.spec.ts` (6 cases) pins the behaviour, including that a forged or expired token does *not* get its own bucket. The spec was checked against the old tracker by reverting the single line — 2 of 6 fail — so it genuinely covers the regression. `app.smoke.spec.ts` boots the real `AppModule` and passes, which is what proves the DI wiring.

**Still open around it:** P0-01 (client IP derivation) and P1-01 (per-process storage) are unchanged; N-01 shares a root cause with P0-01 and the two should be reasoned about together.

## 3. P1 findings

| ID | Finding | Location | Status |
|---|---|---|---|
| P1-01 | Throttler storage is per-process memory | `app.module.ts:50` | Pending |
| P1-02 | Hand-parsed pagination: unbounded `limit`, `NaN` into raw SQL | `organizer-bazaars.controller.ts:39-42,92-96` · `vendor-bazaar-applications.controller.ts:36-40` | **Fixed** `e22fc61` |
| P1-03 | Public `GET /bazaars` has no maximum page size | `list-bazaars-query.dto.ts:14-18` | **Fixed** `ff3da73` |
| P1-04 | `?status=` cast to an enum with no validation → 500 | `organizer-bazaars.controller.ts:94` · `vendor-bazaar-applications.controller.ts:38` | **Fixed** `e22fc61` |
| P1-05 | Paymob HTTP call has no timeout | `paymob.service.ts:84-91` | **Fixed** `68b4483` |
| P1-06 | No graceful shutdown: hooks never enabled | `main.ts:7-13` | **Fixed** `3ae1bfe` |
| P1-07 | Catalogue search is an unindexed `ILIKE '%…%'` scan | `products.repository.ts:84-89` | Pending |
| P1-08 | Presigned upload URL has no size cap | `storage.service.ts:46-50` | Pending |
| P1-09 | Checkout expiry cancels groups with a live payment intention | `orders.repository.ts:137-149` | Pending |
| P1-10 | Webhook falls back to matching `order.id` against `paymobIntentId` | `checkout.repository.ts:139-144` | Pending |

### P1-01 — Throttler storage is per-process memory

```ts
// app.module.ts:50
ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
```

No `storage` is configured, so `@nestjs/throttler` uses its in-memory service (the guard's own comment says so: `user-throttler.guard.ts:9-12`). Every limit is therefore *per instance* and is lost on restart. Two API replicas mean 20 login attempts a minute, not 10; a rolling deploy resets every counter. **Fix:** a Redis storage backed by the existing `REDIS_URL` (a new dependency — needs approval). **Effort:** ~1 h. **Risk:** medium — it puts Redis on the request path for every request; a Redis outage must degrade to "allow", not "500".

### P1-02 — Hand-parsed pagination: unbounded `limit`, `NaN` into raw SQL

```ts
// organizer-bazaars.controller.ts:36-43
@Get('bazaars')
getBazaars(
  @CurrentUser('id') ownerId: string,
  @Query('page') page: string = '1',
  @Query('limit') limit: string = '10',
) {
  return this.bazaarsService.getMyBazaars(ownerId, parseInt(page, 10), parseInt(limit, 10));
}
```

Three routes do this (`GET /organizers/me/bazaars`, `GET /organizers/me/bazaars/:id/applications`, `GET /vendors/me/bazaar-applications`) while every other list route uses `PaginationQueryDto` (`page ≥ 1`, `1 ≤ limit ≤ 100`). The values land in raw SQL — `LIMIT ${limit} OFFSET ${offset}` (`bazaars.repository.ts:139`) — with no bound and no numeric check. `?limit=abc` makes both `NaN`, `?page=0` makes the offset negative, `?limit=500000` returns the caller's entire history in one response. **Fix:** extend `PaginationQueryDto` in these three handlers, exactly as `ListOrdersQueryDto` does. **Effort:** ~20 min. **Risk:** low, but it is a contract change (out-of-range values become 400 instead of silently working) — confirm before applying.

### P1-03 — Public `GET /bazaars` has no maximum page size

```ts
// list-bazaars-query.dto.ts:14-18
@IsOptional()
@Type(() => Number)
@IsNumber()
@Min(1)
limit?: number;
```

`@Max` is missing (compare `PaginationQueryDto`, which caps at 100). The value flows into `findPublicPaginated`'s raw `LIMIT` (`bazaars.repository.ts:193`). An unauthenticated `GET /bazaars?limit=1000000` serialises every published bazaar in one response; repeated under the shared throttle bucket it is a cheap memory-pressure lever. **Fix:** `@Max(MAX_PAGE_SIZE)` on `limit`, or extend `PaginationQueryDto`. **Effort:** ~5 min. **Risk:** low.

### P1-04 — `?status=` cast to an enum with no validation

```ts
// organizer-bazaars.controller.ts:92-96
@Query('status') status?: ApplicationStatus,
) {
  return this.bazaarsService.getBazaarApplications(ownerId, bazaarId, parseInt(page, 10), parseInt(limit, 10), status);
}
```

The TypeScript annotation is not a runtime check; `?status=DROP` reaches `where.applicationStatus` in Prisma (`bazaars.repository.ts:472-475`) and raises a client validation error, which `AllExceptionsFilter` reports as a 500 with a stack trace in the logs. This is the same defect `ListOrdersQueryDto` was fixed for ("was a raw string cast to OrderStatus … and 500'd"). **Fix:** `@IsEnum(ApplicationStatus)` on a query DTO. **Effort:** folded into P1-02. **Risk:** low.

### P1-05 — Paymob HTTP call has no timeout

```ts
// paymob.service.ts:84-91
const response = await fetch(this.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Token ${this.apiKey}` },
  body: JSON.stringify(payload),
});
```

`fetch` has no `AbortSignal` and Node applies no default request timeout. If Paymob accepts the connection and stalls, `POST /checkout` never returns: the shopper's orders already exist with stock decremented (`checkout.repository.ts:97-108`), the HTTP request holds a connection until the client gives up, and the order group sits with no intention. Under a Paymob incident this stacks up across concurrent checkouts. **Fix:** `AbortSignal.timeout(10_000)` on the call; the existing `catch` already converts a failure into `paymentSetupFailed: true`, which the client can retry. **Effort:** ~10 min. **Risk:** low.

### P1-06 — No graceful shutdown

```ts
// main.ts:7-13
const app = await NestFactory.create(AppModule, { rawBody: true });
configureApp(app);
const port = app.get(ConfigService).getOrThrow<number>('PORT');
await app.listen(port);
```

`app.enableShutdownHooks()` is never called, and Nest's shutdown hooks are opt-in. On SIGTERM (every deploy, every container reschedule) the process exits without running `PrismaService.onModuleDestroy` (`prisma.service.ts:10-12`) or letting BullMQ drain — so a `SearchSyncProcessor` or `OrdersExpiryProcessor` job can be killed mid-run and connections are dropped rather than closed. **Fix:** `app.enableShutdownHooks()` before `listen`. **Effort:** ~5 min. **Risk:** low — worth one deploy-time smoke test, since it changes shutdown timing.

### P1-07 — Catalogue search is an unindexed `ILIKE '%…%'` scan

```ts
// products.repository.ts:84-89
if (params.search) {
  where.OR = [
    { title: { contains: params.search, mode: 'insensitive' } },
    { description: { contains: params.search, mode: 'insensitive' } },
  ];
}
```

`contains` compiles to `ILIKE '%term%'`, which no btree index can serve; `schema.prisma` has indexes only on `vendorId` and `categoryId` for `products`, and no `pg_trgm` extension is enabled in any migration. Every `GET /products?search=` is a sequential scan plus a `count` over the same predicate, run inside a transaction with the page query. It is fine at a few hundred products and a visible latency cliff at tens of thousands. **Fix:** either point this endpoint at Meilisearch (already indexed and live at `GET /search/products`) or add a `pg_trgm` GIN index — the latter is a migration and needs approval. **Effort:** ~1 h. **Risk:** medium (behaviour or schema change either way).

### P1-08 — Presigned upload URL has no size cap

```ts
// storage.service.ts:46-50
const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
const uploadUrl = await getSignedUrl(this.client, command, {
  expiresIn: UPLOAD_URL_TTL_SECONDS,
  signableHeaders: new Set(['content-type']),
});
```

Content-Type is signed, so the image allowlist holds — but nothing bounds the object size. Any verified vendor or organizer can request a URL (`media.controller.ts:11-23`) and PUT an object of arbitrary size to the bucket, repeatedly, at 300 requests/min. **Fix:** a presigned POST policy with `content-length-range`, or enforce a maximum object size at the bucket/CDN. **Effort:** ~1–2 h. **Risk:** medium — changes the upload contract the clients use, so it needs a decision before it is written.

### P1-09 — Checkout expiry cancels groups with a live payment intention

```ts
// orders.repository.ts:137-149
where: {
  createdAt: { lt: olderThan },
  paymobTransactionId: null,
  orders: { some: { status: OrderStatus.PENDING }, none: { status: { not: OrderStatus.PENDING } } },
},
```

The sweep runs every 5 minutes and expires anything older than `CHECKOUT_PENDING_TTL_MINUTES` (default 60). It excludes groups that have *already been paid* (`paymobTransactionId: null`) but not groups with an intention still open at Paymob — and `paymobIntentId` is set within milliseconds of checkout for every group. A shopper who leaves the Paymob page open and pays at minute 61 is charged for a group whose orders are all `CANCELLED`; `OrderPaymentHandler` then records the outcome as `orphan` and logs "recorded for manual refund" (`order-payment.handler.ts:114-118`). Real money, a manual refund, and an unhappy customer — and nothing alerts beyond a log line. **Fix:** this is a product decision, not a code fix — set the TTL above Paymob's intention lifetime, and/or add an alert on the `orphan` / `double_payment` log outcomes. **Effort:** decision first. **Risk:** n/a until decided. **Flagged for Ibrahim.**

### P1-10 — Webhook falls back to matching `order.id` against `paymobIntentId`

```ts
// checkout.repository.ts:139-144
findGroupByPaymobOrderId(paymobOrderId: string): Promise<OrderGroupWithOrders | null> {
  return this.prisma.orderGroup.findFirst({
    where: { OR: [{ paymobOrderId }, { paymobIntentId: paymobOrderId }] },
    include: { orders: { include: { items: true } } },
  });
}
```

The primary match (signed `order.id` → `paymobOrderId`) is correct. The fallback compares the same signed value against `paymobIntentId`, which is a different Paymob identifier space (`paymob.service.ts:101-105`, itself annotated "field name unverified against a real sandbox response"). If the two spaces ever overlap numerically, a payment is attributed to the wrong order group; the amount check (`order-payment.handler.ts:87`) is the only thing standing between that and marking a stranger's orders PAID. **Fix:** confirm both field names against one real sandbox payload, then drop the fallback (or restrict it to rows created before `paymobOrderId` existed). **Effort:** blocked on sandbox credentials. **Risk:** n/a. **Flagged — this is the one money-path assumption the codebase has never verified, and CLAUDE.md already says so.**

## 4. P2 findings

| ID | Finding | Location | Status |
|---|---|---|---|
| P2-01 | Bare-string throw — client sees `HTTP_ERROR`, not a code | `booths.service.ts:128` | **Fixed** `8d5c4da` |
| P2-02 | Thinking-out-loud comment left in the assign path | `booths.service.ts:123-125` | **Fixed** `32f203a` |
| P2-03 | `updateMyProfile` takes `Prisma.OrganizerUpdateInput`, far wider than the DTO it is given | `organizers.service.ts:29` | **Fixed** `22a542a` |
| P2-04 | `visibilityFilter` getter is marked `@deprecated` and still called | `products.repository.ts:60-63,163` | **Fixed** `ff49e8f` |
| P2-05 | `decodeCursor` accepts any string as a date; `new Date('x')` reaches Prisma | `social.service.ts:205` | **Fixed** `8e1222c` |
| P2-06 | Empty cart faked with `id: ''` and an `as CartWithItems` cast | `cart.service.ts:12-17` | **Skipped** |
| P2-07 | `getMyProducts` carries TS default args the controller already supplies, plus stray indentation | `vendors.service.ts:213` | **Fixed** `d0c1955` |
| P2-08 | Four services rebuild the `meta` object inline instead of calling `pageMeta` | `vendors.service.ts:113-121` · `products.service.ts:49-57` · `users.service.ts:133-141` · `audit.service.ts:35-38` | Pending |
| P2-09 | `dto.gridConfig as any` twice, discarding the validated type | `admin-booths.controller.ts:21,31` | **Fixed** `e4d7ba2` |
| P2-10 | Both non-IP branches of `getTracker` were unreachable — `req.user` (guard order) and `req.ips` (trust proxy) | `user-throttler.guard.ts:17` | **Fixed** by N-01 `e646c12` + P0-01 `3a7ec6b` |
| P2-11 | `boothListingId` validated as `@IsString()` where every other id is `@IsUUID()` | `assign-booth.dto.ts:4-5` | **Fixed** `adcd8c2` |
| P2-12 | `UpdateBoothLayoutDto` duplicates `CreateBoothLayoutDto` field for field | `update-booth-layout.dto.ts:1-9` | **Fixed** `55f5d8d` |
| P2-13 | Layout lives at two unrelated paths: `bazaars/:id/layout` (public) and `admin/bazaars/:id/layout` | `public-booths.controller.ts:4` · `admin-booths.controller.ts:13,19` | Pending |
| P2-14 | Meilisearch is v1.9 in compose, v1.12 in CI | `docker-compose.yml:47` · `.github/workflows/ci.yml` | Pending |
| P2-15 | Every list orders by `createdAt` with no index on it | `schema.prisma` (`products`, `orders`, `vendors`) | Pending |

## 5. What is already solid

- **Object-level authorization holds across all 97 routes.** Every owner-scoped handler re-checks ownership in the service, not just the role: cart item → cart (`cart.service.ts:60-68`), order → `userId`/`vendorId` (`orders.repository.ts:35-45,67-78`), product → `vendorId` (`vendors.repository.ts:249-260`), bazaar → `organizerId` (`bazaars.service.ts:49-58`), retry-payment → `group.userId` (`checkout.service.ts:107-109`), upload key → `userId` prefix (`media.service.ts:28`). I could not construct an ID-swap that reaches another account's data.
- **Credential and session handling is correct.** bcrypt at cost 12, refresh tokens stored only as SHA-256 hashes, rotation via a guarded `updateMany` that returns null on a lost race, reuse of a revoked token revokes the whole family, and every auth lookup filters `deletedAt` so a deactivated account cannot log in, refresh or pass `JwtStrategy.validate`.
- **The money path is genuinely careful.** Integer piastres end to end, `Decimal(12,2)` columns, HMAC verified with `crypto.timingSafeEqual` behind a length check, group selection only on Paymob-signed fields, one recorded transaction per group with a guarded `paymobTransactionId IS NULL` write that surfaces a second charge instead of overwriting it.
- **Multi-table writes are transactional and guarded.** Checkout, group cancel and the expiry sweep all run at `Serializable` with conditional status updates (`transitionOrderStatus`, `cancelPendingGroup`), stock reserve and release are two halves of one operation, and P2034 is retried rather than surfaced.
- **Input handling is disciplined.** Global `whitelist + forbidNonWhitelisted`, DTOs with real bounds on text length, array size, price precision and stock, `@IsEnum` on every enum that reaches Prisma (except P1-04), and every PostGIS query built from parameterised `$queryRaw` tagged templates — there is no string-concatenated SQL anywhere in the repository layer.

## 6. Fix Order

Easiest and lowest-risk first. Items marked **decide first** are not code fixes and should not be started without an answer.

| # | ID | Change | Files | Effort | Risk |
|---|---|---|---|---|---|
| 1 | P2-01 | Coded exception instead of a bare string | 1 | 2 min | none |
| 2 | P2-02 | Delete the stale comment | 1 | 2 min | none |
| 3 | P2-11 | `@IsUUID()` on `boothListingId` | 1 | 2 min | very low |
| 4 | P1-03 | `@Max` on the public bazaar list `limit` | 1 | 5 min | low |
| 5 | P1-06 | `app.enableShutdownHooks()` | 1 | 5 min | low |
| 6 | P1-05 | `AbortSignal.timeout` on the Paymob call | 1 | 10 min | low |
| 7 | P2-04 | Drop the deprecated `visibilityFilter` getter | 1 | 10 min | low |
| 8 | P2-05 | Reject an unparseable cursor date | 1 | 10 min | low |
| 9 | P2-03 | Narrow `updateMyProfile`'s parameter type | 1 | 10 min | low |
| 10 | P2-08 | Use `pageMeta` in the four services that inline it | 4 | 20 min | low — **4 files, confirm first** |
| 11 | P1-02 + P1-04 | Move the three hand-parsed routes onto a validated query DTO | 3 | 30 min | low — **contract change, confirm first** |
| 12 | **P0-01** | Configure `trust proxy` from config | 2 | 15 min | low — **needs the real proxy topology** |
| 13 | P1-01 | Redis-backed throttler storage | 2 | 1 h | medium — **new dependency, needs approval** |
| 14 | P1-08 | Size-capped upload URLs | 2+ | 1–2 h | medium — **upload contract change** |
| 15 | P1-07 | Index or re-route catalogue search | 2+ | 1 h | medium — **migration or behaviour change** |
| 16 | P2-15 | `createdAt` indexes | migration | 20 min | medium — **migration, needs approval** |
| 17 | P1-09 | Checkout TTL vs Paymob intention lifetime | — | — | **decide first (Ibrahim)** |
| 18 | P1-10 | Verify Paymob field names against a sandbox payload | — | — | **decide first — blocked on credentials** |
| 19 | P2-06, P2-07, P2-09, P2-10, P2-12, P2-13, P2-14 | Remaining cleanups | various | ~1 h | low |

## 7. Fix session — 2026-09-19

Branch `fix/pre-launch-audit` off `a4009e3`. One commit per finding, in the Fix Order above. After every commit: `tsc --noEmit` on both tsconfigs, `eslint .`, and the full unit suite.

**Checks at the end of the session:** typecheck exit 0 · lint **0 errors** (123 warnings, all pre-existing `no-explicit-any`, down from 125) · **28 suites / 284 tests passing**.

### Fixed (12 findings, 12 commits)

| ID | Commit | What changed |
|---|---|---|
| P2-01 | `8d5c4da` | The last bare-string throw now carries `APPLICATION_BAZAAR_MISMATCH`. |
| P2-02 | `32f203a` | Working-it-out comment in `assignBooth` replaced with one line of intent. |
| P2-11 | `adcd8c2` | `boothListingId` validated as `@IsUUID()`. |
| P1-03 | `ff3da73` | `@Max(MAX_PAGE_SIZE)` on the public bazaar list; `?limit=1000000` is a 400, not a full dump. |
| P1-06 | `3ae1bfe` | `app.enableShutdownHooks()` in `main.ts` (not in the test-shared `configureApp`). |
| P1-05 | `68b4483` | `AbortSignal.timeout(10_000)` on the Paymob intention call. |
| P2-04 | `ff49e8f` | Deprecated `visibilityFilter` getter and its last caller removed; where clause provably unchanged. |
| P2-05 | `8e1222c` | A cursor whose timestamp will not parse is `INVALID_CURSOR`, not a 500. |
| P2-03 | `22a542a` | `updateMyProfile` typed `{ name?: string }` instead of the whole update input. |
| P1-02 + P1-04 | `e22fc61` | The three hand-parsed list routes moved to `PaginationQueryDto` + `@IsEnum`; default page size deliberately kept at 10. |
| P2-07 | `d0c1955` | `getMyProducts` signature de-duplicated and re-indented. |
| P2-12 | `55f5d8d` | `UpdateBoothLayoutDto extends CreateBoothLayoutDto`. |
| P2-09 | `e4d7ba2` | `as any` casts on `gridConfig` removed; the validated type now reaches the service. |

One fix broke the build mid-session and was corrected before commit: removing the `ApplicationStatus` import from `organizer-bazaars.controller.ts` (P1-02) orphaned the accept/reject handlers. Caught by typecheck, fixed, re-verified.

### Skipped

- **P2-06** — every honest fix for the faked empty cart (`id: ''`) changes the response body or starts persisting a cart row on read. Not a silent cleanup; leaving it alone.

### Still open, and why

| ID | Why it is still open |
|---|---|
| **P0-01** | Needs the real production topology — how many proxy hops, or which CIDR to trust. `trust proxy = true` is worse than the bug: it lets an attacker forge a fresh rate-limit key per request with a spoofed `X-Forwarded-For`. **Blocked on an answer, not on work.** |
| P1-01 | Redis-backed throttler storage is a new dependency. |
| P1-07 | Either a `pg_trgm` migration or re-pointing the endpoint at Meilisearch — schema or behaviour change. |
| P1-08 | Capping upload size changes the upload contract the clients use. |
| P1-09 | Product decision: checkout TTL versus Paymob intention lifetime, plus whether `orphan` / `double_payment` log outcomes should alert. **For Ibrahim.** |
| P1-10 | Blocked on a real Paymob sandbox payload; nothing to verify against locally. |
| P2-08 | Four files — over the three-file limit for a single fix. |
| P2-10 | Both non-IP branches of `getTracker` were unreachable — `req.user` (guard order) and `req.ips` (trust proxy) | `user-throttler.guard.ts:17` | **Fixed** by N-01 `e646c12` + P0-01 `3a7ec6b` |
| P2-13 | Would move a route path. |
| P2-14, P2-15 | Environment drift and an index migration. |

### For manual review

1. **The `trust proxy` value in P0-01** is the one decision I could not make from the code. Everything about the rate limiter's correctness depends on it.
2. **The e2e suite has still not run here** — no Postgres/PostGIS on this machine, so `test:e2e` and `prisma migrate deploy` remain unexercised, exactly as the previous report recorded. CI is where P1-02's contract change gets its first real HTTP exercise; two e2e specs (`booths.e2e.spec.ts`, `social.e2e.spec.ts`) touch the routes I changed.
3. **P1-02 changed request validation on three routes.** Out-of-range `?page`/`?limit` and unknown `?status` values are now 400s. If any dashboard currently sends `?limit=0` or a lowercase status, it will start failing — worth a grep of the front-end before merging.
4. **`.env` was created locally from `.env.example`** so the HTTP smoke test could boot; it is gitignored and not part of the branch. A repo-local `git config user.name/user.email` was also set, since this machine had no git identity.

## 8. Fix session addendum — N-01

`e646c12` — `fix(N-01): key rate limits by user again, not by IP`. Three files: the guard, its new spec, and `auth.module.ts` (one line, exporting `JwtModule`).

Checks: typecheck exit 0 · lint **0 errors** (123 warnings, unchanged) · **29 suites / 290 tests passing** (up from 28/284 — the six new guard cases). `app.smoke.spec.ts` boots the real `AppModule` and still passes, which is what verifies the dependency-injection change.

This was found during the reviewer-facing investigation of P0-01, not during the original audit pass. It is worth noting *why* the original audit missed it: the guard reads `req.user?.id`, which looks correct in isolation, and the bug lives in Nest's guard **ordering** — visible only by reading `@nestjs/core`'s context creator, not the application code. No test covered the claimed per-user behaviour, so nothing failed.

Two things for the reviewer:

1. **P0-01 is still open and still needs the proxy topology.** N-01 fixed *who* gets a bucket; P0-01 is about whether the IP fallback identifies anything real. Authenticated traffic is now keyed correctly regardless of proxy configuration, which meaningfully reduces P0-01's blast radius — but `POST /auth/login` is unauthenticated by definition, so the login-lockout scenario is untouched.
2. **The per-user limits are now real for the first time.** `PATCH /users/me/location` genuinely enforces one update per minute per user. If any client polls location more often than that and was previously getting away with it on a shared IP bucket, it will now see 429s. Worth checking the mobile app's location cadence before this reaches production.

## 9. Fix session addendum — P0-01

`3a7ec6b` — `fix(P0-01): derive req.ip from a configured trust-proxy setting`. Three files: `env.validation.ts`, `app.setup.ts`, `.env.example`.

Checks: typecheck exit 0 · `check:env` ok (13 required, 9 optional) · lint **0 errors** · **29 suites / 290 tests passing**.

### What was done, and what deliberately was not

The missing information was never *how* to fix this — it was **which value is correct for this deployment**, and that is not a fact about the code. So the mechanism now exists and reads from config, with the default preserving today's behaviour exactly. `TRUST_PROXY` unset or empty parses to `false`, so **this commit changes no runtime behaviour until somebody sets it**.

`true` is refused at boot. That is a deliberate guardrail, not an oversight: it trusts the entire `X-Forwarded-For` chain including the portion the client wrote, so any caller can forge a fresh rate-limit identity per request. That converts a denial-of-service into a full bypass — strictly worse than the bug. A hop count or CIDR list expresses the same intent without the hole.

### Evidence, measured rather than asserted

Against the installed express 5.2.1, sending `X-Forwarded-For: 203.0.113.7, 10.0.0.9` over a real socket:

| `trust proxy` | `req.ip` | `req.ips` |
|---|---|---|
| unset / `false` | `127.0.0.1` (the socket) | `[]` |
| `1` | `10.0.0.9` | `["10.0.0.9"]` |
| `2` | `203.0.113.7` | `["203.0.113.7","10.0.0.9"]` |
| `true` | `203.0.113.7` — written entirely by the client | `["203.0.113.7","10.0.0.9"]` |

This also shows why the number must match reality: with exactly one real proxy, `1` yields the true client address, while `2` would hand an attacker control of the value.

`validateEnv` checked directly: unset → `false`, `""` → `false`, `"false"` → `false`, `"1"` → `1`, `"10.0.0.0/8, loopback"` → `["10.0.0.0/8","loopback"]`, `"true"` and `"TRUE"` → boot failure.

### Still required from the infrastructure owner

**One value.** What is in front of the Node process in production, and how many of those hops are ours — and does the outermost one overwrite `X-Forwarded-For` rather than appending to what the client sent? Until `TRUST_PROXY` is set in the production environment, the original defect is still live in production even though the code is now capable of fixing it. **This is a deploy-time task, not a code task, and it should not be marked done when the branch merges.**

### Not covered by a test

No automated test asserts that `configureApp` applies the setting. Adding one means touching `app.smoke.spec.ts`, which would have made this a four-file change, over the limit you set. The Express behaviour above is verified empirically and the env parsing is verified directly, but the wiring between them rests on review. Worth adding when convenient.
