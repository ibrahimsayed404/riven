# Vendor Module Spec — Pass 3 (vendor portal: operational and financial visibility)

**Status:** Draft for review — **not implemented**. IMPORTANT decisions: BD-26 (what prices vendors see), BD-27 (unpaid orders in the portal), TD-16 (read model and polling), TD-05 (BigInt amounts in JSON), TD-11 (OpenAPI). Each data area also depends on the phase that creates its data (§4).
**Builds on:** `specs/vendor-module-spec.md` (vendor profile and catalogue routes), `specs/vendor-module-spec2.md` (products have no approval gate). Neither is modified. This pass adds the read side of the commerce redesign for vendors; the write rules stay in the owning specs.
**Owning specs:** inventory and intakes — `specs/inventory-module-spec.md` §4–5; orders and timeline — `specs/fulfilment-module-spec.md` §2.1–2.2; prices — `specs/pricing-module-spec.md` §4; statements, payouts, payout accounts — `specs/vendor-settlement-spec.md` §4–8. Security: `specs/commerce/07` §9.
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-25.

---

## 1. Purpose

One backend API for a vendor dashboard (web first; the same routes serve a future mobile vendor view, `commerce/09`). No vendor frontend exists in the repository yet. The portal lets a vendor see:

- their products and prices;
- inventory quantities (received, accepted, available, reserved, in transit, sold, returned, damaged, returned to vendor) and every stock movement;
- intake reports, with acknowledge / dispute actions;
- every order that contains their products, its vendor-facing status, the status changes and their timestamps;
- sales performance;
- financial summary, monthly statements with drill-down, payouts with proof, and receipt confirmation.

## 2. Rules for every portal route

| Rule | How |
|---|---|
| **Isolation** (criterion 29) | `@Roles(Role.VENDOR)` at class level **and** `vendorId = <caller's vendor>` in the same SQL statement as every lookup; a foreign id returns **404** (never 403). Joins that reach other vendors' rows (an order group with several vendors) filter to the caller's `orders` / `order_items` only. A generated test enumerates every `/vendors/me/*` route (`commerce/07` §9, C-VP1). |
| **Freshness** (criterion 30) | reads go to the primary database, no cache layer; every status shown is computed from persisted rows (`commerce/03` §14) and every timestamp comes from a persisted `FulfilmentEvent` / movement / ledger row. Responses carry `Cache-Control: private, no-store`. |
| **Polling** (TD-16) | list and summary responses carry a weak `ETag` (hash of the newest `updatedAt` / `occurredAt` / entry id and the row count of the result); `If-None-Match` → 304. Suggested client interval 30–60 s on open screens. No WebSockets / SSE in the MVP. |
| **Pagination** | cursor-based (`?cursor=&limit=`, max 100); date ranges max 366 days (400 `RANGE_TOO_LARGE`) |
| **Money** | integer minor units + `currency`; statement and balance amounts (BIGINT) as strings per TD-05 |
| **No shopper PII** | for `RIVEN`-mode groups vendors never receive shopper name, phone, email or address (`commerce/07` §9) |
| **Vendor types** | commerce sections return 403 `VENDOR_NOT_MARKETPLACE` for `BAZAAR_ONLY` vendors (BD-12) |
| **Writes** | the portal's only writes are the vendor actions defined in the owning specs (stock delta, intake create/acknowledge/dispute, statement dispute, payout confirmation, payout account); each takes an `Idempotency-Key` and is audited with the vendor user as actor |

## 3. Endpoint catalogue

| Area | Method & path | Owner spec | Phase |
|---|---|---|---|
| Overview | `GET /vendors/me/dashboard` | this spec §5.1 | grows per phase |
| Products | `GET /vendors/me/products` · `GET /:id` (existing; + `vendorRate`, `markupPercent`, `customerPrice`) | pricing §4.1 | existing; prices Phase 3 |
| Inventory | `GET /vendors/me/inventory` | inventory §4.1 | 0 (reduced) / 1–2 |
| Movements | `GET /vendors/me/inventory/movements` | inventory §4 | 0 |
| Stock change | `PATCH /vendors/me/products/:id/variants/:variantId/stock` | inventory §4 | 0 |
| Intakes (v7) | `POST/GET /vendors/me/inventory-intakes` · `GET /:id` · `POST /:id/lines/:lineId/disputes` · `POST /vendors/me/handover-discrepancies/:id/acknowledge` | `commerce/19` §7–10 | 2 |
| Stock withdrawals (v7) | `POST/GET /vendors/me/stock-withdrawals` · `POST /:id/lines/:lineId/receipt` | `commerce/19` §10.3 | 2 |
| Orders | `GET /vendors/me/orders` · `GET /:id` (existing; + `vendorStatus`, `timeline`, item vendor amounts) | fulfilment §2.2 | existing; statuses Phase 4 |
| Sales performance | `GET /vendors/me/analytics/sales` | this spec §5.2 | 4 |
| Financial summary | `GET /vendors/me/balance` | settlement §4.3 | 6 (pending amounts from 4) |
| Statements | `GET /vendors/me/statements` · `GET /:id` · `GET /:id/lines/:lineId` · `GET /:id/export.csv` · `POST /:id/disputes` | settlement §4 | 6 |
| Payouts | `GET /vendors/me/payouts` · `GET /:id` · `GET /:id/proof` · `POST /:id/confirmation` | settlement §7 | 6 |
| Payout accounts | `GET/POST /vendors/me/payout-accounts` · `PATCH /:id/deactivate` | settlement §8 | 6 |

## 4. Delivery by phase

Each phase ships the vendor reads for the data it creates, so the portal is never ahead of the backend:

| Phase | Portal additions |
|---|---|
| 0 | movements list; `inventory` with `available` (= `stockQuantity`) and computed `reserved`; existing orders list with `vendorStatus` from the legacy mapping (`commerce/03` §14 last row) |
| 1 | inventory balances per location |
| 2 | intakes, acknowledge / dispute, `received` / `accepted` / `damaged` / `returnedToVendor` |
| 3 | vendor rate / customer price on products (BD-26) |
| 4 | Riven-fulfilled vendor statuses, timeline, `inTransit`, `sold`; sales analytics; pending (delivered, not yet eligible) amount |
| 6 | balance, statements, payouts, receipt confirmation, payout accounts |
| 7 | `RETURNED` / `PARTIALLY_RETURNED`, `returned` quantities, return lines on statements |

## 5. Portal-specific reads

### 5.1 `GET /vendors/me/dashboard`
One cheap call for the landing page; every number links to a list route with the same filter.

```json
{
  "orders": { "AWAITING_PAYMENT": 2, "PROCESSING": 5, "SHIPPED": 3, "DELIVERED_LAST_30_DAYS": 41, "RETURNED_LAST_30_DAYS": 1 },
  "inventory": { "variants": 36, "outOfStock": 4, "lowStock": 6, "lowStockThreshold": 3 },
  "intakes": { "awaitingYourResponse": 1, "responseDueAt": "2026-11-09T22:00:00Z" },
  "finance": { "currency": "EGP", "balanceMinor": "1500000", "payableNowMinor": "1500000", "nextStatementOn": "2026-12-03", "payoutsAwaitingYourConfirmation": 1, "openDiscrepancies": 0 },
  "asOf": "2026-11-05T09:12:44Z"
}
```

### 5.2 `GET /vendors/me/analytics/sales?from=&to=&groupBy=day|week|month|product`
Computed from order-item snapshots and fulfilment events (delivered date), never from current prices:

| Field | Meaning |
|---|---|
| `unitsSold` | Σ quantity of the vendor's items delivered in the range |
| `grossVendorSalesMinor` | Σ `vendorRateMinor × quantity` of those items (what Riven owes for them) |
| `unitsReturned`, `returnsMinor` | items returned (received) in the range and their vendor amount |
| `netVendorSalesMinor` | gross − returns |
| `ordersCancelled` | the vendor's orders cancelled in the range (no amount: nothing was owed) |
| `topProducts[]` | by units sold, with gross amount |
| `sellThrough` | units sold ÷ units accepted into custody in the range (Phase 2+) |

Consistency test: for a closed month, `grossVendorSalesMinor − returnsMinor` equals the Σ of SALE and RETURN lines on that month's statement (the statement is the financial record; analytics is a view of the same rows).

## 6. Indexes the portal needs (Phase in which each table appears)

`orders (vendorId, createdAt DESC)`, `order_items (orderId)`, `fulfilment_events (orderId, occurredAt)`, `inventory_movements (variantId, createdAt DESC)` + vendor filter through `product_variants.productId → products.vendorId` (or a denormalized `vendorId` column on movements — recommended, written at insert), `inventory_intakes (vendorId, submittedAt DESC)`, `ledger_entries (accountId, createdAt)`, `vendor_statements (vendorId, periodStart DESC)`, `vendor_payouts (statementId)`. Each list query is checked with `EXPLAIN` on the rehearsal snapshot (`commerce/06` §7).

## 7. Errors

`VENDOR_NOT_MARKETPLACE`, `RANGE_TOO_LARGE`, `INVALID_CURSOR`; resource lookups return the owning spec's `*_NOT_FOUND` code with 404 for foreign ids.

## 8. Tests

C-VP1: route enumeration — for every `/vendors/me/*` GET and write route, vendor B using vendor A's ids gets 404 and list routes return only B's rows (mixed-vendor order groups included). C-VP2: freshness — after each persisted transition (confirm, handover, deliver, cancel, return received, intake verify, payout sent), the next vendor read shows the new status and the event's `occurredAt`; `ETag` changes. Analytics-vs-statement consistency (§5.2). No shopper PII in any vendor response for `RIVEN`-mode groups (schema snapshot test). Acceptance criteria 29–30 (`commerce/10` §2a).

## 9. Open items

BD-12, BD-26, BD-27, BD-31, BD-32, SD-09, TD-05, TD-11, TD-16.

## 10. Vendor suspension, restrictions and access (added 2026-10-25 — **proposal, pending**; nothing here is implemented)

### 10.1 Four separate axes
Today Riven has three levers (`schema.prisma` `Vendor`, `User`; `admin-module-spec3.md` B1): **reject** (`verified = false` + `rejectionReason`, used as "suspend"), **user deactivation** (`User.isActive = false`, login refused with 403 `ACCOUNT_DEACTIVATED` and existing tokens rejected — `auth.service.ts:206,252`, `auth.repository.ts:25`) and **soft delete** (`deletedAt`). They mix access with commerce. The proposal keeps them and adds one:

| Axis | Field | Controls | Status |
|---|---|---|---|
| Login access | `User.isActive` (existing) | authentication only | existing |
| Commercial restriction | `Vendor.commerceRestriction` (proposed): NONE / NO_NEW_LISTINGS / NO_NEW_SALES / PAYOUT_HOLD | what the vendor may sell / be paid, without hiding history | **pending BD-31** (conflicts with B1 — C21) |
| Suspension | `verified = false` + `rejectionReason` (existing reject) | public visibility of storefront and products; checkout refuses them (`PUBLIC_PRODUCT_WHERE`) | existing |
| Termination | `deletedAt` (existing) + an offboarding checklist (proposed) | end of the relationship | existing field; checklist pending BD-31 |

### 10.2 What each state blocks and what stays active

| Item | Commerce restriction (NO_NEW_SALES) | Suspended (rejected) | Login deactivated | Terminated |
|---|---|---|---|---|
| New product listings | blocked (also under NO_NEW_LISTINGS) | allowed to edit privately; invisible | no access | blocked |
| Existing product visibility | visible, not purchasable | hidden | unchanged (separate axis) | hidden |
| Verified physical stock at Riven | stays in custody; not sellable; returned to the vendor on request or at termination (RETURN_TO_VENDOR movements) | same | same | returned to vendor (offboarding) |
| Reserved stock (unpaid orders) | released at expiry or by OPS cancel | same (checkout already refuses) | unchanged | released |
| Pending (paid, not shipped) orders | **fulfilled** (Riven's obligation to the shopper) unless Ibrahim decides to cancel + refund | fulfilled | fulfilled | fulfilled or cancelled + refunded (decision per case, audited) |
| Orders already in fulfilment | continue to delivery; payables posted normally | same | same | same |
| Pending intake inspections | completed by Riven; report still issued | same | same | completed; goods returned |
| Open disputes (intake, statement, payout) | continue; vendor can still respond | same | through FINANCE / SUPPORT channel | continue until resolved |
| Vendor statements | generated and issued as usual | same | issued; delivered by FINANCE export (BD-32) | final statement issued |
| Unpaid settlements | paid normally unless PAYOUT_HOLD | paid normally | paid normally | paid (final settlement) |
| Pending payouts | continue unless PAYOUT_HOLD (hold requires a reason and FINANCE_APPROVER) | continue | continue | continue |
| Negative balances | carried forward; recovery per FD-11 | same | same | recovery or write-off per FD-11 |
| Returns and refunds | handled normally; vendor payable reversed as usual | same | same | same |
| Access to historical financial records | **kept** | **kept** | via FINANCE export (no login) — or a scoped read-only session if SD-09 allows | kept read-only for the retention period (SD-05) |

**Never affected by any axis:** existing liabilities in the ledger, issued statements, sent payouts, open discrepancies, audit history. No restriction deletes or edits a financial row.

### 10.3 Financial access while restricted (BD-32, SD-09 — pending)
Proposed: a vendor whose commerce is restricted, suspended or terminated keeps a session limited to `GET /vendors/me/{balance,statements,statements/:id,statements/:id/lines/:lineId,payouts,payouts/:id,payouts/:id/proof}` and `POST /vendors/me/payouts/:id/confirmation`. A deactivated user (`isActive = false`, e.g. for abuse) gets no token; FINANCE sends statements and payout notices to the verified e-mail and records the export (audit). Until BD-32 and SD-09 are approved, **today's behaviour stays in force**: deactivation removes all access, so FINANCE must provide statements by export for any deactivated vendor with an open balance (operational rule, OD-06).

### 10.4 Permissions and audit
Suspend / lift: today any ADMIN (existing reject / verify, audited); proposed SUPPORT once staff permissions exist (SD-01). Commerce restriction: proposed by OPS / FINANCE / SUPPORT, approved by FINANCE_APPROVER (`commerce/07` §12). Deactivation: PLATFORM_OPERATOR. Every change records actor, reason and timestamp; the vendor is notified. Tests: AT-VP-09, AT-VP-10 (`commerce/14`).
