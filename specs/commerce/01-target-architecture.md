# 01 — Target Architecture

> Status: **DRAFT for review** · 2026-10-24. Depends on: `00-architecture-audit.md`. Decisions referenced as BD/FD/TD/SD are in `08-decision-register.md`.

## 1. Principles

1. **One foundation per concern; payment methods only decide *when* to call it.** Inventory exposes reserve / confirm / release / fulfil; payments expose record / approve / fail / refund. PAYMOB, TRANSFER and COD call them at different moments. No method owns stock or ledger logic.
2. **Every state change is a guarded transition** (`UPDATE … WHERE id = $1 AND status = $from`), checked for an affected-row count, inside a transaction. 0 rows → 409, never a silent no-op unless the target state already holds (idempotent repeat → 200 with current state, no audit, no posting).
3. **Facts are appended, never edited**: inventory movements, ledger entries, provider events, audit rows, claim events. Corrections are new rows.
4. **Money is integer minor units + an explicit currency.** No floats. Conversion uses the currency's `minorUnits` (`04-ledger-and-postings.md` §3).
5. **The backend is the only authority** for prices, totals, stock, payment and fulfilment state. Clients send intent, never amounts to trust (`09-multi-client.md`).
6. **No external call inside a database transaction.** External effects happen after commit, keyed by a persisted record so retries cannot repeat them.
7. **Simplest thing that is provably safe.** No microservices, no generic workflow engine, no event sourcing. A modular monolith on one PostgreSQL database.

## 2. Domains and modules

| Domain | Module (new unless noted) | Owns tables |
|---|---|---|
| Checkout & Orders | `checkout/`, `orders/` (existing) | `order_groups`, `orders`, `order_items`, `idempotency_keys` |
| Payments | `payments/` | `payment_transactions`, `payment_provider_events`, `payment_proofs`, `payment_reference_claims` (+ events), `payment_exceptions` |
| Paymob adapter | `infra/paymob/` (existing, unchanged route) | — |
| Inventory | `inventory/` | `warehouses`, `inventory_balances`, `stock_reservations`, `inventory_movements`, `inventory_intakes` (+ lines), `stocktakes` (+ lines), `inventory_discrepancies` |
| Fulfilment | `fulfilment/` | `couriers`, `shipments`, `shipment_items`, `return_requests` (+ lines) |
| COD reconciliation | `finance/cod/` | `cod_collections`, `courier_remittances`, `remittance_allocations`, `courier_deductions` |
| Ledger, statements & settlements | `finance/ledger/`, `finance/settlements/` | `currencies`, `ledger_accounts`, `ledger_journals`, `ledger_entries`, `vendor_statements` (+ lines), `vendor_settlements`, `settlement_lines`, `vendor_payouts`, `payout_receipt_confirmations`, `payout_discrepancies`, `vendor_payout_accounts`, `refunds`, `refund_attempts` |
| Pricing & delivery fees | `pricing/` | `pricing_config_versions`, `delivery_zones`, `delivery_zone_areas`, `delivery_zone_rates` (price snapshots live on order items / order groups) |
| Vendor portal (read side) | `vendors/` (existing module, new `vendor-portal.controller.ts` family) | none of its own — reads through the owning modules' services; `fulfilment_events` (owned by fulfilment) gives timestamps |
| Platform | `infra/outbox/`, `common/request-context/` | `outbox_events`, `processed_events` |
| Audit (existing) | `audit/` | `admin_audit_logs` (extended, TD-04) |

Repository rule (CLAUDE.md) is kept: **every Prisma call lives in the owning module's repository; no module imports another module's repository.** Cross-module work goes through the other module's service.

`finance/` is one Nest module with three sub-folders rather than three modules: they share the ledger posting service and would otherwise import each other.

## 3. Cross-module transactions: required `tx`

A checkout must create orders, reserve stock and write the outbox atomically, but those tables belong to three modules.

- The **orchestrating service** (e.g. `CheckoutService`) opens the transaction through its own repository: `checkoutRepository.runInTx(fn)` (a thin wrapper over `prisma.$transaction`, see §5).
- It passes the transaction client to other modules' services: `inventoryService.reserveInTx(tx, lines)`.
- Those services pass `tx` down to **their own** repositories. Repositories never import each other.
- **Any method that must run inside a caller's transaction takes `tx: Prisma.TransactionClient` as a required first parameter and is named `…InTx`.** There is no optional-`tx` variant; a method that can also run standalone has a separate public wrapper that opens its own transaction and calls the `InTx` version.
- Each `…InTx` method documents, in a JSDoc `@locks` tag, the lock level(s) it takes (§4). Code review checks that a callee never locks a level above the caller's current level.
- ESLint (existing custom rules in `eslint.config.mjs`) gains a rule: a function named `*InTx` must declare a first parameter typed `Prisma.TransactionClient`.

This replaces today's direct write of `product_variants` from `checkout.repository.ts:97-108` and `orders.repository.ts:149-154` — a cross-module write the repo rules already forbid in spirit.

## 4. Global lock hierarchy

Locking the order group first does **not** by itself prevent deadlocks: a workflow that locks inventory and then a group, interleaved with one that locks a group and then inventory, deadlocks regardless. Deadlock freedom comes from a single global acquisition order that every workflow follows.

### 4.1 Levels (acquire downward only; within a level, ascending primary key)

| Level | Rows | Acquisition |
|---|---|---|
| **L0** *(proposed, TD-19)* | `financial_holds` control rows (one per holdable workflow) and entity holds | business transactions: `SELECT … FOR SHARE` first, before L1; only hold activation takes `FOR UPDATE` (`07` §14.4). Shared locks never conflict with each other, so L0 adds no deadlock path between business workflows |
| **L1** | `order_groups` (several → sorted by id) | `SELECT id FROM order_groups WHERE id = ANY($ids) ORDER BY id FOR UPDATE` |
| **L2** | `orders` of the locked group(s) | implicit, via guarded `UPDATE` in id order |
| **L3** | the group's `payment_transactions`, `payment_proofs`, `payment_reference_claims` | guarded `UPDATE`; claims via `INSERT … ON CONFLICT DO NOTHING RETURNING` |
| **L4** | the group's `shipments`, `shipment_items`, `cod_collections`, `return_requests`, `refunds` | guarded `UPDATE` |
| **L5** | finance aggregates not owned by a group: `courier_remittances` → then the `cod_collections` being allocated (sorted); `vendor_settlements` → then candidate payable `ledger_entries` (sorted) | `SELECT … FOR UPDATE` on the parent, then children sorted |
| **L6** | `inventory_balances` (Phase 0: `product_variants` stock column), sorted by `(warehouse_id, variant_id)` | **one atomic guarded `UPDATE` per row**; never `SELECT` then `UPDATE` |
| **L7** | insert-only: `inventory_movements`, `stock_reservations` inserts, `ledger_journals`, `ledger_entries`, `outbox_events`, `admin_audit_logs`, `payment_provider_events`, claim events | no explicit locks; unique-key conflicts are the idempotency mechanism |

`cod_collections` appear at L4 (when a group workflow touches its own collection) and L5 (when a remittance allocates to many). They are never locked in the same transaction from both directions: remittance allocation (L5) never takes a group lock, and group workflows never allocate remittances.

### 4.2 Rules

1. **Never acquire a lower-numbered level after a higher one** in the same transaction.
2. **Inventory is a leaf.** Workflows that have no group (vendor adjustment, intake, stocktake, return-to-vendor, reconciliation) lock only L6 rows (plus L7 inserts). Group workflows reach L6 last. Both lock L6 in the same sorted order. No cycle is possible.
3. **No stored ledger balances.** Account balances are `SUM` queries; there is no hot balance row. Ledger work is L7 inserts only.
4. **Workers never wait on requests.** Expiry, payment reconciliation, outbox drainer and SLA escalation select candidates with `FOR UPDATE SKIP LOCKED` at L1 (or their own level), process each candidate in its own short transaction, and skip anything a request currently holds.
5. **Bounded waits.** Every lock-taking transaction starts with `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '15s'`.
6. **Short transactions.** No network calls, no file I/O, no sleeps inside. Hot rows (a popular variant's balance) are held only for the duration of one guarded `UPDATE` plus the rest of a short transaction.
7. **Nested services** document their `@locks` level; a nested call may only take a level ≥ the caller's highest level so far.

### 4.3 Which workflows take the L1 group lock

Only workflows that change **payment or commercial state of a group**, because those are the ones that race each other:

| Takes L1 | Does not take L1 |
|---|---|
| payment initiation / retry-payment | checkout creation (new group, invisible to others until commit) |
| Paymob webhook application | all reads |
| proof submission, proof review (claim, approve, reject) | shipment progress after the group is CONFIRMED (guarded L4 only) |
| cancel (shopper, admin, expiry worker) | COD collection recording (L4 guarded) |
| COD confirmation call | remittance allocation (L5) |
| refund initiation | settlements and payouts (L5) |
| payment reconciliation worker (per group) | inventory-only workflows (L6) |

Shipment transitions do not need L1 because once a group is CONFIRMED nothing else changes its payment state except refund initiation, which is serialized with them through the guarded L4 row of the refund/shipment.

The full per-workflow lock table (25 workflows: rows locked, order, nested calls, retry, 409/503 mapping) is in `05-race-matrix.md` §2.

## 5. Isolation, retries and error mapping

**TD-01 — CONDITIONALLY APPROVED (2026-10-24): isolation is chosen per workflow.**

- **Read Committed + explicit locks + guarded updates** is used *selectively*, for workflows whose invariants are fully expressed as guarded single-row updates and CHECK constraints: checkout reservation (`WHERE "onHand" - reserved >= $q`), cancel/release, proof claim/approve/reject, shipment transitions, payout transitions. Under Serializable those workflows abort (`40001`) for reasons unrelated to business conflicts; with guarded updates the outcome is deterministic and the only retryable errors left are deadlocks (prevented by §4) and lock timeouts.
- **Serializable is retained where necessary**: any workflow that reads a set of rows it does not lock and decides from that read — e.g. category subtree writes (`categories.repository.ts:98`, unchanged), statement generation if its eligibility query cannot be fully locked (`05` §2 W27), any future multi-row selection.
- **Condition:** a workflow moves from Serializable to Read Committed only when its real-PostgreSQL concurrency tests (`05-race-matrix.md`) pass on Read Committed. Until then it keeps today's isolation (`checkout.repository.ts:114`, `orders.repository.ts:159` stay Serializable). The isolation of each workflow is a column in `05` §2.
- `withRetryableTx` handles `40001` for Serializable workflows and `40P01`/`55P03` for all.

**`withRetryableTx(fn, opts)`** — one helper, used by every write workflow:

| Error | Code | Action |
|---|---|---|
| Serialization failure | `40001` / Prisma `P2034` | retry |
| Deadlock detected | `40P01` | retry (should not happen; logged as a lock-order bug) |
| Lock timeout | `55P03` | retry |
| Unique violation on an idempotency/claim key | `23505` / `P2002` | **not** retried — mapped by the caller to the idempotent result or 409 |
| CHECK violation | `23514` | not retried — 409 `STATE_CONFLICT` (invariant would break) |
| Business exceptions (`HttpException`, domain errors) | — | never retried |

- Attempts: 3 (configurable). Backoff: `base × 2^n` with full jitter (base 25 ms, cap 500 ms).
- Exhausted retries: 503 `TRY_AGAIN` with `Retry-After: 1` for contention (`40001`/`40P01`/`55P03`); 409 `STATE_CONFLICT` where the losing side lost a business race.
- The helper re-runs the **whole** transaction function, so the function must be pure with respect to the outside world (principle 6).
- `AllExceptionsFilter` gains mappings for `P2034`, `23514`, `55P03`, `40P01` so nothing surfaces as a raw 500 (fixes R10, R24).

## 6. Idempotency

Two kinds, never confused:

**6.1 HTTP idempotency (client retries).** Table `idempotency_keys`:
`(id, userId, scope, key, requestHash, status IN_PROGRESS|COMPLETED|FAILED_RETRYABLE, responseStatus, responseBody jsonb, resourceType, resourceId, lockedUntil, createdAt, expiresAt)` with `@@unique([userId, scope, key])`.

Flow for a mutating request carrying `Idempotency-Key`:
1. `INSERT … ON CONFLICT DO NOTHING RETURNING` in its own short transaction (atomic claim).
2. Conflict → read the row:
   - same `requestHash`, `COMPLETED` → replay stored status + body (no side effects);
   - same hash, `IN_PROGRESS` and `lockedUntil` in the future → 409 `REQUEST_IN_PROGRESS` with `Retry-After`;
   - same hash, `IN_PROGRESS` and expired (crashed worker) → take over by guarded update of `lockedUntil`;
   - different `requestHash` → 422 `IDEMPOTENCY_KEY_REUSED`.
3. The business transaction runs; its **last statement** marks the key `COMPLETED` with the response, in the same transaction. If the business transaction rolls back, the key is set `FAILED_RETRYABLE` (a retry with the same key re-executes).
4. Keys expire after 24 h (cleanup job).

Scopes: `checkout`, `retry-payment`, `proof-submit`, `cancel`, `return-request`. During the compatibility window (C8) the key is optional; absent a key, Phase 0 still protects checkout by reading and locking the cart inside the transaction and verifying the deleted-row count (`checkout` §R5).

**6.2 Internal idempotency (workers, webhooks, postings).** Natural unique keys, enforced by the database:
- provider events `@@unique([provider, providerEventId])`
- ledger journals `@@unique([sourceType, sourceId, postingKind])`
- inventory movements `sourceEventKey @unique`
- outbox consumers `processed_events @@unique([consumer, eventId])`
- reference claims `@@unique([channel, normalizedRef])`
- settlement lines `ledgerEntryId @unique`

## 7. Events: transactional outbox (TD-06 — pending Youssef)

**Guarantee: at-least-once delivery to idempotent consumers.** Not exactly-once; exactly-once *effects* are achieved per consumer by the `processed_events` key. **Inline processing after commit is an optimisation, never the reliability mechanism** — reliability comes from durable rows, leases and the recovery paths in §7.5. *(Rewritten 2026-10-25: the earlier `PENDING|DISPATCHED|DEAD` design assumed a broker; while workers are postponed (TD-13) consumers are invoked directly, so delivery state is tracked per consumer.)*

### 7.1 Atomic creation (OBX-01)
- `outbox_events(id uuid, aggregateType, aggregateId, sequence, type, payload jsonb, payloadVersion, correlationId, createdAt)` — `@@unique([aggregateType, aggregateId, sequence])`. Written in the business transaction (L7), so the event exists **iff** the business change committed. An API crash after commit cannot lose it: the row is already durable.
- In the same transaction, one `outbox_deliveries` row per registered consumer of that event type (`02` §3.9): `(id, eventId, consumer, status, attempts, availableAt, leaseOwner, leaseUntil, lastError, processedAt)`, `@@unique([eventId, consumer])`. The consumer list per type is a static registry in code (`infra/outbox/consumers.ts`) — the allow-list of §7.8.
- Nothing is published inside the transaction (consistent with CLAUDE.md "events fire after commit": the *row* is written inside; processing happens after; C9).

### 7.2 Inline processing (OBX-02)
After the response-producing transaction commits, the request *may* try to process the deliveries it just created, through exactly the same claim → consume → complete path as every other path (§7.3–7.4). If the inline attempt fails, times out or the process dies, the delivery simply stays PENDING / PROCESSING-with-lease and is picked up by §7.5. Inline processing never deletes, skips or marks an event as done without running its consumer.

### 7.3 Delivery lifecycle (`03` §16)

| From | To | When |
|---|---|---|
| — | PENDING | created with the event |
| PENDING (due), PROCESSING (lease expired) | PROCESSING | claimed by an instance (lease set, `attempts += 1`) |
| PROCESSING | PROCESSED | consumer succeeded; guarded completion by the lease owner |
| PROCESSING | PENDING (retry) | retryable failure: `availableAt = now() + backoff(attempts)`, `lastError` stored |
| PROCESSING / PENDING | DEAD | non-retryable failure (schema/validation, poison) **or** `attempts` reached the maximum |
| DEAD | PENDING | manual requeue by PLATFORM_OPERATOR with a reason (audited) |

Retry schedule (proposed, configurable): 1 s, 5 s, 30 s, 2 min, 10 min, then every 10 min; **maximum 10 attempts** → DEAD. Events and deliveries are never deleted by the application; retention/archiving is an operational decision (SD-05).

### 7.4 Claim, lease and stale-PROCESSING recovery (OBX-03)
Claim is one statement using **database time only** (never the application clock):

```sql
UPDATE outbox_deliveries d
   SET status = 'PROCESSING', lease_owner = $instanceId,
       lease_until = now() + $lease, attempts = d.attempts + 1
 WHERE d.id IN (
   SELECT id FROM outbox_deliveries
    WHERE (status = 'PENDING' AND available_at <= now())
       OR (status = 'PROCESSING' AND lease_until < now())      -- stale: owner crashed or hung
    ORDER BY id
    LIMIT $batch
    FOR UPDATE SKIP LOCKED)
RETURNING d.*;
```

- **Lease:** 60 s (configurable), always longer than the hard consumer timeout (30 s); a consumer exceeding its timeout is aborted by the processor. A crashed or hung instance therefore leaves a PROCESSING row whose lease expires and which the next claim reclaims. Each reclaim increments `attempts`, so a consumer that always crashes ends in DEAD instead of looping forever.
- **Consumer transaction:** `INSERT INTO processed_events(consumer, event_id) ON CONFLICT DO NOTHING RETURNING` → nothing returned = already applied → skip to completion; else apply the consumer's DB effects → **guarded completion** `UPDATE outbox_deliveries SET status='PROCESSED', processed_at=now() WHERE id=$id AND lease_owner=$instanceId AND status='PROCESSING'` — all in one transaction. If the completion updates 0 rows (the lease was taken over), the transaction rolls back, including the `processed_events` insert; the new owner applies the effect once.
- **Concurrent API instances:** `FOR UPDATE SKIP LOCKED` + the lease guarantee that two instances never hold the same delivery at the same time; sequential double-processing (a late finisher after a takeover) is neutralised by the guarded completion and `processed_events`. Proven by C-O3 and C-O4 (`05`).

### 7.5 Recovery paths (OBX-04, OBX-05) — none is sufficient alone

| # | Path | Covers | Limits |
|---|---|---|---|
| 1 | Inline attempt after commit (§7.2) | the normal case, low latency | nothing if the process dies |
| 2 | Piggy-back drain: every request that writes events also claims up to 20 due deliveries | backlog while traffic flows | no traffic → no progress |
| 3 | **Boot-time sweep**: every instance, on start, runs one bounded claim loop (≤ 500 deliveries / 20 s) | crashes, restarts, deploys (stale leases are reclaimable at once if expired, or after ≤ 60 s) | only when an instance starts |
| 4 | `POST /admin/outbox/drain` (§7.9) | operator-triggered recovery | manual |
| 5 | **Scheduled drain** (worker architecture TD-23, pending; mechanism pattern of TD-18): a scheduled job on its own `outbox` queue, or the named operator (OD-02) per runbook, invokes the drain command on a fixed cadence (proposed every 5 min — independent of the 10-minute reservation-maintenance interval; at least daily) | quiet periods with no traffic or deploys | depends on TD-23 / OD-02 |
| 6 | Health metrics + alerts (§7.7) | detection of anything the above missed | detection only |

Paths 1–4 depend on traffic, deploys or a person noticing; **production requires 5 and 6** (OBX-05, OBX-06). Recovery after downtime or a deploy: the new instance's boot sweep (3) reclaims due and stale deliveries; anything left is visible in the metrics and drained by (5).

### 7.6 Idempotency and external effects (OBX-07)
- Every event has a stable `id` (UUID, generated in the business transaction) and every delivery a stable `(eventId, consumer)`; replays and reclaims carry the same ids.
- DB effects are de-duplicated by `processed_events(consumer, eventId)` in the consumer's transaction.
- External effects (push, e-mail, SMS): pass `eventId` (or `deliveryId`) as the provider's idempotency key where supported; otherwise write an effect row `PENDING` → send → `SENT`; a retry never resends a `SENT` effect; an effect stuck `PENDING` past its send timeout is resent **only** for effects documented as duplicate-tolerant (push notifications), otherwise escalated to OD-02 for reconciliation with the provider's records.

### 7.7 Monitoring (OBX-06)
`GET /health` (and the admin outbox report) expose: pending count, oldest pending age, deliveries in PROCESSING with an expired lease, retry count (deliveries with `attempts > 1`), failed-retryable count, DEAD count, deliveries per consumer. **Alert thresholds are TBD with the owner (OD-02)**; proposed starting values: oldest pending > 15 min, any expired-lease PROCESSING older than 5 min, any DEAD. Manual recovery procedure: `13-operational-readiness.md` §3.2.

### 7.8 Consumer invariant: no money or stock (OBX-08)
**No outbox consumer changes money, ledger, payment state or stock.** Every such change happens inside the business transaction of the request (or maintenance command) that caused it, under the lock order of §4. Consumers only notify, index or alert. Verified against every documented event (2026-10-25):

| Event | Written by | Consumers | Effect |
|---|---|---|---|
| `order_group.placed`, `order_group.completed` | checkout, completion (`03` §1) | notifications | in-app `Notification` row + push |
| `payment_proof.submitted` | proof submit (`payments-module-spec2.md` §4.3) | notifications (FINANCE queue alert) | notification |
| `payment_proof.sla_breached` | computed on read while TD-13 is postponed; event only if a scheduled run marks `escalatedAt` | notifications | notification to FINANCE_APPROVER |
| `payment_exception.opened` (late payment, mismatch) | webhook / review transaction (`05` race F2) | notifications | alert to FINANCE; the exception, refund-required status and journal are already in the business transaction |
| `intake.line_result`, `handover.discrepancy_ack_required`, `withdrawal.dispatched`, `withdrawal.discrepancy_recorded` (v7; formerly `intake.report_ready`) | intake line decision / receipt / withdrawal transitions (`19`) | notifications | vendor notification (NE-30, NE-53 – NE-55) |
| `inventory.discrepancy_detected` | reconciliation run (`inventory-module-spec.md` §6) | notifications | alert to OD-04 |
| fulfilment / payout / statement / refund / restriction / security notices (NE-01 – NE-52, `notifications-module-spec2.md` §4) | their business transactions | notifications | in-app `Notification` rows; push / e-mail effect rows once TD-20 is approved |

**Corrected contradiction:** an earlier version of this section let a consumer execute Paymob refunds with `eventId` as the idempotency key. Provider refund execution is **not** an outbox consumer: it is the Refund Execution machine (`03` §10) — guarded transition `APPROVED|RETRY_PENDING → PROCESSING` under the refund row lock (L3), provider idempotency key = refund id, result applied in its own transaction with ledger posting and audit, recovered by FINANCE-triggered retry or provider inquiry. It is deferred with FD-12 and blocked until TD-13 is revisited.

**Rule for the future:** a consumer that must change money or stock requires its own TD decision documenting its transaction boundary, lock level (§4), idempotency key and recovery before it is built. A test compares the consumer registry with this allow-list (AT-OB-10).

### 7.9 Admin endpoints (OBX-09)
| Endpoint | Permission | Rules |
|---|---|---|
| `GET /admin/outbox?status=&consumer=&type=` · `GET /admin/outbox/deliveries/:id` | PLATFORM_OPERATOR, FINANCE (read) | payload shown; no secrets are ever put in payloads |
| `POST /admin/outbox/drain` `{ max?: ≤ 500 }` | ADMIN + PLATFORM_OPERATOR | bounded (≤ 500 deliveries or 20 s), uses the normal claim path, rate-limited (1 concurrent run per instance, 6/min per admin), audited with actor and counts; idempotent |
| `PATCH /admin/outbox/deliveries/:id/requeue` `{ reason }` | ADMIN + PLATFORM_OPERATOR | DEAD → PENDING only, `attempts` reset recorded in the audit row; reason ≥ 10 chars |
| — | — | **no** endpoint deletes events/deliveries or edits payloads |

### 7.10 What cannot launch without automated recovery
PAYMOB (payment reconciliation; already disabled in production, R-D2/R-D4) and any provider-API refund (FD-12). Everything else tolerates delayed notifications because no money or stock depends on the outbox (§7.8), provided OBX-05 and OBX-06 are in place.

Existing `DomainEvents.emit` (in-process, no listeners) and `SearchIndexQueue` keep working; search enqueues may later move to the outbox (R17), not required for this programme.

## 8. Audit

**TD-03 — APPROVED 2026-10-24 for sensitive financial and inventory operations** (conflicts with `admin-module-spec.md` §5.2 and CLAUDE.md, which stay valid for moderation actions):

- **Mandatory audit** — every financial, inventory, payment-proof, refund, settlement, permission and exception action — is written with `auditService.recordInTx(tx, entry)` **inside** the business transaction. If the audit insert fails, the action fails.
- **Moderation audit** (vendor verify, rating delete, …) keeps today's best-effort `record()` after commit.
- `AdminAuditLog` is extended (TD-04) rather than replaced, so `GET /admin/audit-log` keeps working: `actorId` becomes nullable; new columns `actorType (USER|SYSTEM|PROVIDER)`, `source` (route, job name or `webhook:paymob`), `previousState jsonb`, `newState jsonb`, `correlationId`, `ledgerJournalId?`. New `AdminAction` / `AdminTargetType` values per workflow (listed per module spec).
- Idempotent no-op repeats write nothing (existing rule kept).

## 9. Correlation ids

Middleware reads `X-Request-Id` (or generates a UUID), stores it in `AsyncLocalStorage`, echoes it in the response header. Audit rows, outbox events, provider events and log lines carry it. Workers create one per job and propagate the originating event's id.

## 10. Payment-provider and file-storage side effects

- Paymob intention creation: `PaymentTransaction` row `CREATED` committed first → call Paymob → second transaction moves it to `INITIATED` (or `INITIATION_FAILED`). A crash between leaves a `CREATED` row that the reconciliation worker resolves (inquiry by `special_reference`, TQ-01) or expires. Never two intentions for one attempt row.
- Uploads: the presigned URL is issued after the proof upload record exists; acceptance re-validates the object server-side.

## 11. Conflicts with the existing repository and specs

Documented here rather than silently overridden. Each needs explicit approval (register id in brackets).

| # | Proposed | Conflicts with | Resolution proposed |
|---|---|---|---|
| C1 | Mandatory audit inside the transaction | `admin-module-spec.md` §5.2; CLAUDE.md "Audit is best-effort" | Two tiers (§8) [TD-03] |
| C2 | Read Committed + locks in checkout/cancel | `checkout.repository.ts:114`, `orders.repository.ts:159` (Serializable) | Change only with the concurrency suite green [TD-01] |
| C3 | DB triggers, partial unique indexes | repo uses only CHECKs; Prisma cannot see either; future `migrate dev` may emit `DROP INDEX` for unknown indexes (same class as the GIST problem) | Hand-written SQL + a test asserting each object exists + migration review checklist [TD-02] |
| C4 | Ledger and payment amounts as integer minor units with per-currency precision | `Decimal(12,2)` prices; `common/money.ts` hard-codes ×100 | Generalize `toMinor(amount, currency)`; keep Decimal on catalogue prices [FD-01] |
| C5 | Riven fulfils orders and may charge commission/fees | `riven-spec.md:11` ("no commission on product sales"); `fashion-marketplace-addendum.md` (vendors ship) | Business decision [BD-01, BD-02, FD-02] |
| C6 | Single webhook route `/webhooks/paymob` | `payments-module-spec.md` §5 (`/payments/webhook/paymob`) | Keep the single route (already the CLAUDE.md rule); spec2 supersedes |
| C7 | Delivery recorded by ops/courier | shopper `PATCH /orders/:id/confirm-delivery` (used by the app for ratings) | Keep the route; it records `shopperConfirmedAt` and only advances a non-COD shipment that is out for delivery (`fulfilment-module-spec.md` §6) [BD-20] |
| C8 | `Idempotency-Key` required on money/inventory POSTs | mobile app sends none | Optional during a compatibility window; required from API `v1` [TD-07] |
| C9 | Outbox row written inside the transaction | CLAUDE.md wording "events fire after commit, never inside" | Compatible (publish after commit); wording update proposed |
| C10 | Vendor stock edits become deltas / CAS | `PATCH /vendors/me/products/:id/variants/:variantId` absolute `stockQuantity` | No vendor frontend exists yet; scripts updated; field kept but requires `expectedStockQuantity` [TD-08] |
| C11 | Admin permissions within ADMIN | CLAUDE.md "four roles, no multi-role" | Roles unchanged; permissions are an attribute of ADMIN users only [SD-01] |
| C12 | Customer price = vendor rate + `RIVEN_PROFIT_PERCENTAGE` markup | today shoppers pay `priceOverride ?? basePrice` exactly as the vendor typed it (`checkout.service.ts:159`); search documents index those values (`infra/search/search-documents.ts:24-25`) | Business decision on the meaning of existing prices [FD-17]; materialized customer price + re-index [TD-14] |
| C13 | Riven revenue on product sales (markup) | `riven-spec.md:11` "No commission on product sales. No shopper-facing fees." | The markup is shopper-facing; needs Ibrahim's explicit override of the base spec [FD-02] |
| C14 | Vendor payable = vendor rate × quantity, nothing deducted | earlier drafts of `04` (commission and fulfilment fee deducted from the vendor) | Earlier examples superseded; `04` rewritten [FD-02] |
| C15 | Percentage configured by environment variable | this programme's rule that financial configuration changes are audited and maker-checked | Boot-time history row + audit [TD-15]; business approval with an effective date [FD-23] |
| C16 | Delivery fee is location-based and separate | earlier drafts assumed a single `SHIPPING_REVENUE` treatment | Treatment is a decision [FD-18] |
| C17 | Vendor-facing statuses (`PROCESSING`, `RETURNED`, …) | the six legacy `OrderStatus` values used by the mobile app | Separate vendor projection; the shopper enum is unchanged (`03` §14) |
| C18 | Background workers postponed | Phase 0 design (expiry, reconciliation, outbox drainer, SLA) assumed workers | Temporary alternatives (§13); PAYMOB disabled in production until resolved [TD-13] |
| C19 | Only received and verified stock is sellable | today vendors' typed stock is sellable immediately | Proposed BD-08 / BD-15; existing listings become unavailable at cutover until taken in |
| C20 | `basePrice` / `priceOverride` mean "vendor rate" on vendor routes but carry the customer price on public routes | today one meaning everywhere; the mobile app reads these fields (`products/product-visibility.ts:25,36`, `Riven-App/src/utils/money.ts`) | Keep the app working without a release: public routes return customer prices in the existing fields + additive `customerPrice`; vendor/admin routes add explicit `vendorRate` (`pricing-module-spec.md` §4.3) [TD-14, FD-17] |
| C21 | Separate vendor commerce restriction levels and a guaranteed financial-access scope | `admin-module-spec3.md` B1 (closed: suspend = reject, no separate state); `User.isActive=false` blocks all access (`auth.repository.ts:25`) | Proposal only, pending [BD-31, BD-32, SD-09]; B1 stays in force until Ibrahim decides (`vendor-module-spec3.md` §10) |
| C22 | Production launch only after Phases 0–7 and the PRG gate | this programme's earlier `README.md` milestone "first real customer orders: end of Phase 4" | Youssef's 2026-10-25 brief governs; README corrected; business acceptance [BD-33] |
| C23 | The 2026-10-25 brief lists "Cloudinary unavailable" as a failure scenario | the repository has no Cloudinary integration; uploads use S3-compatible storage (`infra/storage/storage.service.ts`, MinIO locally) | Runbook written for "object storage" generally; which provider production uses is TQ-05 / TQ-22 |
| C24 | Outbox consumers never move money or stock | an earlier version of §7 let a consumer execute Paymob refunds; `03` §10 named a "worker (Paymob API)" | Corrected in §7.8 and `03` §10: provider refunds belong to the Refund Execution machine (FD-12, deferred) |
| C25 | Commerce flows need transactional notifications (payment, refund, payout, security notices) | BD-23 "Notification channels" is DEFERRED | BD-23 kept as recorded (optional / marketing channels); the transactional subset is the new BD-35 (`notifications-module-spec2.md`) |
| C26 | Commerce notifications are produced from the transactional outbox | `notifications-module-spec.md` (pass 1) fans out bazaar alerts from in-process domain events (best-effort, after commit) | Both coexist: bazaar alerts keep pass 1's path; commerce notices use the outbox; moving bazaar alerts later is optional (R17) |
| C27 | Single authorized admin approval for intake lines, intake disputes and inventory adjustments (BD-38) | earlier design: intake verifier ≠ receiver; dispute resolution and adjustments maker-checker (`07` §2–3, §12; TD-08 v6) | BD-38 approved (Ibrahim, reported by Youssef 2026-10-27) governs for those inventory actions only; financial maker-checker pairs unchanged; self-approval is SD-11 (pending) |
| C28 | The intake brief (2026-10-27) describes the platform as Express.js | the repository is NestJS (`apps/api`, CLAUDE.md) | Docs stay framework-neutral; brief wording not adopted |
| C29 | Temporary flat delivery fee 80.00 EGP per order (FD-29, approved) | location-based zones (FD-04 / BD-30, pending) | Flat fee implemented as one national zone with one rate; zones remain the target model |
| C30 | The cart-pricing brief calls its decision "FD-17 Option C" | in the register FD-17 = meaning of existing prices; cart behaviour = FD-21 | Recorded as FD-21 (approved); FD-17 stays open |
| C31 | PAYMOB-specific work (attempt lifecycle, inbox processing, reconciliation, late-success recovery, legacy projection) moves out of Phase 0 to a later PAYMOB activation milestone | the earlier Phase 0 scope (README, `10` §5) included the Paymob hardening (R2, R6, R9, R19, R20, R25) | TD-21 (Youssef 2026-10-27): deferred, not rejected; PAYMOB stays disabled in production so those code paths are unreachable meanwhile; existing Paymob tests stay green |
| C32 | Scheduled reservation maintenance is required | `01` §13 accepted on-access ("lazy") expiry with "stock held until something touches it" as the residual risk | requirement MNT-01 – MNT-06 (Youssef 2026-10-27); mechanism TD-18 pending |
| C33 | TD-18 proposal: a **dedicated** BullMQ reservation-expiration worker | TD-13 (approved 2026-10-24): no new background workers for now | TD-13 unchanged; the proposed exception is the separate decision **TD-22** (pending) — it permits only the reservation-expiration worker and its schedule reconciler, no other worker (`21` §8.4); meanwhile the existing in-process `expire-pending-checkouts` job remains the executor |

### 11.1 Corrections made in the 2026-10-25 gap-closure pass

These change earlier text of this programme's own documents (not approved decisions); each is listed so none is silent.

| Document | Earlier text | Corrected to | Why |
|---|---|---|---|
| `06` §3.2 | `VENDOR_PREMISES` warehouses created with `sellable` "default true so behaviour is unchanged" | created with `sellable = false`; only a recorded configuration change can set it true, and only if Ibrahim rejects BD-08 | verified-only stock (BD-08 baseline); existing stock must not become sellable automatically (`06` §3.5) |
| `01` §7 | outbox statuses `PENDING/DISPATCHED/DEAD`, broker drain | per-consumer deliveries with leases and six recovery paths | no broker while TD-13 is postponed; inline drain alone is not reliable |
| `01` §7, `03` §10 | Paymob refunds executed by an outbox consumer / "worker (Paymob API)" | Refund Execution machine, deferred (FD-12) | consumer invariant (C24) |
| `03` §9 | one return state chain ending in an automatically created refund on CLOSE | five separate machines; a refund is only *requested* from accepted inspection lines and needs approval and a separate execution | no automatic refund (RET-01) |
| `README.md` | "first real customer orders: end of Phase 4" | production launch only after Phases 0–7 + PRG gate | C22 |
| `04` §7.10 | return example used FD-19's recommended option without saying the alternative | both FD-19 options shown; neither assumed | FD-19 is pending |
| `13` §1.10 (v6) | a single `FINANCE_FREEZE` switch for financial incidents | workflow-level and entity-level holds on outbound money; facts never held (`07` §14, TD-19) | a global freeze would block recording facts (arrived payments, collections, deliveries) |
| `08` TD-13 row (v6) | "APPROVED (implementation postponed)" without qualification | approval of the postponement only; recovery mechanisms (R-D1–R-D7, TD-18, OBX-05/06, PRG-03) remain required | the label must not read as "production can run without recovery" |
| `08` FD-11 row (v6) | severity "raised from IMPORTANT" | the raise is marked as a documentation proposal awaiting Ibrahim's confirmation | severity changes are not approvals |
| `03` §6.4, `inventory-module-spec.md` §5 (v7) | intake: one status field, verifier ≠ receiver, vendor response to every intake, two-person dispute corrections | `19`: four status fields, partial per-line approval by one admin, disputed-quantity freeze, acknowledgment only on discrepancy | BD-36 – BD-40 approved (Ibrahim, reported by Youssef 2026-10-27) |
| `08` BD-25 (v7) | "vendor responds to every intake within 7 days; silence = acknowledged" | acknowledgment only when quantities differ; deadline → BD-41 | revised by Ibrahim (reported by Youssef) |
| `17` §4.3 / `02` (v7) | vendor adjustment requests included WITHDRAW and RECALL | withdrawals and recalls use the stock-withdrawal workflow (`19` §10.3); requests keep DAMAGE_REPORTED, COUNT_ERROR | one workflow per purpose (no duplicate withdrawal paths) |
| `inventory-module-spec.md` §4 (v7) | `POST /vendors/me/stock-returns` | `POST /vendors/me/stock-withdrawals` with authorized / dispatched / vendor-received quantities | Part 3 brief; customer returns stay separate |
| `pricing-module-spec.md` §2 (v7) | "nobody can change the percentage through the API" | configuration only *for now*; a dynamic source is pending FD-28 | FD-02 approved with the condition that the markup becomes dynamic |
| `00`–`20` (v7) | `available = on_hand − reserved` | `available = on_hand − reserved − held` | holds for dispute freezes and withdrawals |

## 12. Where this design deliberately stays simple

- **One warehouse row** (plus one `VENDOR_PREMISES` location per vendor) instead of a warehouse-management system; transfers between Riven warehouses are not designed until a second warehouse exists (BD-21, DEFERRED).
- **No event sourcing**: tables hold current state; append-only logs hold history.
- **No generic approval engine**: maker-checker is two columns and a CHECK on the rows that need it.
- **No stored balances**: derived by `SUM`; materialized views only if measured slow.
- **No courier API integration** in v1: manual entry by ops (BD-22, DEFERRED).
- **No websockets / SSE for the vendor portal**: polling over fresh reads (TD-16).

## 13. Operating without background workers (TD-13 postponed)

Decision 2026-10-24: no new background worker is built for now. Every workflow that would rely on one gets a **safe temporary alternative**, whose safety comes from the same property: each operation is an idempotent guarded transition, so it produces the same result whether a worker, a request, or an admin triggers it, and running it late or twice is harmless.

**Assumption to confirm (TQ-15):** the existing *in-process* BullMQ jobs — order expiry (`modules/orders/jobs/`), search sync (`modules/search/jobs/`), bazaar auto-complete (`modules/bazaars/jobs/`) — keep running inside the API process wherever the API runs with Redis. "Postponed" is read as "no new worker process and no new scheduled jobs", not "remove existing ones". If the intention is otherwise, the alternatives below still hold, with the API process as the only executor.

| Workflow | Would need | Temporary alternative | Safety argument | Residual risk |
|---|---|---|---|---|
| Reservation expiry (all methods) | periodic sweep | (1) **lazy expiry**: every request that touches a group (payment read, retry, proof submit, cancel, admin list/detail) first applies any overdue expiry to that group in its own short transaction (L1 → L2 → L6); (2) **sweep-before-reserve**: before a checkout transaction, a separate transaction releases overdue reservations on the cart's variants (one group at a time, proper lock order); (3) existing in-process expiry job if running; (4) admin `POST /admin/maintenance/expire-overdue` (PLATFORM_OPERATOR, audited) | guarded, idempotent release; cap times are stored, so late execution releases exactly what is due | *(2026-10-27, Youssef)* on-access expiry alone is **not sufficient** — an abandoned order nobody opens would hold stock; a **scheduled** run of the expire-overdue command every **10 min** (proposed) is **required** in production (`21` §8, MNT-01 – MNT-18; R-D8). Proposed mechanism (TD-18, pending formal approval): the existing BullMQ `expire-pending-checkouts` job scheduler (today `*/5 * * * *` in code; proposed `*/10 * * * *`), protected by schedule reconciliation, executed by a dedicated reservation-expiration worker (TD-22, pending), PostgreSQL deciding eligibility (`21` §8.1 – §8.4; C33) |
| Paymob reconciliation (webhook never arrives) | periodic inquiry | **PAYMOB stays disabled in production** (env unset) while workers are postponed; in non-production, lazy inquiry on `GET /orders/groups/:id/payment` for an attempt past `expiresAt` (rate-limited per group) | no real Paymob money can be lost if Paymob is off | none in production; enabling Paymob requires revisiting TD-13 (deployment requirement R-D4) |
| Outbox delivery | drainer | the six recovery paths of §7.5: inline attempt (optimisation only), piggy-back drain, boot-time sweep, admin drain, **scheduled operator drain (TD-18)**, health alerts; leases make stale PROCESSING rows reclaimable (§7.4) | rows are durable (written in-tx); claims use `SKIP LOCKED` + leases; consumers are idempotent (`processed_events`); no consumer moves money or stock (§7.8) | delivery delayed, never lost; production requires the scheduled drain and alerts (OBX-05, OBX-06) |
| Proof review SLA escalation | periodic scan | **computed on read**: the admin proof queue sorts by `reviewDueAt` and flags `overdue = now > reviewDueAt`; escalation is a dashboard state, not a push | nothing is written by time passing | no push notification to FINANCE_APPROVER; daily queue check is an operating duty |
| Transfer submit / resubmit windows | periodic sweep | the **scheduled** expire-overdue run (MNT-01, required 2026-10-27) plus lazy expiry when the group is next touched; the proof-submit endpoint rejects late submissions by comparing stored deadlines | deadlines are stored timestamps | — |
| COD confirmation window | periodic sweep | the scheduled expire-overdue run (MNT-01) + lazy expiry + the OPS confirmation queue sorted by deadline; never applies after courier handover (`21` §3.3) | as above | — |
| Inventory reconciliation, ledger verification, projection checks | nightly jobs | admin `POST /admin/inventory/reconcile`, `POST /admin/ledger/verify` (PLATFORM_OPERATOR), run daily per runbook; the same checks run in CI on test data | read-mostly; results written as discrepancy rows | a drift is found up to a day late |
| Idempotency-key cleanup | periodic delete | expired keys are treated as absent and overwritten on the next claim (`expiresAt < now()`); manual purge endpoint | correctness does not depend on deletion | table growth (small) |
| Monthly vendor statements | scheduled job | FINANCE triggers `POST /admin/vendor-statements/generate { period }`; generation is idempotent per (vendor, period) | unique key prevents duplicates | statements issued only when someone runs it |
| Deemed acknowledgments (intake, payout receipt) | timers | **computed on read** from stored deadlines (`DEEMED_ACKNOWLEDGED`, `DEEMED_RECEIVED_IN_FULL`) | nothing written by time passing | — |
| Proof-image / receipt retention deletion | periodic delete | manual admin action per SD-05 | — | images kept longer than policy until run |
| Search re-index after re-pricing (TD-14) | queue | existing in-process search-sync queue (if running) or admin reindex (existing `/admin/search/reindex`) | existing mechanism | — |

### 13.1 Production deployment requirements (explicit)

| # | Requirement | Needed for |
|---|---|---|
| R-D1 | The API process runs continuously (not sleeping on idle) with PostgreSQL and Redis reachable | lazy expiry only works when requests arrive; existing in-process jobs |
| R-D2 | `PAYMOB_*` unset in production | while no reconciliation worker exists |
| R-D3 | An operator (named in the runbook) **verifies daily** that the 10-minute scheduled expire-overdue runs succeeded (R-D8, `MaintenanceRun`) and runs, daily: outbox drain (unless scheduled), inventory reconcile, ledger verify; and checks the proof queue twice per business day | every alternative above |
| R-D4 | Before enabling PAYMOB, a payment-reconciliation executor exists (worker or equivalent) and C-X1 passes in that deployment; PMA-01 – PMA-08 met (`21` §5.1) | PAYMOB activation milestone (deferred, TD-21) |
| R-D8 | A scheduled executor runs `expire-overdue` every **10 min** (proposed: BullMQ scheduler with schedule reconciliation + dedicated worker, TD-18 / TD-22) and the outbox drain (TD-23), with the MNT-06 / MNT-10 alerts (computed from PostgreSQL; no successful run 25 min, overdue 30 min) wired to OD-01; Redis configured and verified per `21` §8.3 (`noeviction`, persistence, retention, monitoring — TQ-27); the worker process deployed and supervised (restarted on exit) on the chosen host (TQ-16) | Phase 0 go-live (any production deployment) |
| R-D5 | Private object storage bucket configured (TQ-05) | transfer proofs, payout receipts |
| R-D6 | Backups / PITR confirmed (TQ-07) before any production migration | all phases |
| R-D7 | `GET /health` exposes: overdue reservations count, outbox PENDING age, open discrepancies, overdue proofs | monitoring the manual cadence |

When TD-13 is revisited, each alternative is replaced by a scheduled job calling the **same** service method, so behaviour does not change — only who triggers it.
