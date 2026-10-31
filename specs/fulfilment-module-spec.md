# Fulfilment Module Spec — Pass 1 (shipments, COD collection and reconciliation, returns)

**Status:** Draft for review — **not implemented**. BLOCKING decisions: BD-02, FD-08, FD-18; COD reconciliation also needs FD-06, FD-10 and the courier contract (TQ-04). Returns need BD-04 and FD-19.
**Updated 2026-10-25:** fulfilment-event timeline (§2.1), vendor order view and statuses (§2.2), delivered posting under the markup model and FD-18 delivery-fee treatment (§3). **Gap-closure pass (2026-10-25):** courier handover manifest and evidence (§2.3), COD production restriction and the six COD amounts (§4.0), discrepancy owners (§4.4), returns split into five steps with the production restriction (§5).
**Builds on:** `specs/fashion-marketplace-addendum.md` §5 (order lifecycle; vendors fulfilled orders — superseded for `fulfilmentMode = RIVEN` groups, conflict C5), `specs/cart-checkout-orders-spec.md`. Neither is modified.
**Architecture:** `specs/commerce/03` §7–9 (state machines), `commerce/04` §7 (postings), `commerce/05` W18–W22 (locks).
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-24.

---

## 1. Scope

| In | Out |
|---|---|
| Shipments for `RIVEN`-mode groups (one per group by default, BD-09) | courier API integration (BD-22, DEFERRED — v1 is manual entry) |
| Delivery, failed attempts, refusal, lost parcels, reverse logistics | partial delivery / partial acceptance (BD-16, DEFERRED) |
| COD collection, courier remittances, allocations, deductions, reconciliation (Phase 5) | refunds execution (`vendor-settlement-spec.md` §5) |
| Returns: request, review, receipt, inspection (Phase 7) | multi-warehouse routing (BD-21) |

Groups with `fulfilmentMode = VENDOR` (created before BD-02's go-live) keep today's vendor-driven flow (`PATCH /vendors/me/orders/:id/status`) and never get shipments.

## 2. Shipments (Phase 4)

- Created PENDING in the transaction that CONFIRMS a `RIVEN` group, with one `ShipmentItem` per order item (all vendors in one parcel).
- `codAmountMinor` = group `totalMinor` for COD, else 0.
- Transitions and side effects: `commerce/03` §7. Handover (`READY_FOR_PICKUP → HANDED_TO_COURIER`) requires `courierId` + `trackingNumber` (unique per courier), fulfils reservations (stock leaves), creates the `CodCollection` for COD.
- COD delivery is recorded **together with** the collected amount; the shipment cannot reach DELIVERED for COD without a collection record (BD-20).
- Refusal cancels the group commercially; the parcel continues RETURNING → RETURNED_TO_WAREHOUSE; stock goes to quarantine and is inspected before it is sellable again.
- LOST requires maker-checker; prepaid → refund or reship; liability FD-07.
- Every state change projects legacy `Order.status` in the same transaction (`commerce/03` §13).

### Endpoints (OPS unless noted)
| Method & path | Notes |
|---|---|
| `GET /admin/shipments?status=&courierId=&from=&to=` | queue views: to prepare, ready, out, failed, returning |
| `GET /admin/shipments/:id` | items, address snapshot, payment method/status, COD amount, history |
| `PATCH /admin/shipments/:id/prepare` · `/ready` · `/handover {courierId, trackingNumber}` · `/out-for-delivery` · `/deliver {collectedMinor?}` · `/failed-attempt {reason}` · `/refused {reason}` · `/returning` · `/returned` | guarded transitions; `/deliver` for COD requires `collectedMinor` |
| `PATCH /admin/shipments/:id/lost` (maker) · `/lost/approve` (FINANCE_APPROVER) | |
| `POST /admin/couriers` · `PATCH /admin/couriers/:id` · `GET /admin/couriers` | courier registry |
| `PATCH /orders/:id/confirm-delivery` (SHOPPER, existing route) | records `shopperConfirmedAt`; advances a non-COD shipment that is OUT_FOR_DELIVERY to DELIVERED; for COD it only records the confirmation (BD-20, conflict C7). Ratings keep requiring DELIVERED |
| `PATCH /vendors/me/orders/:id/status` (VENDOR, existing) | 409 `FULFILMENT_MANAGED_BY_RIVEN` for `RIVEN`-mode groups |

Vendor order views for `RIVEN`-mode groups drop shopper phone/email (no longer needed by the vendor).

### 2.1 Fulfilment-event timeline

Every group, shipment and return transition writes one `FulfilmentEvent` row (`commerce/02` §3.6) **in the same transaction** as the transition: type, from/to status, `occurredAt`, optional `orderId` when only one vendor's part is concerned, visibility (`SHOPPER_AND_VENDOR`, `VENDOR_ONLY`, `INTERNAL`). The table is append-only (trigger). It is the single source of the timestamps shown to shoppers and vendors, so a status shown in a portal always has the persisted event that caused it.

Event types: `ORDER_PLACED`, `PAYMENT_CONFIRMED`, `ORDER_CONFIRMED`, `PREPARING`, `READY_FOR_PICKUP`, `HANDED_TO_COURIER`, `OUT_FOR_DELIVERY`, `DELIVERY_FAILED`, `DELIVERED`, `REFUSED`, `RETURN_REQUESTED`, `RETURN_RECEIVED`, `RETURN_INSPECTED`, `CANCELLED`, `LOST`. Internal-only notes (courier disputes, staff comments) use `INTERNAL` and are never returned on vendor or shopper routes.

### 2.2 Vendor order view (existing routes, extended)

`GET /vendors/me/orders` and `GET /vendors/me/orders/:id` already exist (`modules/orders/vendor-orders.controller.ts`). They keep their paths; for vendors they gain:

| Field | Source |
|---|---|
| `vendorStatus` | computed on read per `commerce/03` §14: `AWAITING_PAYMENT` (only if BD-27 allows), `PROCESSING`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `RETURNED`, `PARTIALLY_RETURNED` |
| `items[]` | only the caller's items: product title, SKU, quantity, `vendorRateMinor` and line vendor amount from the order-item snapshot; customer price per BD-26; item-level `RETURNED` where applicable |
| `timeline[]` | the group's `FulfilmentEvent` rows with visibility `SHOPPER_AND_VENDOR` or `VENDOR_ONLY` (type, `occurredAt`) |
| `timestamps` | placed, confirmed, handed over, delivered, cancelled, return received — taken from the timeline |
| `orderRef` | the group's `paymentCode` (e.g. `RV-8F3A21`), the reference used on statements |

Filters: `status` (vendor status), `from`/`to` (placed date), `productId`; cursor pagination; `ETag` for polling (TD-16). Not shown to vendors: shopper contact data for `RIVEN`-mode groups, other vendors' items, payment method details, delivery fee (BD-26). Isolation: `orders.vendorId = me` in the same statement; a foreign id → 404 (`commerce/07` §9).

### 2.3 Courier handover, acceptance and evidence (COU-02; added 2026-10-25)

The courier **accepts responsibility** for parcels only through a signed handover manifest (`CourierHandover`, `commerce/02` §3.6): courier, date/time, courier representative (name and id per the contract, TQ-23), the list of shipments and tracking numbers, the parcel count and the total COD amount the courier undertakes to collect, plus the signed manifest scan/photo in private storage. `PATCH /admin/shipments/:id/handover` requires the manifest id (409 `COURIER_HANDOVER_REQUIRED` otherwise); the manifest is append-only.

| Event | Evidence required | Recorded by |
|---|---|---|
| Handover to courier | signed manifest (per batch), tracking numbers | OPS |
| Out for delivery / attempt / failure | courier status (manual entry from the courier's portal or statement in the MVP) | OPS |
| Delivered (prepaid) | courier delivery confirmation (status + time); shopper confirmation optional (BD-20) | OPS |
| Delivered (COD) | courier delivery confirmation **and** the collected amount | OPS / FINANCE |
| Refused | courier refusal report with reason | OPS |
| Lost | courier written acknowledgment or the courier's claim reference | OPS (maker) + FINANCE_APPROVER (checker) |
| Damaged in transit | courier damage report + photos on return | OPS; inspection on return |
| Returned to warehouse | warehouse receipt (count) | OPS / INVENTORY |
| Cash remitted | courier statement (per-parcel lines, deductions) + Riven bank receipt | FINANCE |

**Duplicate or late updates** (re-entered statements, two operators): guarded transitions; same target → 200 no-op; different `from` → 409; the DELIVERED posting key makes a second journal impossible (`commerce/03` §7, AT-COU-04).

## 3. Delivery postings (Phase 4, needs FD-02, FD-08 and FD-18)

`DELIVERED` posts one journal per shipment (`commerce/04` §7.5), key `('SHIPMENT', id, 'DELIVERED')`, idempotent:
- Dr `CUSTOMER_DEPOSITS` with the group total for that shipment;
- Cr `VENDOR_PAYABLE:{vendor}` **one entry per order item** = snapshot `vendorRateMinor × quantity` (nothing deducted from the vendor, FD-02);
- Cr `RIVEN_PRODUCT_MARGIN` = Σ snapshot `rivenProfitMinor × quantity`;
- the delivery fee: Cr `DELIVERY_FEE_REVENUE` under FD-18 (a) (recommended), or Cr `COURIER_PAYABLE:{courier}` under FD-18 (b) (pass-through).

The courier's own charge for the delivery posts separately when known (`DELIVERY_COST`, FD-18 a: Dr `DELIVERY_EXPENSE` / Cr `COURIER_PAYABLE`). Failed / refused / return legs post `FAILED_DELIVERY_EXPENSE` / `RETURN_SHIPPING_EXPENSE` per FD-08 (`commerce/04` §7.11–7.12). Legacy order items without a pricing snapshot follow `commerce/06` §5.3.1 (vendor payable = old price × quantity, no margin).

## 4. COD collection, remittance and reconciliation (Phase 5)

### 4.0 Production restriction and the six COD amounts (COU-01, COU-03; added 2026-10-25)

**COD stays disabled in production** (`COD_ENABLED=false`; checkout answers 400 `PAYMENT_METHOD_UNAVAILABLE`) until the Phase 5 exit criteria (`commerce/10` §5) pass and the production gate PRG-07 holds. Phases 3–4 may exercise COD only in non-production.

The design keeps six amounts apart; none is ever inferred from another:

| Amount | What it is | Where it lives | Evidence | Becomes Riven's money? |
|---|---|---|---|---|
| Customer's COD obligation | what the customer must pay at the door = group `totalMinor` | `shipments.codAmountMinor` (and the manifest's COD total) | order snapshot | no |
| Courier's collected cash | what the courier says it collected | `cod_collections.collectedMinor`; Dr `COURIER_RECEIVABLE:{courier}` / Cr `CUSTOMER_DEPOSITS` | courier delivery report | no — it is a receivable from the courier |
| Courier's outstanding remittance | collected − allocated − written off | balance of `COURIER_RECEIVABLE:{courier}` | ledger | no |
| Riven's confirmed cash receipt | money that arrived in Riven's bank from the courier | `courier_remittances.receivedMinor` → Dr `BANK` on allocation | bank statement line | **yes**, once allocated and reconciled |
| Vendor payable | vendor rate × quantity of delivered items | Cr `VENDOR_PAYABLE:{vendor}` at DELIVERED | order-item snapshot | owed to the vendor, paid only when the collection is RECONCILED (FD-03) |
| Riven's revenue / margin | markup (and delivery fee under FD-18 a) | Cr `RIVEN_PRODUCT_MARGIN` / `DELIVERY_FEE_REVENUE` at DELIVERED | snapshot | recognized at delivery; **cash** only after remittance |

A delivered COD shipment is never reported as "money received" until its collection is REMITTED_TO_RIVEN or RECONCILED (§4.3).

### 4.1 Collection
- `CodCollection` created NOT_COLLECTED at handover.
- `PATCH /admin/cod-collections/:id/collect {collectedMinor, collectedAt, evidenceKey?}` (OPS/FINANCE) — or via `/admin/shipments/:id/deliver` — moves it to COLLECTED_BY_COURIER (full) or PARTIALLY_COLLECTED (+ `PaymentException(COD_SHORT_COLLECTION)`, FD-05) and posts Dr COURIER_RECEIVABLE / Cr CUSTOMER_DEPOSITS.
- Refused/failed → COLLECTION_FAILED; nothing posted to deposits.

### 4.2 Remittance
- `POST /admin/courier-remittances` (FINANCE) `{ courierId, reference, reportedMinor, receivedMinor, receivedAt, receivingAccountId, deductions: [{ type, amountMinor, shipmentId? }] }` → RECORDED. `(courierId, reference)` unique — the same statement cannot be entered twice.
- `POST /admin/courier-remittances/:id/allocations` `{ lines: [{ collectionId, amountMinor }] }` — under the L5 remittance lock and sorted collection locks (W22):
  - `Σ allocations + Σ deductions ≤ reportedMinor` → else 409 `ALLOCATION_EXCEEDS_REMITTANCE`;
  - per collection `remittedMinor + amount ≤ collectedMinor` → else 409 `ALLOCATION_EXCEEDS_COLLECTION`;
  - collections move to PARTIALLY_REMITTED / REMITTED_TO_RIVEN; ledger Dr BANK (+ deductions) / Cr COURIER_RECEIVABLE.
- One remittance may cover many collections; one collection may be paid by several remittances (allocation rows are the many-to-many link). Corrections are negative allocation rows with a reason (append-only).
- `receivedMinor − Σ allocations` > 0 → posted to `UNALLOCATED_COURIER_CASH:{courier}` and shown on the report until allocated or returned.
- `PATCH /admin/courier-remittances/:id/reconcile` (FINANCE_APPROVER) — requires ALLOCATED and `receivedMinor` matched to a bank receipt; moves allocated collections to RECONCILED.
- `PATCH /admin/courier-remittances/:id/dispute` / `/resolve` — short payments, excess, unknown lines.
- Write-off of a courier shortfall: maker-checker, Dr COURIER_LOSS_EXPENSE / Cr COURIER_RECEIVABLE.

### 4.3 Reconciliation report — `GET /admin/reports/cod-reconciliation?courierId=&from=&to=`

Per courier and in total: expected (Σ COD shipments handed over), collected (Σ `collectedMinor`), reported by courier (Σ `reportedMinor`), received by Riven (Σ `receivedMinor`), deductions, allocated, **outstanding courier balance** (ledger `COURIER_RECEIVABLE`), unallocated cash, disputed amount, and the list of collections delivered but not yet remitted (aged 0–7, 8–14, > 14 days). A delivered COD shipment is never shown as "money received" unless its collection is REMITTED_TO_RIVEN or RECONCILED.

### 4.4 Discrepancies: who investigates, who approves (COU-04)

| Discrepancy | Detected by | Investigates | Approves an adjustment | Ledger effect of the adjustment |
|---|---|---|---|---|
| Collected < expected (shortage) | collection entry; REC-CHK-09 | FINANCE (OD-05) with the courier | FINANCE_APPROVER | customer still owes / courier owes; write-off only by maker-checker: Dr COURIER_LOSS_EXPENSE / Cr COURIER_RECEIVABLE |
| Remitted > due (excess) | remittance allocation | FINANCE (OD-05) | FINANCE_APPROVER | stays in `UNALLOCATED_COURIER_CASH` until allocated or returned to the courier |
| Remitted < due (short remittance) | allocation; ageing report | FINANCE (OD-05) | FINANCE_APPROVER | receivable stays open; dispute with the courier |
| Unknown statement line | remittance entry | FINANCE (OD-05) | FINANCE_APPROVER | none until matched |
| Lost / damaged parcel | shipment LOST / DAMAGED_IN_TRANSIT | OPS + FINANCE | FINANCE_APPROVER | FD-25 (`commerce/04` §7.18) |

Every adjustment is a new journal with reason and audit; collections and remittances are never edited (allocations are append-only; corrections are negative allocation rows).

## 5. Returns (Phase 7, needs BD-04 and FD-19; rewritten 2026-10-25, RET-01 – RET-04)

**Production restriction (RET-02):** while BD-04 and FD-19 are pending, returns after delivery and the refunds they would trigger are disabled in production (`RETURNS_ENABLED=false` → 403 `RETURNS_NOT_AVAILABLE`). Refunds for payment exceptions and cancellations before delivery are unaffected (`vendor-settlement-spec.md` §9).

Five separate steps (`commerce/03` §9); **no step executes a refund by itself**:

| Step | Method & path | Actor | Effect |
|---|---|---|---|
| 1 Return Request | `POST /orders/:id/returns` `{ lines: [{ orderItemId, quantity }], reason }` + `Idempotency-Key` | SHOPPER (owner; inside the window; DELIVERED; quantities ≤ delivered − already returned) | request REQUESTED; no money, no stock |
| | `GET /orders/:id/returns` | SHOPPER | own requests with each step's status |
| | `PATCH /admin/returns/:id/review` · `/approve` · `/reject {reason}` | SUPPORT | APPROVED creates the return shipment; REJECTED ends it |
| 2 Physical Return | `PATCH /admin/return-shipments/:id/in-transit {courierId, trackingNumber}` · `/received {evidenceKeys}` · `/lost` (maker) + `/lost/approve` (FINANCE_APPROVER) | OPS | RECEIVED → quarantine movements (`quarantined += q`) |
| 3 Return Inspection | `POST /admin/return-lines/:lineId/inspections {quantity, outcome, notes, evidenceKeys}` | OPS / INVENTORY | ACCEPTED_RESTOCK → `on_hand` (sellable only now); ACCEPTED_DAMAGED → `damaged`; ACCEPTED_RETURN_TO_VENDOR → leaves custody; REJECTED_RETURN_TO_CUSTOMER → shipped back, no refund; DISPUTED → stays quarantined; re-inspection = new row |
| 4 Refund Approval | `POST /admin/refunds {inspectionIds, amountMinor, vendorShareMinor, rivenShareMinor, allocationReason}` (FINANCE, maker) · `PATCH /admin/refunds/:id/approve` (FINANCE_APPROVER ≠ maker) | FINANCE / FINANCE_APPROVER | only from ACCEPTED inspections (409 `REFUND_SOURCE_INVALID` otherwise); approval posts the reversal journal |
| 5 Refund Execution | `PATCH /admin/refunds/:id/process` → `/complete {externalReference}` · `/fail {reason}` · `/retry` | FINANCE | money sent and recorded; failure never re-sends automatically |
| close | `PATCH /admin/returns/:id/close` | SUPPORT | allowed when every line has a final inspection and every resulting refund is COMPLETED or REJECTED; **creates nothing** |

**Financial effects (FD-19 pending — both options documented, neither assumed; `commerce/04` §7.10):** option (a) refunds the full customer price, reversing the item's vendor payable and Riven margin; option (b) refunds the vendor rate only, reversing the vendor payable (legal check under BD-04). The delivery entries are never edited; the reversal is a new journal. If the vendor was already paid, the vendor balance goes negative and is carried forward or recovered (`commerce/04` §7.16, FD-11). Return shipping cost per FD-08 (`commerce/04` §7.11). Partial refunds per FD-24 (`commerce/04` §7.17).

Each step writes its `FulfilmentEvent` (RETURN_REQUESTED, RETURN_RECEIVED, RETURN_INSPECTED), so the vendor sees `RETURNED` / `PARTIALLY_RETURNED` (§2.2). Audit events: `commerce/03` §9.

## 6. Errors

`SHIPMENT_STATE_CONFLICT`, `INVALID_SHIPMENT_TRANSITION`, `TRACKING_NUMBER_IN_USE`, `COD_COLLECTION_REQUIRED`, `COURIER_HANDOVER_REQUIRED`, `RETURNS_NOT_AVAILABLE`, `REFUND_SOURCE_INVALID`, `PAYMENT_METHOD_UNAVAILABLE` (COD disabled), `FULFILMENT_MANAGED_BY_RIVEN`, `COLLECTION_STATE_CONFLICT`, `REMITTANCE_REFERENCE_EXISTS`, `ALLOCATION_EXCEEDS_REMITTANCE`, `ALLOCATION_EXCEEDS_COLLECTION`, `REMITTANCE_NOT_ALLOCATED`, `RETURN_WINDOW_CLOSED`, `RETURN_QUANTITY_INVALID`, `RETURN_STATE_CONFLICT`, `MAKER_CANNOT_APPROVE`.

## 7. Audit

Actions: `SHIPMENT_TRANSITIONED` (with from/to state), `SHIPMENT_LOST_APPROVED`, `COURIER_CHANGED`, `COD_COLLECTION_RECORDED`, `COURIER_REMITTANCE_RECORDED`, `REMITTANCE_ALLOCATED`, `REMITTANCE_RECONCILED`, `REMITTANCE_DISPUTED`, `COURIER_SHORTFALL_WRITTEN_OFF`, `RETURN_REVIEWED`, `RETURN_INSPECTED`. Targets: `SHIPMENT`, `COURIER`, `COD_COLLECTION`, `COURIER_REMITTANCE`, `RETURN_REQUEST`.

## 8. Tests

Unit: shipment, collection, remittance and return machines; vendor-status projection (every row of `commerce/03` §14, table-driven). Concurrency: C-6, C-7, C-9, C-21, C-VP1, C-VP2 (`commerce/05`). E2E: COD happy path (confirm → handover → deliver + collect → remit with deductions → reconcile), short remittance, excess remittance, refusal → return → inspection, prepaid lost parcel; each transition followed by a vendor poll showing the new status and event timestamp; delivered journal amounts equal the order-item snapshots (running example `commerce/04` §7: 500.00 + 400.00 payable, 54.00 margin, 60.00 delivery fee). Report test: every figure in §4.3 equals the ledger and collection tables. Acceptance criteria 29, 30, 40 (`commerce/10` §2a).

## 9. Open items

BD-02, BD-04, BD-05, BD-09, BD-13, BD-16, BD-20, BD-22, BD-26, BD-27, FD-02, FD-06, FD-07, FD-08, FD-10, FD-18, FD-19, FD-24, FD-25; TD-16; TQ-04, TQ-23. Gap-closure scenarios: AT-COU-01–AT-COU-09, AT-RET-01–AT-RET-07 (`commerce/14`).
