# 00 — Current Architecture Audit & Critical Issues Register

> Status: **DRAFT for review** · 2026-10-24 · Documentation stage, no code changed.
> *2026-10-27 (TD-21):* corrections of the Paymob-only issues (R2, R6, R9, R19, R20, R25) are scheduled for the **PAYMOB activation milestone**, not Phase 0 — PAYMOB is deferred, not rejected, and stays disabled in production so these code paths are unreachable meanwhile. Where an issue below says "Phase 0" for a Paymob-only path, read "PAYMOB activation".
> Scope: checkout, orders, inventory, Paymob, uploads, auth, audit, jobs — everything the payments / inventory / fulfilment / finance redesign touches.
> Method: read-only sweeps of `apps/api` and `D:\Youssef\Riven-App`, then the critical paths re-read by hand. Every claim cites `file:line` (paths relative to `apps/api/` unless stated). Line numbers are as of commit `76921ed`.
> Note: `scripts/demo-data.mjs` (cited in R1 and TD-08) was an uncommitted file in the working tree when this audit started; it is no longer present. The finding stands — nothing in the committed code moves an order to PAID except the Paymob webhook.

---

## 1. What exists today

### 1.1 Modules involved

| Area | Location | Notes |
|---|---|---|
| Checkout | `src/modules/checkout/` | `POST /checkout`, `POST /checkout/:orderGroupId/retry-payment` (SHOPPER) |
| Paymob webhook handler | `src/modules/checkout/order-payment.handler.ts` | Registered with the dispatcher as `order-groups` |
| Paymob infra | `src/infra/paymob/` | `POST /webhooks/paymob`, HMAC, dispatcher, intention client |
| Orders | `src/modules/orders/` | shopper / vendor / admin controllers, expiry job (`jobs/`) |
| Stock | `ProductVariant.stockQuantity` | written by vendors, checkout, cancel — no inventory module |
| Uploads | `src/modules/media/`, `src/infra/storage/` | presigned S3 PUT, public URLs only |
| Audit | `src/modules/audit/` | `AdminAuditLog`, best-effort after commit |
| Auth | `src/modules/auth/` | JWT access + rotating refresh tokens, 4 roles |
| Not present | — | payments module (manual), inventory, shipments, couriers, COD, ledger, settlements, returns, refunds, outbox, notifications, correlation ids, OpenAPI, API versioning |

### 1.2 Models and relationships (relevant subset, `prisma/schema.prisma`)

| Model | Lines | Key facts |
|---|---|---|
| `OrderGroup` | 652-671 | `userId` (Restrict); `paymobIntentId?`, `paymobOrderId?` (both indexed), `paymobTransactionId? @unique`, `paidAmountCents Int?`, `paidAt?`, `createdAt`. **No status, no payment method, no address, no shipping fee, no currency, no expiry.** |
| `Order` | 674-694 | one per vendor per group; `status OrderStatus @default(PENDING)`; `subtotal Decimal(12,2)`; FKs Restrict; indexes `[userId]`, `[vendorId, status]` |
| `OrderItem` | 696-711 | `titleSnapshot`, `priceSnapshot Decimal(12,2)`, `quantity`; FKs Restrict |
| `Product` | 299-325 | `isActive`, `deletedAt` soft delete |
| `ProductVariant` | 327-346 | `sku @unique`, `priceOverride?`, **`stockQuantity Int @default(0)`** (336), `deletedAt?` — **no CHECK constraint** |
| `CartItem` | 636-649 | `@@unique([cartId, variantId])` |
| `Payment`, `Subscription` | 590-620 | defined for fees/subscriptions, **unused by any code** |
| `AdminAuditLog` | 568-584 | `actorId` required (admin), `action`, `targetType`, `targetId`, `reason?` |
| `RefreshToken` | 233-245 | `tokenHash @unique`, `expiresAt`, `revokedAt?` — no session / device / family id |
| `Notification` | 546-559 | defined, unused |

Enums: `OrderStatus { PENDING PAID FULFILLED SHIPPED DELIVERED CANCELLED }` (132-139); `PaymentStatus { PENDING SUCCEEDED FAILED REFUNDED }` (106-111, used only by the unused `Payment`); `Role { SHOPPER VENDOR ORGANIZER ADMIN }` (32-37).

### 1.3 Existing state machine (the only one)

`Order.status` — `orders.service.ts:9-16`:

```
PENDING → PAID | CANCELLED
PAID → FULFILLED | CANCELLED      (PAID→CANCELLED is in the table but every caller refuses it: no refunds)
FULFILLED → SHIPPED
SHIPPED → DELIVERED
DELIVERED, CANCELLED → (terminal)
```

Actors: webhook (PENDING→PAID), shopper (cancel PENDING — group-wide; confirm SHIPPED→DELIVERED), vendor (PAID→FULFILLED→SHIPPED via `PATCH /vendors/me/orders/:id/status`, `orders.service.ts:116-132`), admin (cancel PENDING — group-wide, audited, `orders.service.ts:205-232`), expiry job (cancel PENDING groups older than TTL).

This single field mixes **payment** (PAID), **fulfilment** (FULFILLED/SHIPPED/DELIVERED) and **commercial** (CANCELLED) state.

### 1.4 Transaction boundaries

| Operation | Boundary | Isolation | Evidence |
|---|---|---|---|
| Checkout create | group + orders + items + stock decrement + cart clear | **Serializable** | `checkout.repository.ts:64-116` (isolation at :114) |
| Cart read, availability check | **outside** the transaction | — | `checkout.service.ts:64-70` |
| Paymob intention | outside, after commit | — | `checkout.service.ts:78-99` |
| `setPaymobIntent` | single statement | autocommit | `checkout.repository.ts:118-123` |
| Webhook `recordPayment` | group claim + orders → PAID | Read Committed (default) | `checkout.repository.ts:156-181` |
| `cancelPendingGroup` | orders → CANCELLED + stock increment | **Serializable** | `orders.repository.ts:132-161` (:159) |
| Vendor variant create / update | single statement | autocommit | `vendors.repository.ts:318-332` |
| Audit | separate write **after** the domain commit, errors swallowed | autocommit | `audit.service.ts:18-33` |

### 1.5 Constraints and unique indexes that matter

- `OrderGroup.paymobTransactionId @unique` — one recorded transaction per group.
- `ProductVariant.sku @unique`; `CartItem @@unique([cartId, variantId])`.
- CHECK constraints in the whole database: only the rating score range and bazaar end ≥ start (`migrations/20260823151740_.../migration.sql:9`, `migrations/20260926010000_.../migration.sql:10`). **None on stock or money.**
- No triggers. No partial indexes. GIST indexes are hand-maintained in migration SQL.

### 1.6 Existing concurrency protections (what is genuinely good)

| Protection | Where | Assessment |
|---|---|---|
| Serializable checkout + negative-stock check + P2034 retry ×3 | `checkout.repository.ts:97-114`, `checkout.service.ts:29-62` | Correct for "last unit" races between *different* carts. No backoff. Exhausted retries return **500** `CHECKOUT_CONTENDED` (`checkout.service.ts:40`). |
| First-transaction claim `WHERE paymobTransactionId IS NULL` | `checkout.repository.ts:163-171` | Correct for replay of the *same* transaction and keeps evidence of a second charge. |
| Guarded status transitions `updateMany WHERE status = from` → 409 | `orders.repository.ts:113-120` | Correct. |
| Group cancel restocks only orders it actually moved | `orders.repository.ts:141-154` | Correct — no double restock. |
| Owner predicate inside the same query | `orders.repository.ts:43, 62-72, 94-105` | No IDOR found on shopper or vendor routes. |
| HMAC with `timingSafeEqual`, signed-id-only matching | `infra/paymob/paymob.service.ts:17-38`, `order-payment.handler.ts:50-65` | Correct. |
| Integer piastres in arithmetic | `common/money.ts` | Correct for EGP; hard-codes ×100. |

### 1.7 Frontend dependencies (mobile app, `D:\Youssef\Riven-App`)

- `POST /checkout` and `retry-payment` are sent with **empty bodies**; reads `id`, `orders[].{id,subtotal}`, `paymentSetupFailed`, `clientUrl` (`src/api/backend.ts:680-709`).
- Order status is lower-cased and looked up in a fixed map; **an unknown value throws** in `orders/[id]/index.tsx:99,147` and `components/cards.tsx:172`.
- Shipping is hard-coded 0, payment method hard-coded `'paymob'`, address never sent (`backend.ts:283-287`).
- "Complete Payment" always calls `retry-payment`, which returns `PAYMENT_ALREADY_SET_UP` once an intent exists — the app cannot reopen an existing payment page (see R25).
- Shopper-only app. The web dashboard is specified (`specs/web-dashboard-endpoints.md`) but not in this repo.

---

## 2. Critical Issues Register

Severity scale: **CRITICAL** = loses money, sells stock that does not exist, or blocks the business; **HIGH** = likely financial/inventory damage under normal load; **MEDIUM** = incorrect state or poor recovery under specific conditions; **LOW** = hygiene.

Each issue lists: location · current behaviour · failure scenario · root cause · correction · required tests. Corrections reference the target design (`01`–`06`) and the phase that fixes them.

---

### R1 — CRITICAL — No way to take a paid order without Paymob
- **Location:** `order-payment.handler.ts` (the only writer of PENDING→PAID); `infra/paymob/paymob.service.ts:69-76` throws 503 `PAYMENTS_NOT_CONFIGURED` when keys are unset.
- **Current:** with Paymob unconfigured every checkout returns `paymentSetupFailed: true`; orders expire after 60 min. Only `scripts/demo-data.mjs` marks orders paid, via raw SQL.
- **Failure:** the marketplace cannot sell anything.
- **Root cause:** a single payment method hard-wired into checkout.
- **Correction:** `PaymentTransaction` with methods PAYMOB / TRANSFER / COD (`payments-module-spec2.md`), Phase 3 (transfer) and Phase 4 (COD).
- **Tests:** e2e transfer happy path; COD placement + confirmation; Paymob path unchanged.

### R2 — CRITICAL (once Paymob is live) — Late or raced payments are recorded only in a log line
- **Location:** `order-payment.handler.ts:85-118`; expiry selection `orders.repository.ts:164-176`; shopper cancel `orders.service.ts:66-84`.
- **Current:** a success webhook for a group whose orders are all CANCELLED is outcome `orphan`: the transaction id and amount are written on the group, `paidAt` null, and `logger.error(... Recorded for manual refund ...)`. No status, no exception record, no admin list, no audit. The expiry job and shopper cancel ignore `paymobIntentId`, so a group can be cancelled while the shopper is on Paymob's page.
- **Failure:** shopper pays at minute 61 → order cancelled at minute 60 → money taken, nothing to fulfil, refund depends on someone reading logs.
- **Root cause:** no persistent payment entity, no exception workflow, expiry not payment-aware.
- **Correction:** `PaymentTransaction` + `PaymentProviderEvent` inbox + `PaymentException(LATE_PAYMENT)`; expiry respects "live" transactions with `expiresAt` / `graceUntil` / hard cap (`payments-module-spec2.md` §5). Phase 0.
- **Tests:** concurrency C-H1/C-H2 (both orderings of cancel vs webhook), C-F1 (expiry during payment), A-5 (webhook never arrives).

### R3 — CRITICAL (for COD / Riven fulfilment) — Orders carry no delivery data
- **Location:** `schema.prisma:652-711` — no address, receiver phone, governorate, shipping fee or currency anywhere on `OrderGroup`/`Order`.
- **Failure:** Riven cannot ship or charge shipping; COD is impossible.
- **Correction:** address snapshot + `deliveryFeeMinor` + delivery-zone rate snapshot + `currency` on `OrderGroup` (`02-data-model.md`), Phase 3/4. Fee rule is decision FD-04 (location-based zones, proposed); its accounting treatment is FD-18.
- **Tests:** checkout validation (address required for TRANSFER/COD), totals include shipping.

### R4 — HIGH — Vendor stock edits overwrite (lost update) — *Race G*
- **Location:** `vendors.service.ts:344-361` → `vendors.repository.ts:327-332` (`productVariant.update({ data })` with absolute `stockQuantity`, DTO `create-product-variant.dto.ts`, `@Min(0) @Max(1_000_000)`).
- **Current:** absolute write, autocommit, no version check; checkout/cancel apply deltas.
- **Failure:** stock 10 → checkout reserves 2 (8) → vendor saves 10 → cancel restores 2 → **12** (phantom stock → oversell). Also vendor reads 10, two orders take 2, vendor "corrects" to 10 → the 2 sold units are resurrected.
- **Root cause:** mixed absolute and relative writes on one counter; no notion of reserved stock.
- **Correction:** Phase 0 — delta adjustments and compare-and-set, every change journaled in `inventory_movements`; Phase 1 — `inventory_balances` with `onHand ≥ reserved ≥ 0` (`inventory-module-spec.md`).
- **Tests:** C-G1 (adjustment during reservation), C-G2 (CAS mismatch → 409), invariant check after every test.

### R5 — HIGH — Checkout double-submit can create two groups — *Race E*
- **Location:** `checkout.service.ts:64-70` (cart read outside the transaction); `checkout.repository.ts:110` (`cartItem.deleteMany` count ignored).
- **Current:** request B reads the cart before A commits; B's transaction starts after A commits, sees no conflict, decrements stock again, creates a second group from the stale cart, deletes 0 cart rows, creates a second Paymob intention.
- **Failure:** duplicate orders, stock taken twice, potentially two charges.
- **Root cause:** read-validate-write split across the transaction boundary; no idempotency key.
- **Correction:** `IdempotencyKey` (user-scoped, request hash, persisted response, atomic claim); cart read and locked inside the transaction; delete count verified (`01-target-architecture.md` §6). Phase 0.
- **Tests:** C-E1 (same key ×2 parallel → one group, identical responses), C-E2 (no key, parallel → one group or `CART_EMPTY`), C-E3 (same key, different payload → 409).

### R6 — HIGH — `amount_mismatch` groups hold stock forever and the money is unflagged
- **Location:** `order-payment.handler.ts:87-88, 109-113`; `orders.repository.ts:168` (`paymobTransactionId: null` filter).
- **Current:** mismatch records the transaction, leaves orders PENDING; because `paymobTransactionId` is now set the expiry job never selects the group.
- **Failure:** reserved stock is stuck; if someone later cancels, recorded money has no refund marker.
- **Correction:** `PaymentException(AMOUNT_MISMATCH)`; reservation hard cap independent of payment records. Phase 0.
- **Tests:** mismatch webhook → exception OPEN, reservation released at cap, admin list shows it.

### R7 — HIGH — Only public uploads exist
- **Location:** `infra/storage/storage.service.ts:46-56` (presigned PUT, returns `S3_PUBLIC_URL/key`); `media/dto/create-upload-url.dto.ts` purposes are all public.
- **Failure:** if payment screenshots reuse this path they are world-readable (names, phone numbers, account numbers).
- **Correction:** private bucket/prefix, presigned **POST** with `content-length-range` and content-type, server-side HEAD + magic-byte check before a proof is accepted, short-lived presigned GET for admins (`07-security-permissions.md` §4). Phase 3.
- **Tests:** public URL of a proof key returns 403; oversize and wrong-type uploads rejected; non-owner key rejected.

### R8 — HIGH (before settlements) — No ledger
- **Location:** absent. `Payment` model unused.
- **Failure:** vendor balances, courier debts and refunds would be computed ad hoc; mistakes would be "fixed" by editing numbers; disputes unanswerable.
- **Correction:** double-entry ledger with DB-enforced balance (`04-ledger-and-postings.md`). Core ships with Phase 3 (first money in).
- **Tests:** unbalanced journal fails at commit; duplicate posting idempotent; posted rows immutable.

### R9 — MEDIUM — `paidAt` set on a cancelled group — *Race H*
- **Location:** `checkout.repository.ts:163-179` writes `paidAt: markPaid ? new Date() : null` **before** moving orders; if 0 orders move, the handler downgrades to `orphan` (`order-payment.handler.ts:104-107`) but `paidAt` stays. Contradicts the doc comment at `checkout.repository.ts:154`.
- **Failure:** reports treat a cancelled group as paid.
- **Correction:** group row lock as the serialization point; `paidAt` only set after a successful PENDING→PAID move in the same statement order. Phase 0.
- **Tests:** C-H1, C-H2 assert `paidAt IS NULL` on cancelled groups.

### R10 — MEDIUM — Cancel under contention returns 500 — *Race D/H*
- **Location:** `orders.repository.ts:132-161` (Serializable, no retry); `common/filters/all-exceptions.filter.ts:53-63` maps only P2002/P2003/P2025.
- **Failure:** cancel racing the webhook or another cancel → P2034 → 500 to shopper/admin; expiry job run fails and rethrows (`jobs/orders-expiry.processor.ts`).
- **Correction:** Read Committed + group lock + `withRetryableTx`; P2034/40001/40P01 mapped (`01-target-architecture.md` §5). Phase 0.
- **Tests:** C-D1 (three cancellers in parallel → one 200, others 200 no-op or 409, stock restored once).

### R11 — MEDIUM — No database constraint on stock
- **Location:** `migrations/20260823150614_.../migration.sql:120` creates `stockQuantity` without CHECK.
- **Failure:** any future code path (script, admin fix, bug) can write negative or inconsistent stock; violates the repo rule "constraints in the schema".
- **Correction:** `CHECK ("stockQuantity" >= 0)` in Phase 0; balance CHECKs in Phase 1.
- **Tests:** direct write of −1 fails.

### R12 — MEDIUM — One undifferentiated ADMIN role
- **Location:** `modules/auth/guards/roles.guard.ts:16-32`; `Role` enum.
- **Failure:** the same person can approve a payment proof, record a remittance and pay a vendor; no separation of duties.
- **Correction:** `staffPermissions` on admin users + permission guard + maker-checker on listed actions (`07-security-permissions.md`). Phase 0 (guard), used from Phase 3.
- **Tests:** permission matrix test per route; maker = checker refused by DB CHECK.

### R13 — MEDIUM — Client contract is brittle
- **Location:** mobile app (see §1.7).
- **Failure:** adding a status value or requiring a body breaks the shipped app.
- **Correction:** legacy `Order.status` kept as a read-only projection over the six values; empty-body checkout keeps meaning PAYMOB; new fields additive (`09-multi-client.md`, `03-state-machines.md` §9).
- **Tests:** contract tests on response shape and status domain.

### R14 — MEDIUM — Riskiest paths are untested on a real database
- **Location:** no test for `orders-expiry.processor.ts`; no signed-webhook e2e; no double-submit test; `orders.service.spec.ts` is fully mocked; `app.smoke.spec.ts:43` stubs the expiry processor.
- **Correction:** real-PostgreSQL concurrency suite (`05-race-matrix.md` §5). Phase 0.

### R15 — MEDIUM — Specifications contradict each other and the code
- **Location:** `specs/riven-spec.md:11` ("no commission", "not e-commerce"); `specs/payments-module-spec.md` §5 (a second webhook route, `POST /payments/webhook/paymob`); `fashion-marketplace-addendum.md` (vendors fulfil).
- **Correction:** recorded as conflicts C5/C6 in `01-target-architecture.md` §11; decisions BD-01/BD-02/FD-02.

### R16 — LOW — Rate limiting is per process
- **Location:** `app.module.ts:50`, `common/guards/user-throttler.guard.ts` (in-memory storage). Checkout and media at the global 300/min.
- **Correction:** Redis-backed throttler storage; tighter limits on checkout, proof submission and upload-URL routes. Phase 0 (limits), storage change when scaling out.

### R17 — LOW — No outbox; post-commit enqueues can be lost
- **Location:** `infra/search/search-index.queue.ts:30-53`; `common/events/domain-events.service.ts:14-21` (in-process, no listeners).
- **Correction:** transactional outbox (`01-target-architecture.md` §7). Phase 0.

### R18 — LOW — Minor information leak and restock on deleted variants
- **Location:** `checkout.service.ts:107` returns 403 (not 404) for another user's group; `orders.repository.ts:150-153` increments stock on soft-deleted variants.
- **Correction:** 404 for non-owners; movements on deleted variants allowed but flagged in reconciliation.

### R19 — MEDIUM — Webhook ignores currency
- **Location:** `infra/paymob/paymob-webhook.dispatcher.ts:84-104` (no currency extracted), `order-payment.handler.ts:87` (amount only).
- **Failure:** a non-EGP payment with the same numeric amount would be accepted as paid.
- **Correction:** currency extracted and compared; mismatch → `PaymentException(CURRENCY_MISMATCH)`. Phase 0.

### R20 — HIGH — Non-success provider events are discarded, raw payloads never stored
- **Location:** `paymob-webhook.dispatcher.ts:88-89` returns `null` for anything that is not `success && !pending && !error_occured`.
- **Failure:** declines, voids and **refunds issued from the Paymob dashboard** never reach the database; no evidence trail for disputes; no way to replay.
- **Correction:** `PaymentProviderEvent` inbox storing every signed event with `@@unique([provider, providerEventId])` (`payments-module-spec2.md` §6). Phase 0.

### R21 — MEDIUM — Audit can be lost for financial actions
- **Location:** `audit.service.ts:18-33` (best-effort, after commit, by design per `admin-module-spec.md` §5.2).
- **Failure:** an approved payment or a stock adjustment with no audit row.
- **Correction:** `recordInTx` for financial/inventory actions; moderation stays best-effort. Conflict C1 / decision TD-03.

### R22 — LOW — No correlation id
- **Location:** none in `src/` (only an unrelated test hit).
- **Correction:** request-scoped correlation id (`AsyncLocalStorage`, `X-Request-Id`) carried into audit rows, outbox events and logs. Phase 0.

### R23 — MEDIUM — Refresh-token reuse logs the user out everywhere
- **Location:** `modules/auth/auth.service.ts:237-239, 273-275` → `revokeAllActiveRefreshTokensForUser`.
- **Failure:** mobile app sends refresh, response is lost, app retries with the old token → reuse detected → every session of that user (web and mobile) revoked.
- **Correction:** per-device session/family; reuse revokes only that family; client single-flight refresh (`09-multi-client.md` §3). Decision SD-03.

### R24 — LOW — Contention reported as 500
- **Location:** `checkout.service.ts:40` (`InternalServerErrorException` `CHECKOUT_CONTENDED`).
- **Correction:** 503 `TRY_AGAIN` with `Retry-After`. Phase 0.

### R25 — MEDIUM — An existing payment page cannot be reopened
- **Location:** `checkout.service.ts:102-131` returns 400 `PAYMENT_ALREADY_SET_UP` once `paymobIntentId` is set; the client URL is never persisted; the app's "Complete Payment" always calls retry.
- **Failure:** a shopper who closed Paymob's page cannot pay again until expiry.
- **Correction:** `PaymentTransaction` stores the client URL / client secret and returns it while the attempt is live; a new attempt only after the previous one is terminal. Phase 0 (with the Paymob changes).

---

## 3. Summary by category

| Category | Issues |
|---|---|
| Financial risk | R1, R2, R6, R8, R9, R19, R20, R21 |
| Inventory integrity | R4, R5, R6, R11 |
| Security | R7, R12, R18, R23 |
| Data integrity / state | R9, R10, R13 |
| Process / test | R14, R15, R17, R22, R24, R25, R16 |
| Migration risk | see `06-migration-plan.md` §2 (adding NOT NULL columns to `order_groups`, backfilling stock, hand-written SQL invisible to Prisma) |
