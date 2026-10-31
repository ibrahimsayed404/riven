# 17 — Phase 0 Decision Package (for Youssef; FD-01 also for Ibrahim)

> Status: **for decision** · 2026-10-25 (v6). The six decisions that block the **start** of Phase 0 coding. Every one is **PENDING**; this document recommends, it does not approve. Phase 0 is **not authorized** until Youssef approves TD-04, TD-06, TD-07, TD-08, TD-12, and Youssef and Ibrahim approve FD-01 — and Youssef explicitly authorizes the start.

Verified repository facts used below (read-only, @ `76921ed` + working tree): `AdminAuditLog` = `actorId` (required, FK Restrict), `action AdminAction`, `targetType AdminTargetType`, `targetId`, `reason?`, `createdAt`; `AuditService.record()` is best-effort after commit (`modules/audit/audit.service.ts:18-33`) with 17 call sites; no global prefix, no URI versioning, no OpenAPI (`main.ts`, `app.setup.ts`); 31 controllers; the mobile app calls unprefixed routes (`/auth/*`, `/cart*`, `/checkout*`, `/orders*`, `/vendors/:id`); vendors set absolute `stockQuantity` on variant create and update (`vendors/dto/create-product-variant.dto.ts:33`, update = `PartialType`); no race hooks or concurrency test project exist; money: `Decimal(12,2)` for `Product.basePrice`, `ProductVariant.priceOverride`, `Order.subtotal`, `OrderItem.priceSnapshot`, `paidAmountCents Int`, pass-1 `Payment.amount Decimal(10,2)`; `PRICE_MAX = 1,000,000` EGP; `common/money.ts` converts with ×100 and ROUND_HALF_UP.

---

## 1. TD-04 — Extended audit logging (PENDING YOUSSEF)

### 1.1 Field evaluation
| Field | Today | Proposal | Reason |
|---|---|---|---|
| `actorId` | required | **nullable** | system / provider actions (expiry, webhook) have no user |
| `actorType` | — | `USER \| SYSTEM \| PROVIDER` (required) | distinguishes "nobody" from "the system" |
| `action` | `AdminAction` enum | keep enum, extend with financial / inventory / vendor / order / permission actions listed in each module spec | stable codes for search and alerts |
| `entityType` / `entityId` | `targetType` / `targetId` | **keep the existing column names** (renaming breaks `GET /admin/audit-log`); extend `AdminTargetType` | no breaking change |
| `before` / `after` | — | `previousState jsonb` / `newState jsonb` containing **only allow-listed fields** per action (§1.2) | full objects would copy secrets / PII and grow without bound |
| `reason` | optional | **required** (≥ 10 chars) for every manual financial / inventory / permission / restriction action; optional for moderation | accountability |
| `timestamp` | `createdAt` | keep; database `now()` only (never client time) | trustworthy ordering |
| `correlationId` | — | add (from `X-Request-Id`, `01` §9) | ties audit ↔ outbox ↔ logs ↔ provider events |
| *(additional)* `source` | — | route, job or `webhook:paymob` | investigation |
| *(additional)* `ledgerJournalId` | — | optional link | financial drill-down |

### 1.2 Redaction strategy
- An explicit **allow-list per action** in code (`AUDIT_FIELDS[action] = ['status', 'amountMinor', 'currency', …]`); anything not listed is dropped before insert. No generic "dump the entity".
- **Never stored:** passwords / hashes, access or refresh tokens, OTPs, API keys, HMACs, full card data, full bank / IBAN / wallet / InstaPay identifiers (last 4 only), proof images or their URLs (keys only), raw provider payloads (they live in `payment_provider_events`).
- Personal data minimized: phone numbers masked except last 3 digits; addresses never copied (the order keeps the snapshot).
- Size limit: `previousState` + `newState` ≤ 8 KB together; larger → truncated with `truncated: true` and a SHA-256 of the full allow-listed object.

### 1.3 Write semantics
- **Sensitive operations** (financial, inventory, payment, refund, settlement, payout, statement, permission, restriction, hold, pricing configuration — TD-03 scope): `recordInTx(tx, entry)` inside the business transaction; **if the audit insert fails, the business action fails** (mapped to 503 `TRY_AGAIN`, retried by `withRetryableTx` when transient).
- **Moderation** (vendor verify/reject, rating moderation, category edits): today's best-effort `record()` after commit stays (`admin-module-spec.md` §5.2 remains correct for them).
- **Append-only:** trigger raising on UPDATE / DELETE of `admin_audit_logs` (TD-02); runtime role without UPDATE / DELETE grant (TD-17); FK `Restrict` kept.
- **Tamper evidence (optional, not recommended for MVP):** hash chain per row (`prevHash`). The trigger + role separation + daily export is judged sufficient for the MVP; revisit if an auditor requires it.

### 1.4 Access, retention, search
- Read: `GET /admin/audit-log` restricted to PLATFORM_OPERATOR, FINANCE_APPROVER and (for their domain) FINANCE / INVENTORY once staff permissions exist (SD-01); vendors and shoppers never.
- Filters: actor, actorType, action, entity (type + id), correlationId, date range, source; indexes on `(targetType, targetId)`, `actorId`, `createdAt`, `correlationId`, `action`.
- Retention: at least the financial-record period (SD-05, legal — TBD); no deletion by the application.

### 1.5 Coverage (one row per family; exact action names in the module specs)
Financial (payments, proofs, claims, exceptions, refunds, destinations, ledger adjustments, reversals, statements, settlements, payouts, discrepancies, holds) · Inventory (movements' business actions: adjustments, requests, intake receive/verify/dispute/correction, stocktake, damage, write-off, return to vendor) · Vendor (verify/reject, restriction, payout account add/verify/reveal) · Order (cancel by admin, COD confirmation, shipment transitions, returns) · Permission (grant/revoke staff permissions) · Sensitive admin (maintenance runs, outbox drain/requeue, re-pricing, delivery-zone changes, reveals).

### 1.6 Implementation implications and files
`prisma/schema.prisma` (`AdminAuditLog` columns, enums), one migration + append-only trigger (hand SQL), `modules/audit/audit.repository.ts` (`createInTx`), `audit.service.ts` (`recordInTx`, allow-list, redaction), `modules/admin` audit-log query filters, every financial / inventory service (Phase 0: checkout, cancel, Paymob, vendor stock).

### 1.7 Acceptance, failure and security scenarios
Criterion 14; invariant 8 (`05` §5); AT-SEC-08. Failure: audit insert fails → whole transaction rolled back, nothing changed (test with a fault hook). Security: snapshot test that no allow-list contains a forbidden field; UPDATE / DELETE on an audit row raises.

### 1.8 Dependencies
TD-03 (approved), TD-02 (approved), TD-17 (pending, for the grant part), SD-05 (retention), SD-01 (read permissions).

### 1.9 Recommendation
**Approve TD-04 as specified in §1.1–1.5.** Do **not** edit `admin-module-spec.md` (a reviewed spec; repo rule: a new pass is a new file) — the commerce documents already record the supersession for sensitive operations (C1). **Proposed CLAUDE.md wording for the maintainer to apply only after TD-04 is approved** (not applied in this documentation task):

> **Admin writes are audited.** Moderation actions use best-effort `auditService.record()` after commit (unchanged). Financial, inventory, payment, refund, settlement, payout, permission, restriction, hold and pricing actions use `auditService.recordInTx(tx, …)` inside the business transaction — if the audit write fails, the action fails (TD-03, TD-04; `specs/commerce/17-phase0-decision-package.md` §1).

---

## 2. TD-06 — Outbox processing (PENDING YOUSSEF)

### 2.1 Verification of the design (`01` §7)
| Property | Where | Status in the design |
|---|---|---|
| Atomic creation in the business transaction | §7.1 | ✔ |
| Stable event ids | §7.1, §7.6 | ✔ UUID generated in the transaction |
| Per-consumer delivery | §7.1, `02` §3.9 | ✔ `outbox_deliveries` unique `(eventId, consumer)` |
| Processing leases, expiry, reclaim | §7.4 | ✔ DB time, 60 s lease > 30 s timeout |
| Multiple instances | §7.4 | ✔ `SKIP LOCKED` + lease; C-O3 |
| Guarded completion | §7.4 | ✔ `WHERE lease_owner = me AND status = 'PROCESSING'`; C-O4 |
| Retry backoff, max attempts | §7.3 | ✔ 1 s … 10 min, max 10 |
| Dead-letter | §7.3 | ✔ DEAD + review (OD-02) |
| Manual recovery | §7.9 | ✔ bounded drain, requeue with reason, audited, no delete |
| Idempotent consumers | §7.4, §7.6 | ✔ `processed_events` in the consumer transaction |
| Provider idempotency | §7.6 | ✔ where supported (push / e-mail providers, TD-20) |
| Reconciliation when not | §7.6 | ✔ effect rows; non-tolerant effects escalate, never blind resend |
| Inline processing is only an optimisation | §7.2, §7.5 | ✔ stated explicitly |
| Consumer invariant (no money / stock) | §7.8 | ✔ verified against every documented event |

### 2.2 Minimum safe recovery while workers are postponed (TD-13)
Boot sweep on every instance + piggy-back drain + **scheduled bounded drain every 5 min (worker architecture TD-23; reservation expiry runs separately every 10 min, TD-18)** + health alerts to OD-02 + daily DEAD review. Without TD-18 and a named OD-02, production go-live is blocked (OBX-05, PRG-03).

### 2.3 What cannot be released without reliable scheduled processing and monitoring
PAYMOB (payment reconciliation — already disabled in production), provider-API refunds (FD-12, deferred), and **any production traffic at all** if TD-18 / OD-02 / alerts are missing (lazy expiry and notification delivery would depend on traffic). Notifications alone tolerate delay (no money / stock depends on them).

### 2.4 Files and modules
New `infra/outbox/` (writer `appendInTx`, claim/complete repository, processor, consumer registry/allow-list), `processed_events`, admin outbox controller, `/health` metrics, maintenance command; migrations for `outbox_events`, `outbox_deliveries`, `processed_events` + triggers.

### 2.5 Acceptance and failure scenarios
Criteria 25, 41, 42; AT-OB-01 – AT-OB-10; C-O1 – C-O4; invariant 13.

### 2.6 Dependencies
TD-12 (race hooks for C-O4), TD-18 (scheduled drain), TD-17 (no delete grant), TQ-28 (scheduler), OD-02.

### 2.7 Recommendation
**Approve TD-06 as specified in `01` §7.** Approve TD-18 together with it, or record that production go-live waits for it.

---

## 3. TD-07 — API versioning (PENDING YOUSSEF)

### 3.1 Current state
31 controllers, no global prefix, no versioning, no OpenAPI. Clients: the mobile app (unprefixed routes). The vendor dashboard and admin dashboard **do not exist yet** (no web app in the repo); the shopper web app does not exist yet.

### 3.2 Strategy
1. Enable NestJS URI versioning with **`defaultVersion: VERSION_NEUTRAL`** — every existing path keeps working unchanged (no breaking change for the mobile app).
2. New or changed contracts are exposed as `/v1/...` (`@Version('1')`); routes whose contract is unchanged are served on both (`@Version([VERSION_NEUTRAL, '1'])`) so new clients use `/v1` everywhere.
3. Differences between neutral and `/v1` are limited to: `Idempotency-Key` **required** on `/v1` money / inventory POSTs (optional on neutral during the window, C8); `PAYMOB` unconfigured → 503 on `/v1` (legacy body on neutral); 404 instead of 403 for foreign ids (R18).
4. Errors: one global filter (`AllExceptionsFilter`) — identical `{ code, message, details? }` on both.
5. Authentication / authorization: identical (same JWT, guards, permissions) on both.
6. OpenAPI (TD-11): generated for `/v1` only; neutral routes documented as deprecated.
7. **New clients** (vendor dashboard, admin dashboard, shopper web) are built on `/v1` from day one.
8. **Deprecation:** neutral routes get `Deprecation` and `Sunset` headers once the mobile app release using `/v1` is published; removal only when (a) the app enforces a minimum version that uses `/v1`, (b) server logs show < 1 % neutral traffic for 30 days, (c) at least 90 days after the `Sunset` announcement, (d) Youssef approves.

### 3.3 Files and modules
`main.ts` / `app.setup.ts` (`enableVersioning`), controllers that change contract (checkout, orders, payments), `AllExceptionsFilter` unchanged, OpenAPI setup (TD-11 — adds `@nestjs/swagger`, a dependency change **not** made in this documentation task).

### 3.4 Acceptance and failure scenarios
Existing e2e and smoke suites pass unchanged on neutral routes; contract tests (`06` §4.2); `/v1` parity suite (C-MC1) — *gap: a dedicated neutral-vs-`/v1` contract test is proposed* (`16` gap list). Failure: a client sending no key on `/v1` → 400 `IDEMPOTENCY_KEY_REQUIRED`.

### 3.5 Dependencies
TD-11 (OpenAPI), SD-03 / SD-04 (sessions, web cookies) for the web dashboards, mobile release planning.

### 3.6 Recommendation
**Approve TD-07 as §3.2.** Smallest change that protects the mobile app and gives new clients a stable contract.

---

## 4. TD-08 — Vendor stock editing under the custody model (PENDING YOUSSEF)

### 4.1 Rules to preserve
Vendor-declared quantities are never automatically sellable; only physically received and verified stock is sellable; vendors never edit Riven's verified quantities; corrections are controlled, delta-based, audited requests; vendors never increase sellable stock beyond verified holdings.

### 4.2 Design by phase
| Phase | What a vendor can change | How | Sellable effect |
|---|---|---|---|
| 0 – 1a (no custody yet) | `stockQuantity` (today's single counter) | `PATCH …/variants/:variantId/stock` with `{ delta, reason }` or `{ setTo, expectedStockQuantity, reason }` (CAS); the variant `PATCH` rejects `stockQuantity` (400 `USE_STOCK_ENDPOINT`); create keeps an initial value | the counter is still purchasable **only outside production** — real orders are blocked by the production gate (BD-33 / PRG); recorded as an explicit phase limitation, not a silent exception |
| 1b + | the vendor's **declared** count at its premises location | same endpoint, delta / CAS, resolved to the premises balance only | **none** (premises `sellable = false`) — the declared count only pre-fills intakes |
| 2 + | Riven-held verified stock | **never directly** — an **adjustment request** (§4.3) | only after approval, and only *decreases* (§4.3) |

### 4.3 Vendor adjustment request (Riven-held stock)
- `POST /vendors/me/inventory/adjustment-requests` `{ variantId, delta (< 0), reasonCode: DAMAGE_REPORTED | COUNT_ERROR, explanation ≥ 10 chars, evidenceKeys[] }` + `Idempotency-Key` → PENDING. *(v7: WITHDRAW / RECALL removed — withdrawals use the stock-withdrawal workflow with 4 days' notice, `19` §10.3; approval by one authorized admin, BD-38, replaces the INVENTORY + FINANCE_APPROVER pair below.)*
- **Increases are not requestable:** more units must arrive through an intake; a claim that Riven under-counted is an intake dispute (BD-24 / BD-25). This is what guarantees vendors cannot raise sellable stock beyond verified holdings (INV-10).
- INVENTORY reviews (maker: proposes an `InventoryAdjustment` or rejects with reason); FINANCE_APPROVER approves (checker ≠ maker). WITHDRAW / RECALL also create a return-to-vendor shipment task.
- Applying: guarded `UPDATE inventory_balances SET on_hand = on_hand + $delta WHERE id = $b AND on_hand + $delta >= reserved` (L6; 0 rows → 409 `ADJUSTMENT_BELOW_RESERVED` — reserved units cannot be withdrawn until their orders resolve); movement `ADJUSTMENT` (`sourceType = ADJUSTMENT_REQUEST`, `origin = RIVEN_VERIFIED`); audit `VENDOR_ADJUSTMENT_REQUESTED` (vendor actor), `INVENTORY_ADJUSTMENT_APPROVED|REJECTED`; vendor notified.
- Concurrency: a request approved while a checkout reserves the same balance — both are single-row guarded updates; whichever runs second sees the first (C-13, C-16).
- Reconciliation: the daily inventory reconcile compares counters with Σ movements (incl. request-driven adjustments).

### 4.4 Bypass check over every mutation path
All 14 paths of `inventory-module-spec.md` §11 and the 12 bypass scenarios of §12 were re-checked: the only writers of positive RIVEN `on_hand` remain intake verification, inspected restock and maker-checked stocktake / adjustment; the vendor request path is decrease-only. No path lets a vendor change a RIVEN balance directly.

### 4.5 Files and modules
`vendors` DTOs (`create-product-variant.dto.ts`, `update-product-variant.dto.ts`), vendor product / variant controller and service, new stock endpoint, inventory module (Phase 1+: balances, adjustments, requests), movements; `InventoryAdjustmentRequest` model (`02` §3.5).

### 4.6 Acceptance, security, failure
AT-INV-07 (d, e), AT-INV-13 (request to increase refused; decrease approved → movement), C-G1, C-G2, C-13, C-16. Security: vendor can only target own variants (404 otherwise, C-VP1); maker ≠ checker (CHECK).

### 4.7 Dependencies
BD-08 (custody, pending Ibrahim — the request workflow is only needed if custody is approved), BD-24 / BD-25 (disputes), SD-01 (who approves).

### 4.8 Recommendation
**Approve TD-08 as §4.2–4.3.** Breaking change for vendor clients: no vendor frontend exists yet; smoke script and any scripts updated in the same change.

---

## 5. TD-12 — Test-only race hooks (PENDING YOUSSEF)

### 5.1 Design
- A `RaceHooks` provider with named points; production code calls `await raceHooks.point('checkout.afterCartLock')` at the few places where an interleaving must be forced. The default binding is **`NoopRaceHooks`** (returns immediately).
- The real implementation is bound only when **all** hold at bootstrap: `NODE_ENV === 'test'`, `RACE_HOOKS === '1'`, and the database name ends with `_test`. The API **refuses to start** if `RACE_HOOKS` is set with `NODE_ENV=production`.
- Control is **in-process only**: the concurrency test obtains the provider from the Nest testing module and calls `pauseAt(name)` → `{ reached: Promise, release() }`, plus barriers (`barrier(n)`) to start N operations together. **No HTTP route, no header, no query parameter** can reach it.
- A hook can only **wait**; it cannot change data, skip checks or alter return values. A lint rule restricts `raceHooks.point` calls to services / repositories; a unit test asserts the no-op binding in a production configuration.

### 5.2 Hook points (minimum set)
`checkout.afterCartLock`, `checkout.beforeReserve`, `cancel.afterGroupLock`, `webhook.afterGroupLock`, `expiry.afterClaim`, `proof.afterGroupLock`, `payout.afterSendGuard`, `payout.beforeConfirm`, `intake.beforeVerifyMovements`, `adjustment.beforeApply`, `outbox.afterClaim`, `outbox.beforeComplete`, `hold.afterControlShare`.

### 5.3 Scenarios they enable (real PostgreSQL, `05` §6)
Checkout vs cancellation (C-D1, C-10), concurrent reservations (C-A, C-14), duplicate payment callbacks (C-B), cancel vs webhook in both orders (C-H1, C-H2), concurrent payout confirmation (C-8, C-PO1), intake vs adjustment (C-IN1, C-13), outbox lease reclaim (C-O4), hold activation vs in-flight payout (AT-HLD-03). **SQLite, mocked Prisma or in-memory fakes never count as proof** of database concurrency behaviour.

### 5.4 Files
New `common/testing/race-hooks.ts` (+ module), env validation (`RACE_HOOKS` optional), separate Jest project `test:concurrency` (a `package.json` script — **not added in this documentation task**), CI job after e2e.

### 5.5 Recommendation
**Approve TD-12 as §5.1.** Without it the TD-01 condition (real concurrency tests before switching isolation) cannot be met deterministically.

---

## 6. FD-01 — Integer minor units (PENDING IBRAHIM + YOUSSEF)

### 6.1 Proposal
| Item | Representation |
|---|---|
| Unit amounts (vendor rate, Riven markup, customer unit price, delivery fee, unit refund) | `Int` minor units (piastres) + `currency CHAR(3)` — fits: `PRICE_MAX` 1,000,000 EGP = 100,000,000 < 2³¹ |
| Line totals, order / group totals, payment amounts, refunds, COD amounts | **`BigInt`** minor units — *v6 refinement:* `quantity × unit` can exceed 2³¹ (e.g. 100 × 1,000,000 EGP); the earlier "Int per document" recommendation is narrowed to unit amounts. *Alternative:* keep `Int` and enforce a maximum order total (≤ 21,474,836.47 EGP) by CHECK and DTO validation |
| Ledger entries, statements, settlements, payouts, adjustments | `BigInt`, strictly positive in the ledger (direction carries the sign) |
| Discounts | none in the MVP; if introduced: an explicit negative line in minor units, never a floating percentage applied at render time |
| Percentages | integer basis points (6 % = 600) |
| Currency | `currencies(code, minorUnits)`; EGP = 2 today; every money row carries `currency`; one currency per order and per journal (FD-15 deferred) — the architecture is not hard-coded to EGP or to "×100" |
| Rounding | per-unit round-half-up for the markup (FD-20); proportional splits (if ever needed, e.g. a partial refund across lines) by the largest-remainder method so parts sum exactly |
| Conversion | existing `Decimal(12,2)` catalogue columns keep their meaning; conversion at the boundary with `toMinor(amount, currency)` (generalizing `common/money.ts`, which today hard-codes ×100 — C4) |
| API serialization | new fields end in `Minor` and are integers; `BigInt` values as JSON strings (TD-05); existing decimal fields (`subtotal`, `price`) stay for the mobile app |
| Database | `INTEGER` / `BIGINT` with CHECKs (≥ 0; ledger > 0); **no float / real columns**; no money arithmetic in JavaScript `number` beyond `Number.MAX_SAFE_INTEGER` checks — BigInt in code for aggregates |

### 6.2 Migration risks
Backfill of `priceSnapshotMinor` / totals from `Decimal(12,2)` is exact (two decimals); `Payment.amount Decimal(10,2)` (pass 1, unbuilt) is out of scope; overflow of `Int` totals is avoided by `BigInt` (§6.1); reports must not mix `Decimal` and minor units; a dual period exists where both representations are written (legacy projection, `06` §4).

### 6.3 Business aspects for Ibrahim
EGP only for now; prices shown to customers to 2 decimals; markup rounding per unit (FD-20: e.g. 333.33 → 20.00 profit → 353.33); no discounts in the MVP.

### 6.4 Recommendation
**Approve FD-01 as §6.1** (Youssef: representation; Ibrahim: currency scope, display, rounding policy).

---

## 7. Summary for the approval meeting

| Decision | Recommendation | If not approved |
|---|---|---|
| TD-04 | approve §1 | Phase 0 cannot write the audit rows its money and stock changes require (TD-03) |
| TD-06 | approve `01` §7 (+ TD-18) | no durable events for exceptions and expiries; production go-live blocked |
| TD-07 | approve §3.2 | checkout contract changes would break the mobile app or stall |
| TD-08 | approve §4.2–4.3 | vendor stock edits keep overwriting (R4) |
| TD-12 | approve §5.1 | concurrency tests cannot force interleavings; TD-01's condition unmet |
| FD-01 | approve §6.1 | Phase 0 cannot add `totalMinor` / `amountMinor` columns |

**Phase 0 start requires all six approvals plus Youssef's explicit authorization.** None is given in this document.
