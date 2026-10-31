# 06 — Migration Plan

> Status: **DRAFT for review** · 2026-10-24, updated 2026-10-25 (pricing §5.3.1, delivery zones §5.3.2, intake responses, statements, payouts and receipt confirmations). **No migration exists yet.** This document defines how each phase's schema changes reach production safely. Production is Supabase PostgreSQL (version to confirm, TQ-06); local and CI run `postgis/postgis:16-3.4`.

## 1. Rules

1. **Expand → migrate → contract.** Each phase first *adds* (nullable columns, new tables, shadow writes), then moves readers, and only later *removes or tightens*. A deploy of the previous application version must still work against the expanded schema.
2. **Never change the meaning of an existing column.** `stockQuantity` keeps "units a shopper can buy now"; `paymob*` keep their meaning as a projection; `Order.status` keeps its six values.
3. **Nothing financial or inventory-related is deleted or rewritten** by a migration. Backfills insert; corrections are new rows.
4. **Prisma stays on 6.x** (CLAUDE.md). Hand-written SQL (triggers, partial indexes, CHECKs, `NULLS NOT DISTINCT`) is appended to the generated migration file and registered in `prisma/hand-sql-objects.json`; a test asserts each object exists (`02-data-model.md` §5).
5. **Every migration is reviewed for** `DROP INDEX` / `DROP TRIGGER` / `DROP CONSTRAINT` on the four GIST indexes and on every hand-SQL object, before merge.
6. **Every phase migration is rehearsed on a restored production snapshot** (§7) and timed before it runs on production.
7. **Backups:** a manual backup (or confirmed point-in-time-recovery window) is taken immediately before each production migration (TQ-07).

## 2. Production data assumptions to verify first (read-only queries, run before Phase 0)

| Check | Why | Expected today |
|---|---|---|
| `SELECT count(*) FROM product_variants WHERE "stockQuantity" < 0` | CHECK must validate | 0 |
| groups with any Paymob field set; groups with `paidAt` | backfill of `payment_transactions`; whether real money exists | Paymob never live → only demo/test rows |
| orders by status | backfill of reservations and group status | small numbers, demo data |
| `PENDING` groups older than TTL | expiry job health | 0 |
| variants with `deletedAt` that appear in PENDING orders | movement backfill edge case | few |
| row counts of `order_groups`, `orders`, `order_items`, `product_variants`, `refresh_tokens` | lock-duration estimate | small (thousands at most) |
| PostgreSQL version | `NULLS NOT DISTINCT` needs ≥ 15 | TQ-06 |
| any rows written by `scripts/demo-data.mjs` "pay" mode in production | must not become real ledger money | to be identified and excluded from opening balances |

Results are attached to the Phase 0 report. If real money exists (unexpected), opening-balance journals are designed before Phase 3 (§5.3).

## 3. Inventory: one source of truth at every moment (review point 2)

| Stage | Authoritative | Derived / shadow | Who writes what |
|---|---|---|---|
| Today | `product_variants.stockQuantity` | — | vendors (absolute), checkout (−), cancel (+) |
| **Phase 0** | `stockQuantity` | `inventory_movements` journal (every change, same tx) | checkout `RESERVE`, cancel/expiry `RELEASE`, vendor `VENDOR_ADJUSTMENT` (delta or CAS), migration `OPENING_BALANCE` |
| **Phase 1a — shadow** | `stockQuantity` | `inventory_balances` + `stock_reservations`, written in the same tx as every `stockQuantity` change; **never read for decisions** | as Phase 0 + shadow writes |
| **Phase 1b — cutover** | `inventory_balances` + `stock_reservations` | `stockQuantity` = DB-trigger projection (Σ available over warehouses where `sellable`) | inventory service only; application code can no longer write `stockQuantity` (repository method removed, lint rule) |

### 3.1 Phase 0 vendor adjustment, and how it maps forward

Phase 0 API: `PATCH /vendors/me/products/:id/variants/:variantId/stock` with either `{ delta, reason }` or `{ setTo, expectedStockQuantity, reason }`.
- delta: `UPDATE product_variants SET "stockQuantity" = "stockQuantity" + $d WHERE id = $v AND "stockQuantity" + $d >= 0` → 0 rows → 409 `ADJUSTMENT_NEGATIVE`.
- CAS: `… SET "stockQuantity" = $setTo WHERE id = $v AND "stockQuantity" = $expected` → 0 rows → 409 `STOCK_CHANGED` (body carries the current value).
- Either writes a `VENDOR_ADJUSTMENT` movement with `deltaStockQuantity` = actual change, same tx.
- The existing `stockQuantity` field on the variant create/update DTOs: create keeps it (initial stock, `OPENING_BALANCE` movement); update rejects it with 400 `USE_STOCK_ENDPOINT` (C10, TD-08).

After cutover (1b) the same endpoint operates on the vendor's `VENDOR_PREMISES` balance: `on_hand += d WHERE on_hand + d >= reserved`; CAS compares `on_hand`. Vendors can never touch a `RIVEN` balance (only intake does). Whether `VENDOR_PREMISES` stock is sellable at all is BD-08 (`warehouses.sellable`).

### 3.2 Phase 1a backfill (shadow)

1. Migration creates the tables, seeds `currencies(EGP,2)`, one `RIVEN` warehouse and one `VENDOR_PREMISES` warehouse per marketplace vendor — **all with `sellable = false`**. *(Corrected 2026-10-25: this step previously said premises `sellable` "default true so behaviour is unchanged", which would have made vendor-declared stock sellable after cutover; see §3.5 and `01` §11.1.)* During 1a nothing reads `sellable` for decisions (balances are a shadow), so behaviour is unchanged until 1b.
2. Deploy code that **shadow-writes** balances/reservations in the same transaction as each authoritative change (upsert of the balance row, guarded deltas).
3. Run the **backfill job** (idempotent, re-runnable), per variant inside one short transaction that locks that variant's row (`SELECT … FOR UPDATE` on `product_variants`, L6):
   - `reserved` = Σ quantity of order items whose order is PENDING, PAID or FULFILLED (not yet shipped) → one `StockReservation` per item (ACTIVE for PENDING with the group's expiry, CONFIRMED otherwise; `sourceEventKey` prevents duplicates);
   - `on_hand` = `stockQuantity + reserved` at the vendor's premises location;
   - one `OPENING_BALANCE` movement per balance (Phase 1 types).
   Because the variant row is locked, no checkout or adjustment can interleave for that variant during its backfill step; shadow writes started in step 2 keep it current afterwards.
4. **Reconciliation job** (nightly + on demand) compares, per variant: `stockQuantity` vs Σ available (sellable locations); `reserved` vs Σ open reservations; counters vs Σ movements. Differences → `inventory_discrepancies` (OPEN). **Never auto-corrected**; resolution is an `InventoryAdjustment` with maker-checker, or a re-run of the backfill for that variant by PLATFORM_OPERATOR (audited).

### 3.3 Phase 1b cutover

Gate: zero OPEN discrepancies for 7 consecutive days (configurable) + approval (TD-09).
1. `CHECKOUT_PAUSED=true` (feature flag; checkout, cancel, adjustments return 503 `TRY_AGAIN` with `Retry-After: 30`; reads continue). Expected pause: < 1 minute.
2. Final reconciliation run → must report zero differences, else abort and unpause.
3. Install the projection trigger (`product_variants_stock_projection`) and the inventory-authority flag `INVENTORY_AUTHORITY=balances` (both code paths ship in the 1b release; the flag selects which one writes).
4. Unpause. Contract test: `stockQuantity` in API responses equals Σ available.

**Rollback 1b → 1a:** pause; set `INVENTORY_AUTHORITY=stock_quantity`; disable the projection trigger (`ALTER TABLE … DISABLE TRIGGER`), since `stockQuantity` already equals the projection at that instant; unpause. Balances continue as shadow. Movements are never deleted in either direction.

### 3.4 Migration consistency test (review point 10)
C-M1 (`05-race-matrix.md` §4): backfill under 50 checkouts/s → zero discrepancies afterwards; plus a cutover rehearsal test that pauses, flips, unpauses under load and asserts no request saw a mixed state (every response's `stockQuantity` matches the authority in force).

### 3.5 Classifying existing stock (verified-only inventory, INV-07; added 2026-10-25)

**Rule:** no existing stock becomes sellable because of a migration. Every unit that exists today was typed by a vendor (`stockQuantity`, absolute writes); none has been physically received or verified by Riven. It is therefore classified **VENDOR_DECLARED** at every stage:

| Stage | What happens to existing stock | Sellable? |
|---|---|---|
| Phase 0 (M0.5) | one `OPENING_BALANCE` movement per variant = current `stockQuantity`, `origin = VENDOR_DECLARED` | still purchasable in **non-production** through today's code; production commerce is closed by the gate (PRG, BD-33) |
| Phase 1a (shadow) | backfilled as `on_hand` at the vendor's `VENDOR_PREMISES` warehouse (`sellable = false`), `origin = VENDOR_DECLARED`; open legacy orders get premises reservations | shadow only; nothing reads it for decisions |
| Phase 1b (cutover) | projection = Σ available over **sellable** warehouses → `stockQuantity` becomes **0 for every product** until intake; premises balances remain as the vendor's declared count | **no** |
| Phase 2 (intake) | the vendor creates an intake (declared quantities may be pre-filled from the premises balance); Riven receives, inspects and verifies; only `acceptedQty` posts `INTAKE_ACCEPTED` at the `RIVEN` warehouse with `origin = RIVEN_VERIFIED` | **only accepted units**, under BD-24 |

Guarantees:
- **No migration step, backfill or script moves units from a `VENDOR_PREMISES` balance to a `RIVEN` balance.** The only writers of positive `on_hand` at RIVEN are intake verification, inspected return restock and maker-checked stocktake/adjustment (`inventory-module-spec.md` §11).
- The `RIVEN` warehouse becomes `sellable = true` by a recorded, audited configuration change when Phase 2 ships (before its first intake is verified); `VENDOR_PREMISES` stays false unless Ibrahim rejects BD-08 (then a recorded change per vendor, never a migration default).
- **Open legacy orders** at cutover keep their premises reservations and finish through the legacy vendor flow (`fulfilmentMode = VENDOR`); their release returns units to the premises balance, never to RIVEN.
- **Catalogue:** products remain visible with 0 available after 1b until their first verified intake; hiding them instead is BD-34 (pending).
- Tests: AT-INV-10 (migrated stock not purchasable after 1b), AT-INV-11 (no path from premises to RIVEN), AT-INV-12 (intake is the only path to sellable stock).

## 4. Paymob: new model authoritative, legacy fields as projection (review point 7)

> *2026-10-27 (TD-21):* PAYMOB is **deferred, not rejected**. The dual-write, backfill and reader moves below run at the **PAYMOB activation milestone**, not in Phase 0. Until then the existing Paymob code and columns stay untouched and unreachable in production (`PAYMOB_*` unset); the generic `payment_transactions` / `payment_exceptions` tables still arrive with Phase 0 / 3b for TRANSFER and COD.

| Item | Decision |
|---|---|
| Authoritative | `payment_transactions` + `payment_provider_events` (from Phase 0) |
| Projection | `OrderGroup.paymobIntentId`, `paymobOrderId`, `paymobTransactionId`, `paidAmountCents`, `paidAt` |
| Single writer | `projectLegacyPaymentFieldsInTx(tx, orderGroupId)` — recomputes the five fields from the group's latest PAYMOB attempt (by `attemptNo`) and writes them; called in the **same transaction** as every PaymentTransaction change. Nothing else may write these columns (lint rule + grep test). |
| Atomicity | one DB transaction; if the projection fails, the whole transaction rolls back (webhook returns 500 → Paymob retries → inbox dedup makes the retry safe). There is no state in which the attempt changed and the projection did not. |
| Divergence detection | invariant query (`legacy fields ≠ projection(latest attempt)`) run after every e2e/concurrency test and nightly; any row → alert + `inventory_discrepancies`-style record (`payment_projection_discrepancies` view) |

### 4.1 Steps
1. **Expand (Phase 0):** create tables. Backfill one `PaymentTransaction` per group that has any Paymob field: `attemptNo 1`, `method PAYMOB`, status from data (`paymobTransactionId` + `paidAt` → SUCCEEDED; transaction id without `paidAt` → SUCCEEDED + exception backfilled as `PaymentException(LATE_PAYMENT or AMOUNT_MISMATCH)` from the stored amount vs expected; intent only → INITIATED if group PENDING else CANCELLED/EXPIRED). Backfill rows carry `providerEventId = 'backfill:<groupId>'` provenance in a `migrationSource` note.
2. **Dual-write:** webhook, checkout, retry-payment write the new model and call the projection.
3. **Move readers** one at a time, each a separate PR with the contract tests green: webhook matching (`findGroupByPaymobOrderId` → lookup by `payment_transactions.providerOrderId`, falling back to `providerIntentId`), `retry-payment` (open attempt), admin order detail (`ADMIN_ORDER_DETAIL_INCLUDE`), expiry selection.
4. **Keep projecting** indefinitely while any client might read the fields.
5. **Contract (removal) — only when all hold:** no code reader (grep + lint), mobile and web apps confirmed not reading them (mobile today types `paymobIntentId` but never reads it — `Riven-App/src/types/api.ts:478`), 30 days with zero divergence, approval (TD-10). Then a staged migration: stop projecting → wait one release → drop columns.

### 4.2 Contract tests
- Existing `order-payment.handler.spec.ts`, `paymob-webhook.dispatcher.spec.ts`, `paymob.service.spec.ts` pass **unmodified** (they mock the repository; the repository's public behaviour is preserved).
- `POST /checkout` (empty body) response still has `id`, `orders[].{id,subtotal}`, `paymentSetupFailed`, `clientUrl`, `paymobIntentId`.
- Projection invariant after every test.
- C-P1 fault injection (`05` §4).

## 5. Per-phase migration list

Format: change · backfill · nullability path · lock / downtime risk · recovery.

### 5.1 Phase 0
| # | Change | Backfill | Nullability | Lock risk | Recovery |
|---|---|---|---|---|---|
| M0.1 | `CHECK ("stockQuantity" >= 0)` | — | — | add as `NOT VALID` (instant), then `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, does not block writes) | `DROP CONSTRAINT` |
| M0.2 | `idempotency_keys`, `outbox_events`, `processed_events` | — | new tables | none | drop tables (no data of value) |
| M0.3 | `payment_transactions`, `payment_provider_events`, `payment_exceptions` + partial unique | §4.1 step 1 | new | none | tables are additive; old code ignores them |
| M0.4 | `order_groups`: `currency`, `itemsTotalMinor`, `deliveryFeeMinor` (default 0), `totalMinor`, `reservationCapAt`, `version` | totals from Σ order subtotals; delivery fee 0 for every existing group (none was ever charged); cap = `createdAt + 90 min` | add nullable → backfill → `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` (PG ≥ 12 skips the scan) | brief ACCESS EXCLUSIVE for each `ALTER` (metadata only) | columns ignored by old code |
| M0.5 | `inventory_movements` (+ append-only trigger) | one `OPENING_BALANCE` per variant = current `stockQuantity`, inserted per variant under that variant's row lock | new | per-row locks only | table additive |
| M0.6 | `admin_audit_logs`: `actorId` nullable, new columns | `actorType = USER` default | `DROP NOT NULL` is metadata-only | brief | re-adding NOT NULL only if no system rows exist |
| M0.7 | `users.staffPermissions StaffPermission[] DEFAULT '{}'` | existing admins get all permissions **except** FINANCE_APPROVER (SD-01 decides) | default | metadata-only | drop column |
| M0.8 | `refresh_tokens`: `sessionId`, `familyId`, `replacedById`, `clientType` (if SD-03 lands in Phase 0) | each existing token = its own session and family (`sessionId = familyId = id`) | nullable → backfill → NOT NULL | small table | columns ignored by old code |

### 5.2 Phases 1–2
- M1.x: `currencies`, `warehouses`, `inventory_balances` (+ CHECK), `stock_reservations`, `inventory_adjustments`, `stocktakes`(+lines), `inventory_discrepancies`; seeds; §3.2 backfill job (not inside the migration).
- M1b: projection trigger (installed at cutover, §3.3).
- M2.x: `inventory_intakes`(+lines), `intake_vendor_responses`, `intake_disputes`, `intake_corrections` (+ the trigger that freezes inspection columns once an intake leaves RECEIVING, and append-only triggers on responses and corrections). No backfill.

### 5.3 Phase 3
- `payment_proofs`, `payment_reference_claims`(+events), `receiving_accounts` (seeded from env `MANUAL_PAY_*` by an idempotent seed, not a migration).
- `order_groups`: `status`, `fulfilmentMode`, `paymentMethod`, `paymentStatus`, `paymentCode`, delivery snapshot columns, `confirmedAt`, `cancelledAt`, `cancelReason`.
  - Backfill: `paymentMethod = PAYMOB`; `fulfilmentMode = VENDOR` for every existing group; `status` from orders (all PENDING → PLACED; all CANCELLED → CANCELLED; any PAID/FULFILLED/SHIPPED → CONFIRMED; all DELIVERED → COMPLETED); `paymentStatus` (PAID if `paidAt`, VOID if cancelled without money, REFUND_REQUIRED if an exception exists, else UNPAID); `paymentCode` generated.
  - Delivery columns stay nullable (legacy groups have none); a CHECK requires them for `paymentMethod IN ('TRANSFER','COD')` on rows created after the migration (`CHECK (... OR created_at < '<migration timestamp>')`).
- `order_items.priceSnapshotMinor` backfilled from `priceSnapshot`.
- **Pricing (FD-02, FD-17, TD-14, TD-15)** — see §5.3.1.
- **Delivery zones (FD-04, BD-30)** — see §5.3.2.
- Ledger: `ledger_accounts` (seeded chart, `04` §2), `ledger_journals`, `ledger_entries` + all ledger triggers. **Opening balances:** none if §2 confirms no real money; otherwise one opening journal per affected group against `OPENING_BALANCE_EQUITY`, approved by FINANCE_APPROVER.

#### 5.3.1 Pricing migration (depends on FD-17, which is open)

| Step | Change | Backfill | Recovery |
|---|---|---|---|
| P1 | `pricing_config_versions` (+ append-only trigger, CHECK 0–5000 bps) | the first boot after deploy inserts the row for the configured `RIVEN_PROFIT_PERCENTAGE` (TD-15) | table additive |
| P2 | `product_variants`: `vendorRateMinor`, `markupBps`, `customerPriceMinor`, `pricingConfigVersionId`, `pricedAt` (nullable) + CHECK `customer ≥ vendor` | none in the migration | columns ignored by old code |
| P3 | `order_items`: `vendorRateMinor`, `markupBps`, `rivenProfitMinor`, `customerUnitPriceMinor`, `pricingConfigVersionId` (nullable) + CHECK `customer = vendor + profit` + trigger blocking updates once set | **none** — orders placed before Phase 3 keep NULLs; they were priced without a markup and are treated per FD-17 in statements (below) | columns ignored by old code |
| P4 | `order_groups`: `vendorTotalMinor`, `rivenProfitTotalMinor`, `deliveryZoneId`, `deliveryZoneRateId` (nullable) | none (legacy groups have no zone and a 0 fee) | columns ignored by old code |
| P5 | **Re-pricing job** (not in the migration; idempotent; audited; PLATFORM_OPERATOR) fills the variant columns | FD-17 (a): `vendorRateMinor = toMinor(priceOverride ?? basePrice)` → customer price = rate + 6 %. FD-17 (b): `vendorRateMinor = round_half_up(price × 10 000 / (10 000 + bps))`, customer price recomputed from that rate with the normal formula (it can differ from today's price by ±0.01 EGP because of rounding; every such variant is listed in the job report). FD-17 (c): variants stay unpriced until the vendor re-confirms a rate; unpriced variants are **not purchasable** | re-run; previous values are in the audit rows |
| P6 | Search re-index (`CATEGORY_PRODUCTS` / full reindex) so documents carry `customerPriceMinor` (TQ-19) | job | re-run |
| P7 | Switch checkout to the snapshot path (feature flag `PRICING_MODE=markup`, default `legacy`) | — | flip the flag back; orders already placed keep their snapshots |

Rules: P5 and P7 happen in the same maintenance window so the catalogue and checkout never disagree; P7 refuses to enable while any purchasable variant has `customerPriceMinor IS NULL`. Legacy order items (NULL snapshot): their vendor payable at delivery (Phase 4) is `priceSnapshotMinor × quantity` with zero margin under FD-17 (a)/(c) — they were sold without a markup — and the statement line explains "legacy price, no Riven markup". Under FD-17 (b) the same rule applies (old orders are not re-split retroactively). In practice legacy orders are demo/test rows (§2) and should be excluded from opening balances.

#### 5.3.2 Delivery zones

| Step | Change | Backfill / seed | Recovery |
|---|---|---|---|
| Z1 | `delivery_zones`, `delivery_zone_areas` (partial `UNIQUE NULLS NOT DISTINCT (governorate, city) WHERE status = 'ACTIVE'` — needs PG ≥ 15, TQ-06; fallback: two partial unique indexes, one for `city IS NULL`), `delivery_zone_rates` (+ append-only trigger, maker-checker CHECK) | the 27 governorate codes ship as a constant list in code (not a table); zones, mappings and rates are **entered by DELIVERY_PRICING and approved by FINANCE_APPROVER**, not seeded with invented amounts. *v7:* the approved temporary flat fee (FD-29) is entered the same way as one national zone mapped to all 27 governorates with one rate of 80.00 EGP — data, not a migration | tables additive |
| Z2 | Checkout refuses TRANSFER/COD for an address whose governorate/city has no approved rate in force (400 `DELIVERY_AREA_NOT_SERVED`) | go-live gate: every served governorate has a mapping and an approved rate (TQ-17) | — |
| Z3 | Mobile app collects a governorate code (picker) instead of free text (TQ-18) | app release before Z2 is enforced | until the app ships, the API maps known free-text city names to codes and rejects the rest |

### 5.4 Phases 4–7
New tables only (`couriers`, `shipments`, `shipment_items`, `fulfilment_events`, `cod_collections`, `courier_remittances`, `remittance_allocations`, `courier_deductions`, `vendor_statements`, `vendor_statement_lines`, `vendor_settlements`, `settlement_lines`, `settlement_line_releases`, `vendor_payout_accounts`, `vendor_payouts`, `payout_receipt_confirmations`, `payout_discrepancies`, `return_requests`, `return_lines`, `refunds`, `refund_attempts`). Groups with `fulfilmentMode = VENDOR` never get shipments; the vendor status route keeps working for them.

Triggers added with these tables (hand SQL, TD-02): `fulfilment_events` append-only; ISSUED statements and their lines immutable; `vendor_payouts` amount/method/destination/transfer date/reference/proof frozen once SENT; `payout_receipt_confirmations` append-only; `vendor_payout_accounts.accountNumberEnc` never returned by a view.

**Phase 4 backfill of `fulfilment_events`:** one synthetic `ORDER_PLACED` event per existing group (and `DELIVERED`/`CANCELLED` where the legacy status says so, with `occurredAt` = the order's `updatedAt`, marked `note = 'backfilled'`) so vendor timelines are not empty for old orders. Idempotent by `(orderGroupId, type)` for backfilled rows.

**Phase 6 opening statement:** the first statement per vendor starts at the month of Phase 6 go-live with `openingBalanceMinor` = the vendor's `VENDOR_PAYABLE` balance at that instant (normally the payables recognized since Phase 4) — no earlier periods are generated retroactively unless Ibrahim asks (BD-28).

## 6. Hand-SQL drift protection
- `prisma/hand-sql-objects.json` lists every trigger, function, partial index and CHECK with its table.
- `hand-sql-objects.spec.ts` queries `pg_trigger`, `pg_indexes`, `pg_constraint` on the test database after `migrate deploy` and fails if any is missing.
- CI also runs `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` (shadow DB) to catch schema drift; expected differences caused by hand SQL are allow-listed by name.
- Migration review checklist (PR template addition): GIST indexes untouched; hand-SQL objects untouched; NOT NULL added only via the CHECK-validate path; no data rewritten.

## 7. Rehearsal on a production snapshot
1. Restore a fresh Supabase dump into a local database named `riven_snapshot_test` (the `_test` suffix keeps every test guard working).
2. Run `prisma migrate deploy` for the phase; record wall time per migration and lock waits (`log_lock_waits = on`).
3. Run the phase's backfill job and the reconciliation/invariant queries (`05` §5); attach output to the phase report.
4. Run the e2e and concurrency suites against the migrated snapshot.
5. Delete the snapshot afterwards; it contains personal data (SD-05). Access limited to the person running the rehearsal.

## 8. Recovery strategy
- **Expand steps** are safe to leave in place if the application release is rolled back: old code ignores new tables/columns.
- **Data-moving steps** (backfills) are idempotent and re-runnable; they never delete. A bad backfill is corrected by a compensating, audited job — not by editing rows by hand.
- **Contract steps** (NOT NULL, authority flip, column drops) each have an explicit inverse (drop constraint; flip flag back and disable trigger; restore from backup for drops — which is why drops come last and only after the removal conditions in §4.1).
- **Prisma has no down-migrations.** Recovery is forward-fix or restore. Hence: backup before each production migration (TQ-07), rehearsal first (§7), and each migration small enough to reason about.
