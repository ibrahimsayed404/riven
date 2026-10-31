# Inventory Module Spec — Pass 1

**Status:** Draft for review — **not implemented**. BLOCKING decisions: BD-01, BD-03, BD-08 (proposed: receive and verify before selling), BD-24, FD-07 (`specs/commerce/08-decision-register.md`).
**Updated 2026-10-25:** vendor intake acknowledgment / dispute (§5), vendor quantity view (§4.1), intake dispute resolution and corrections. **v7 (2026-10-27):** intake, disputes, withdrawals and handover discrepancies now governed by `commerce/19`; `held` added to the available formula.
**Builds on:** `specs/fashion-marketplace-addendum.md` (stock on `ProductVariant`), `specs/vendor-module-spec.md` (variant routes). Neither is modified.
**Architecture:** `specs/commerce/01` §4 (lock hierarchy: inventory is L6, a leaf), `commerce/02` §3.5 (models), `commerce/03` §6 (state machines), `commerce/06` §3 (source of truth and cutover).
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-24.

---

## 1. Purpose and rules

The inventory module is the **only** writer of stock. Checkout, orders, fulfilment and returns call it through `…InTx` service methods; no other module touches `product_variants.stockQuantity` or `inventory_balances` (lint rule).

Invariants (database CHECKs + reconciliation):
- Phase 0: `stockQuantity ≥ 0`; `stockQuantity = OPENING_BALANCE + Σ movement deltas`.
- Phase 1+: per balance `on_hand ≥ reserved + held`, `reserved ≥ 0`, `held ≥ 0`, `damaged ≥ 0`, `quarantined ≥ 0`; `available = on_hand − reserved − held` (v7: `held` = active dispute freezes and withdrawal holds, `commerce/19`); `physical = on_hand + damaged + quarantined`; `reserved = Σ ACTIVE+CONFIRMED reservations`.
- Every counter change and its movement row are written in the same transaction; every movement has `sourceEventKey @unique` (an operation applied twice is a no-op).
- Discrepancies are reported, never auto-corrected.

## 2. Stock categories

Every quantity below is a distinct, stored or computed number; only **available** can ever be reserved or sold. *(Expanded 2026-10-25.)*

| State | Where it is stored / computed | Sellable / reservable? |
|---|---|---|
| Vendor-declared | `on_hand` at the vendor's `VENDOR_PREMISES` warehouse (`origin = VENDOR_DECLARED`); Phase 0–1a: `stockQuantity` | **no** after 1b (`sellable = false`, BD-08); in Phase 0–1a only outside production (PRG) |
| Expected intake | `inventory_intake_lines.declaredQty` on a SUBMITTED / RECEIVING intake | no |
| Received | `receivedQty` (intake RECEIVED) | no — counted, not yet verified |
| Accepted | `acceptedQty` (+ approved corrections) → `INTAKE_ACCEPTED` movement at a RIVEN warehouse when VERIFIED (BD-24) | becomes part of `on_hand` → available |
| Damaged | `damagedQty` at intake, inspection `ACCEPTED_DAMAGED`, `damaged` counter | **never** |
| Missing | `declaredQty − receivedQty` (computed) | **never** (never in custody) |
| Available | `on_hand − reserved − held` at sellable RIVEN warehouses (= `stockQuantity` projection after 1b) | **the only reservable quantity** |
| Held (v7) | `held` counter = Σ active `InventoryHold` (disputed accepted units, units authorized for withdrawal) | **never** until released |
| Reserved | `reserved` (Σ ACTIVE + CONFIRMED reservations) | already held |
| Sold | Σ delivered order-item quantities (shipment DELIVERED) | — (left custody) |
| Returned | return inspections (accepted / rejected / disputed) after a physical return is RECEIVED | only `ACCEPTED_RESTOCK` units return to `on_hand` |
| Quarantined / disputed | `quarantined` counter (returns awaiting inspection, DISPUTED inspections); disputed intake claims (vendor's claimed extra units) exist only as dispute rows until an approved correction | **never** until resolved |

Ownership and custody: consignment by default (vendor owns, Riven holds) — **BD-03**. Liability: vendor until intake verification, Riven in custody, courier in transit — **FD-07**. Sellable before verification — **BD-08**.

## 3. Service API (internal)

| Method | Lock | Effect |
|---|---|---|
| `reserveInTx(tx, lines[])` | L6, sorted `(warehouseId, variantId)` | guarded `reserved += q WHERE on_hand − reserved − held ≥ q`; inserts reservations ACTIVE with `expiresAt`; any line fails → throws `OutOfStockError` (caller rolls back) |
| `extendInTx(tx, groupId, until)` | none (reservation rows of a locked group) | `expiresAt = min(until, cap)` |
| `confirmInTx(tx, groupId)` | reservation rows | ACTIVE → CONFIRMED |
| `releaseInTx(tx, groupId, reason)` | L6 sorted | ACTIVE/CONFIRMED → RELEASED; `reserved -= q` once per reservation |
| `fulfilInTx(tx, shipmentId)` | L6 sorted | CONFIRMED → FULFILLED; `on_hand -= q, reserved -= q`; movement SHIPMENT_OUT |
| `receiveReturnInTx(tx, lines[])` | L6 | `quarantined += q`; movement RETURN_TO_QUARANTINE |
| `inspectInTx(tx, line, outcome)` | L6 | quarantine → on_hand / damaged / return-to-vendor |

Phase 0 equivalents operate on `product_variants.stockQuantity` with RESERVE / RELEASE / VENDOR_ADJUSTMENT movements (`commerce/06` §3.1).

## 4. Endpoints

### Vendor (`/vendors/me/...`, Role VENDOR)
Every vendor query filters by the caller's `vendorId` in the same SQL statement; a foreign id returns 404 (`commerce/07` §9). Reads are polled (TD-16); list responses carry an `ETag`.

| Method & path | Phase | Notes |
|---|---|---|
| `PATCH /vendors/me/products/:id/variants/:variantId/stock` | 0 | body `{ delta, reason }` or `{ setTo, expectedStockQuantity, reason }`; premises stock only after Phase 1b; under BD-08 as proposed premises stock is never sellable, so this route only maintains the vendor's own declared count |
| `GET /vendors/me/inventory?variantId=&productId=` | 0 (reduced) / 1–2 (full) | per variant: the quantity view in §4.1 |
| `GET /vendors/me/inventory/movements?variantId=&type=&from=&to=` | 0 | own movement history (type, quantity, location, timestamp, source reference such as order or intake code); cursor-paginated |
| `POST /vendors/me/inventory-intakes` | 2 | `{ clientRequestId, lines: [{ variantId, requestedQuantity }] }` + `Idempotency-Key` (v7, `commerce/19` §11) |
| `GET /vendors/me/inventory-intakes`, `GET /:id` | 2 | own intakes: per line requested / physically received / accepted / damaged / missing / rejected / pending-inspection quantities, approval result, vendor-visible evidence and notes, history, acknowledgment and dispute status (`commerce/19` §9) |
| `POST /vendors/me/handover-discrepancies/:id/acknowledge` | 2 | v7: only when requested ≠ received (or dispatched ≠ vendor-received); acknowledgment ≠ liability (`commerce/19` §10) |
| `POST /vendors/me/inventory-intakes/:id/lines/:lineId/disputes` | 2 | v7: `{ category, disputedQuantity, reason, evidenceKeys[] }` + `Idempotency-Key`; freezes only a disputed **accepted** quantity (`commerce/19` §7) |
| `POST /vendors/me/stock-withdrawals` · `GET` · `POST /:id/lines/:lineId/receipt {vendorReceivedQuantity}` | 2 | v7: withdrawal of unsold stock, 4 days' notice (BD-39), authorization never above available, dispatch recorded by Riven, vendor records what arrived (`commerce/19` §10.3); replaces the earlier `stock-returns` route |
| `POST /vendors/me/inventory/adjustment-requests` · `GET` · `PATCH /:id/cancel` | 2 | (`commerce/17` §4.3, TD-08 pending): **decrease-only** request on Riven-held stock (`DAMAGE_REPORTED`, `COUNT_ERROR`; v7: withdrawals and recalls go through stock withdrawals) with explanation and evidence; approved by one authorized admin (BD-38); increases only through intake / intake disputes (INV-10) |

### 4.1 Vendor quantity view

Per variant (and per location where the vendor has more than one). Every figure comes from persisted rows; none is stored separately for the portal.

| Field | Meaning | Source (Phase 1b+) | Before custody (Phase 0–1a) |
|---|---|---|---|
| `received` | units Riven physically received from the vendor | Σ intake `receivedQty` (VERIFIED/CLOSED intakes) + Σ correction deltas | — |
| `accepted` | received units accepted into sellable custody | Σ `INTAKE_ACCEPTED` movements (incl. corrections) | — |
| `available` | can be bought now | `on_hand − reserved − held` at sellable `RIVEN` locations (= `stockQuantity` projection) | `stockQuantity` |
| `held` (v7) | frozen by a dispute or held for a withdrawal | Σ active holds | — |
| `pendingInspection` (v7) | received, not yet classified | Σ intake lines `pendingInspectionQuantity` | — |
| `reserved` | held for open orders (unpaid within the window, or confirmed and not yet shipped) | Σ ACTIVE + CONFIRMED reservations | Σ quantity of PENDING/PAID/FULFILLED order items (computed) |
| `inTransit` | handed to the courier, not yet delivered | Σ `SHIPMENT_OUT` for shipments not DELIVERED / not returned | — |
| `sold` | delivered to customers (gross) | Σ quantities of order items whose shipment is DELIVERED | Σ DELIVERED order items |
| `returned` | returned by customers and received back | Σ return lines RECEIVED or later; split by inspection outcome `restocked / damaged / returnedToVendor` | — |
| `damaged` | currently held as damaged (not sellable) | `damaged` counter | — |
| `returnedToVendor` | units sent back to the vendor (rejected at intake, inspection outcome, stock-return requests) | Σ `RETURN_TO_VENDOR` movements | — |

Identity checked by a test and by the reconciliation job, per variant at RIVEN locations: `accepted + returned.restocked ± adjustments − shippedOut − writtenOff = onHand`, and `onHand − reserved = available`. The portal shows the identity's terms, so a vendor can follow how `available` was reached.

`PATCH /vendors/me/products/:id/variants/:variantId` stops accepting `stockQuantity` (400 `USE_STOCK_ENDPOINT`, TD-08). Variant **create** keeps an initial `stockQuantity` (OPENING_BALANCE movement at the premises location).

### Admin (`/admin/inventory/...`, Role ADMIN + permission)
| Method & path | Permission | Phase |
|---|---|---|
| `GET /admin/inventory/balances?vendorId=&variantId=&warehouseId=` | INVENTORY, OPS, FINANCE | 1 |
| `GET /admin/inventory/movements?…` | INVENTORY, FINANCE | 0 |
| `POST /admin/inventory/adjustments` (maker) · `PATCH /:id/approve` · `PATCH /:id/reject` (checker) | INVENTORY / FINANCE_APPROVER | 1 |
| `GET /admin/inventory/adjustment-requests?status=` · `PATCH /:id/approve` · `/reject {reason}` | INVENTORY (single authorized admin, BD-38) | 2 |
| `PATCH /admin/inventory-intakes/:id/start-receiving` · `PATCH /admin/intake-lines/:lineId/receipt {physicallyReceivedQuantity, notes}` · `/inspection {accepted, damaged, rejected, pending, rejectionReason?, evidence}` · `/cancel` | OPS / INVENTORY | 2 |
| `PATCH /admin/intake-lines/:lineId/approve` · `/return-for-recount {reason}` | INVENTORY (single authorized admin; vendor never) — 409 `INTAKE_LINE_ALREADY_DECIDED` on a second decision (`commerce/19` §5) | 2 |
| `GET /admin/intake-disputes?status=` · `PATCH /:id/review` · `/resolve {outcome: RESOLVED_FOR_VENDOR \| RESOLVED_FOR_RIVEN \| PARTIALLY_RESOLVED, explanation, adjustment?}` | INVENTORY (single authorized admin, BD-38); any stock change = separate adjustment | 2 |
| `GET /admin/stock-withdrawals?status=` · `PATCH /:id/authorize {lines}` · `/reject` · `PATCH /admin/withdrawal-lines/:lineId/dispatch {dispatchedQuantity}` | OPS / INVENTORY | 2 |
| `GET /admin/handover-discrepancies?status=` · `PATCH /:id/acknowledge` (Riven side, outbound) · `/review` · `/resolve {resolution}` | INVENTORY | 2 |
| `POST /admin/stocktakes` · `PATCH /:id/lines` · `/submit` · `/approve` | INVENTORY / FINANCE_APPROVER | 1 |
| `POST /admin/inventory/damage` (mark damaged) · `/write-offs` (maker-checker) · `/returns-to-vendor` | INVENTORY / FINANCE_APPROVER | 2 |
| `GET /admin/inventory/discrepancies` · `PATCH /:id/acknowledge` · `/resolve` | INVENTORY, PLATFORM_OPERATOR | 0/1 |
| `POST /admin/inventory/reconcile` (run now) | PLATFORM_OPERATOR | 0 |

## 5. Intake workflow (Phase 2) — **superseded in v7 by `commerce/19-inventory-intake-and-handover.md`**

v7 (2026-10-27): the authoritative intake, dispute, withdrawal and handover-discrepancy workflow is `commerce/19` (partial per-line approval, single admin approval, disputed-quantity freeze, acknowledgment only on discrepancy, 4 days' withdrawal notice). §5.1–5.3 below are kept for history; where they differ (verifier ≠ receiver, a vendor response to every intake, two-person dispute resolution, intake corrections), **`commerce/19` governs**.

State machine (historical): `commerce/03` §6.4. Lock order: W28 / W29 (`commerce/05` §2.1).

### 5.1 Riven's inspection record
1. Vendor creates an intake (SUBMITTED) with declared quantities.
2. Goods arrive; OPS opens it (RECEIVING) and records per line `receivedQty` and the split `acceptedQty / rejectedQty / damagedQty` (CHECK: they sum to received). `missing = declared − received` is computed.
3. RECEIVED → **Riven's inspection columns are frozen** (trigger: any UPDATE of counted columns after RECEIVING raises). The vendor is notified (outbox `intake.report_ready`) and sees the report.
4. INVENTORY (≠ receiver) verifies → movements INTAKE_ACCEPTED (`on_hand += accepted`) and INTAKE_DAMAGED (`damaged += damaged`) at the RIVEN warehouse; rejected units go back to the vendor (RETURN_TO_VENDOR, no custody movement). Under BD-24 (a) (recommended) the accepted units are sellable from here; under BD-24 (b) the movements are posted only when the vendor response is ACKNOWLEDGED / DEEMED_ACKNOWLEDGED or the dispute is resolved.
5. CLOSED when the vendor response is final (below).

### 5.2 The vendor's response (separate, append-only)
- The vendor responds **once** per intake, while the window (BD-25, default 7 days from RECEIVED) is open: `ACKNOWLEDGED`, or `DISPUTED` with per-line claimed quantities, a reason and evidence. Stored in `intake_vendor_responses`; Riven's record is never edited by it.
- No response by the deadline → `DEEMED_ACKNOWLEDGED`, **computed on read** (no job needed while TD-13 is postponed; `commerce/01` §13).
- A second response → 409 `INTAKE_ALREADY_RESPONDED`; after the deadline → 409 `INTAKE_RESPONSE_WINDOW_CLOSED`.

### 5.3 Dispute resolution
- A DISPUTED response opens an `IntakeDispute` (OPEN). INVENTORY proposes an outcome with corrections; FINANCE_APPROVER (≠ proposer, CHECK) approves.
- UPHELD / PARTIAL → `intake_corrections` rows (append-only) and matching movements in the same transaction (e.g. `INTAKE_ACCEPTED +2`, locks L6 sorted). REJECTED → no corrections. Either way the dispute is RESOLVED_* and the intake CLOSES.
- The intake report always shows *original count → correction(s) → current*. Every step is audited (TD-03) with both parties' actions.

Damaged-on-arrival liability → FD-07. Missing units are the vendor's (not received ⇒ not in custody). A correction that adds accepted units after some were already sold is a normal positive movement; one that removes accepted units is refused if it would make `on_hand < reserved` (409 `ADJUSTMENT_BELOW_RESERVED`) — staff must first resolve the open orders.

## 6. Reconciliation job

Nightly and on demand: per balance compares counters with Σ movements and `reserved` with Σ open reservations; Phase 0/1a compares `stockQuantity` with Σ movements and the shadow balances; Phase 1b compares `stockQuantity` with the projection. Each difference → `inventory_discrepancies` OPEN + outbox alert. Never auto-corrected.

## 7. Errors

`OUT_OF_STOCK` (internal; surfaces as `CHECKOUT_ITEM_UNAVAILABLE`), `ADJUSTMENT_NEGATIVE`, `ADJUSTMENT_BELOW_RESERVED`, `STOCK_CHANGED` (CAS; `details.current`), `USE_STOCK_ENDPOINT`, `WAREHOUSE_NOT_VENDOR_MANAGED`, `INTAKE_STATE_CONFLICT`, `INTAKE_COUNTS_INVALID`, `INTAKE_RECORD_FROZEN`, `INTAKE_ALREADY_RESPONDED`, `INTAKE_RESPONSE_WINDOW_CLOSED`, `INTAKE_DISPUTE_STATE_CONFLICT`, `VERIFIER_MUST_DIFFER`, `ADJUSTMENT_STATE_CONFLICT`, `MAKER_CANNOT_APPROVE`, `QUARANTINE_INSUFFICIENT`.

## 8. Audit

Actions: `INVENTORY_ADJUSTMENT_REQUESTED|APPROVED|REJECTED`, `VENDOR_STOCK_ADJUSTED` (actor vendor user), `INTAKE_RECEIVED`, `INTAKE_VERIFIED`, `INTAKE_ACKNOWLEDGED` (actor vendor user), `INTAKE_DISPUTED` (actor vendor user), `INTAKE_DISPUTE_PROPOSED`, `INTAKE_DISPUTE_RESOLVED`, `INTAKE_CORRECTED`, `STOCKTAKE_APPROVED`, `STOCK_MARKED_DAMAGED`, `STOCK_WRITTEN_OFF`, `STOCK_RETURNED_TO_VENDOR`, `INVENTORY_DISCREPANCY_RESOLVED`. Targets: `INVENTORY_BALANCE`, `INVENTORY_INTAKE`, `STOCKTAKE`, `INVENTORY_ADJUSTMENT`.

## 9. Tests

Unit: every guarded operation (accept and reject paths); quantity-view identity (§4.1). Concurrency: C-A, C-G1/G2, C-13, C-14, C-16, C-DL1, C-M1, C-IN1–C-IN3, C-VP1 (`commerce/05`). Migration: backfill + cutover rehearsal (`commerce/06` §3). Trigger test: counted columns cannot change after RECEIVED. E2E: intake → acknowledge; intake → dispute → partial correction → movements; window lapse → DEEMED_ACKNOWLEDGED. Acceptance criteria 29–31 (`commerce/10` §2a). Invariant checks after every test.

## 10. Open items

BD-01, BD-03, BD-08 + BD-15 (proposed), BD-21 (deferred), BD-24, BD-25, BD-34, FD-07, TD-08, TD-09, TD-16.

## 11. Enforcement: verified physical stock on every path (INV-01 – INV-09; added 2026-10-25)

**Rule (BD-08, pending Ibrahim; design baseline):** a product cannot be purchased unless Riven has physically received and verified its stock. The **only** enforcement boundary is the server-side reservation inside the checkout transaction (guarded update of a balance at a sellable RIVEN warehouse, plus DB triggers). Product visibility, cart checks, search and anything the frontend shows are conveniences, never the boundary.

| # | Path | Control | Layer | From phase |
|---|---|---|---|---|
| 1 | Product creation | allowed (products have no approval gate); an initial `stockQuantity` becomes an `OPENING_BALANCE` at the vendor's premises (`origin = VENDOR_DECLARED`), never RIVEN stock | service + DB (premises not sellable) | 0 / 1b |
| 2 | Product listing | visibility is `PUBLIC_PRODUCT_WHERE` (active, vendor verified); stock shown is `stockQuantity` = available at sellable RIVEN locations after 1b; 0-stock products stay visible unless BD-34 says otherwise | read model | 1b |
| 3 | Search and indexing | search documents carry **no stock** (`infra/search/search-documents.ts:6`); prices only; availability is always read from the database at product detail / cart / checkout | design (existing) | — |
| 4 | Product details | variant `stockQuantity` from the projection; informational only | read model | 1b |
| 5 | Product availability (`GET` endpoints) | same projection; never computed from vendor-declared counts | read model | 1b |
| 6 | Cart validation | soft check against `stockQuantity` (`cart.service.ts:49,79`); never reserves; a stale cart is caught at checkout | service (soft) | existing |
| 7 | Checkout validation | re-reads prices and stock **inside** the transaction; reservation is a guarded `UPDATE … WHERE on_hand − reserved − held ≥ q` on a sellable balance; any line short → 400, nothing created | service + DB (CHECK + triggers) | 0 / 1b |
| 8 | Inventory reservation | `reserveInTx` is the only writer of `reserved`; triggers refuse reservations at non-sellable warehouses (`02` §5) | DB | 1 |
| 9 | Order creation | only through checkout (no admin "create order" route); demo/test scripts are not part of production (TQ-12) | design | — |
| 10 | Order cancellation | guarded release of the group's reservations, once (`sourceEventKey`); releases return units to the balance they came from (premises for legacy groups, RIVEN otherwise) | service + DB | 0 / 1 |
| 11 | Stock return and restocking | customer returns go to `quarantined`; only inspection `ACCEPTED_RESTOCK` moves units to `on_hand`; returns to vendor leave custody | service + DB | 7 |
| 12 | Vendor stock-management APIs | delta / CAS (TD-08) on the vendor's **premises** balance only; the endpoint resolves the balance from the JWT vendor and the premises location — no parameter selects a warehouse; `PATCH …/variants/:id` rejects `stockQuantity` (400 `USE_STOCK_ENDPOINT`) | service | 0 / 1b |
| 13 | Admin inventory operations | adjustments, stocktake, write-off, damage, intake verification: maker-checker or verifier ≠ receiver; every change a movement + audit (TD-03) | service + DB CHECK | 1–2 |
| 14 | Direct / alternative paths | no route writes `stockQuantity` after 1b (repository method removed, lint rule); projection guard trigger refuses any other `UPDATE` of the column; runtime DB role cannot disable triggers (TD-17 pending); console writes are break-glass only (SD-08 pending) | lint + DB + operations | 1b / production |

## 12. Bypass scenarios and how each is prevented

| Bypass attempt | Prevented by | Test |
|---|---|---|
| Vendor types a large stock number and it becomes sellable | premises warehouse `sellable = false`; delta/CAS only on premises (TD-08) | AT-INV-01, AT-INV-07 (d, e) |
| Vendor creates a new variant with initial stock | opening balance at premises, not RIVEN | AT-INV-10 |
| Migration turns today's `stockQuantity` into sellable stock | classified VENDOR_DECLARED at premises (`commerce/06` §3.5); no premises → RIVEN path | AT-INV-10, AT-INV-11 |
| Intake counted but not approved is sold | accepted quantity posted only when a single authorized admin approves the line (v7, `commerce/19` §5; BD-36, BD-38) | AT-INV-02, AT-INV-05, AT-INV-15 |
| Disputed accepted units sold during a dispute | dispute hold (`held`) excludes them from available (BD-37) | AT-INV-28, AT-INV-29 |
| Damaged / disputed / quarantined units reserved | separate counters; reservation only against `on_hand − reserved`; triggers | AT-INV-03, AT-INV-04, AT-INV-09 |
| Stale cart or tampered client quantity | checkout re-validation inside the transaction; DTO whitelist | AT-INV-07 (a–c) |
| Two shoppers take the last unit | guarded update + CHECK `on_hand ≥ reserved` | AT-INV-06, C-A |
| Cancellation restores twice | guarded release + unique `sourceEventKey` | AT-INV-08, C-10 |
| Returned item resold before inspection | quarantine until `ACCEPTED_RESTOCK` | AT-INV-09 |
| Direct SQL / script writes `stockQuantity` | projection guard trigger; TD-17 role; SD-08 console policy | AT-INV-07 (f), AT-SEC-08 |
| Admin "fixes" stock without trace | maker-checker adjustment + movement + audit; no direct counter edit route | AT-SEC-03 |
| Late payment revives a cancelled order (BD-17 option) | re-reservation goes through the same guarded `reserveInTx`; if stock is gone → refund | C-F2, AT-FIN-04 |

## 13. Database invariants (hand SQL, `commerce/02` §5)

- `inventory_balances`: `reserved ≥ 0`, `held ≥ 0`, `on_hand ≥ reserved + held`, `damaged ≥ 0`, `quarantined ≥ 0` (CHECK; v7 adds `held`).
- `inventory_intake_lines`: the two quantity identities and the approval preconditions (`commerce/19` §3, §5); posting key `intake-line:<id>:accepted` unique.
- `inventory_balances_reserve_sellable_only` and `stock_reservations_sellable_only` (triggers): no reservation and no `reserved` increase at a non-sellable warehouse.
- `product_variants_stock_projection` + `product_variants_stock_projection_guard` (Phase 1b): `stockQuantity` = Σ available over sellable warehouses and is written only by the projection.
- `inventory_movements`: append-only; unique `sourceEventKey`; `origin` set from Phase 1.
- `intake_lines_frozen_after_inspection`: Riven's inspection record immutable after RECEIVED.
- Reconciliation (§6) re-checks counters against Σ movements daily and reports, never corrects.
