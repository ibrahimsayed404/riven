# Payments Module Spec — Pass 2 (Paymob hardening, manual transfers, COD)

**Status:** Draft for review — **not implemented**. Nothing in this file is decided until the BLOCKING items it cites are approved in `specs/commerce/08-decision-register.md`.
**Builds on:** `specs/payments-module-spec.md` (pass 1: bazaar fees and vendor subscriptions — untouched, still unbuilt), `specs/cart-checkout-orders-spec.md`, `specs/fashion-marketplace-addendum.md`. Neither file is modified; this pass supersedes pass 1 §5's second webhook route (`POST /payments/webhook/paymob`) — there is exactly one route, `POST /webhooks/paymob` (conflict C6).
**Architecture:** `specs/commerce/01`–`06`. This spec is the module-level contract; the commerce documents hold the reasoning. Item pricing and delivery-zone administration: `specs/pricing-module-spec.md`.
**Updated 2026-10-25:** checkout pricing breakdown (markup snapshot), location-based delivery fee, `expectedTotalMinor` / `PRICE_CHANGED`, `DELIVERY_AREA_NOT_SERVED`; `shippingFeeMinor` renamed `deliveryFeeMinor`.
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-24.

---

## 0. Conventions

- Errors are coded (`{ code, message, details? }`); every code below is stable.
- Every write runs in `withRetryableTx` and follows the lock order in `commerce/05-race-matrix.md` §2 (workflow ids W2–W13).
- Every financial action writes its audit row with `recordInTx` (TD-03).
- Amounts are integer minor units + `currency` (`commerce/04` §3).
- Paymob behaviour visible to clients does not change (contract tests, `commerce/06` §4.2).

## 1. Scope

| In | Out |
|---|---|
| `PaymentTransaction` model for all methods and payment exceptions (Phase 0 / 3b); Paymob provider-event inbox, expiry and reconciliation (**PAYMOB activation milestone**, TD-21 — deferred, not rejected) | bazaar listing fees, vendor subscriptions (pass 1) |
| Expiry / grace / cap for Paymob attempts; payment reconciliation worker (Phase 0) | Paymob refunds via API (FD-12, DEFERRED) |
| Manual TRANSFER: instructions, private proof upload, proof review, reference claims, SLA (Phase 3) | automated bank-statement matching (TQ-14) |
| COD placement and confirmation call (payment side; Phase 3/4) | COD collection and remittance (`fulfilment-module-spec.md`) |
| Ledger postings for money received (Phase 3, `vendor-settlement-spec.md` §2) | refunds execution (`vendor-settlement-spec.md` §5) |

**Production availability per method (added 2026-10-25; no real customer orders before the readiness gate, `commerce/10` §6):**

| Method | Production status |
|---|---|
| PAYMOB | supported in code, **disabled in production** until payment reconciliation can run unattended (TD-13, R-D4) |
| TRANSFER | available only after Phase 3b exit (proof review by an admin, reference claims, ledger) and the PRG gate |
| COD | **disabled in production** (`COD_ENABLED=false` → 400 `PAYMENT_METHOD_UNAVAILABLE`) until the Phase 5 exit criteria pass (COU-01) |

## 2. Checkout contract (changes to `POST /checkout`)

Request body — **all fields optional**; an empty body behaves exactly as today (PAYMOB, no address, no delivery fee) (compatibility, BD-11):

```json
{
  "paymentMethod": "PAYMOB | TRANSFER | COD",
  "shippingAddress": { "name": "…", "phone": "+20…", "governorate": "EG-C", "city": "…", "street": "…", "notes": "…" },
  "expectedTotalMinor": 101400
}
```

`governorate` is a code from the fixed list of 27 Egyptian governorates (TQ-18); `city` is optional free text used only for city-level zone overrides (BD-30). `expectedTotalMinor` is the total the shopper was shown (from `GET /checkout/options`); optional on the unversioned route, required on `/v1/checkout` once pricing is live (FD-21).

Header `Idempotency-Key` (optional on the unversioned route, required on `/v1/checkout`, TD-07).

Rules:
- `TRANSFER` and `COD` require `shippingAddress` (400 `SHIPPING_ADDRESS_REQUIRED`).
- `COD` refused when the shopper is COD-blocked (BD-05) → 403 `COD_NOT_AVAILABLE`, or above the COD cap (BD-14) → 400 `COD_LIMIT_EXCEEDED`.
- `PAYMOB` while Paymob is unconfigured → unchanged behaviour (`paymentSetupFailed: true`) on the unversioned route; 503 `PAYMENT_METHOD_UNAVAILABLE` on `/v1`.
- **Item prices (Phase 3, FD-02 / FD-20, `specs/pricing-module-spec.md`):** inside the checkout transaction each line is priced from the variant's current vendor rate and the markup in force: `rivenProfitMinor = round_half_up(vendorRateMinor × markupBps / 10 000)` per unit, `customerUnitPriceMinor = vendorRateMinor + rivenProfitMinor`. The four values and `pricingConfigVersionId` are **snapshotted on the order item** (never updated afterwards); `itemsTotalMinor = Σ customerUnitPriceMinor × quantity`, `vendorTotalMinor` and `rivenProfitTotalMinor` likewise. A variant with no customer price (FD-17 option c) → 400 `CHECKOUT_ITEM_UNAVAILABLE`.
- **v7 (2026-10-27):** the delivery fee is a temporary **flat 80.00 EGP per order** (FD-29, approved by Ibrahim as reported by Youssef), configured as one national zone so the rule below still applies unchanged; cart price changes follow the per-item acknowledgment of `commerce/20` (FD-21, approved): checkout refuses any item that is CHANGED and not REVIEWED at its current price version (409 `PRICE_CHANGED`), and every payment attempt uses the order snapshot total. *(The response example below uses an illustrative 60.00 fee.)*
- **Delivery fee (Phase 3, FD-04 / BD-30):** the address resolves to a delivery zone (`governorate` + optional `city` override → `delivery_zone_areas`), then to the zone's approved rate in force (`delivery_zone_rates`, latest approved row with `effectiveFrom ≤ now()`), read inside the checkout transaction. `deliveryFeeMinor`, `deliveryZoneId` and `deliveryZoneRateId` are frozen on the group. No mapping or no approved rate → 400 `DELIVERY_AREA_NOT_SERVED`. The fee is **never marked up**. Its accounting treatment is FD-18.
- `totalMinor = itemsTotalMinor + deliveryFeeMinor`; this is the only amount any payment (Paymob intention, transfer proof, COD collection) is checked against. The Paymob intention amount therefore includes the delivery fee from Phase 3 on.
- **Price confirmation (FD-21):** if `expectedTotalMinor` is present and differs from the computed `totalMinor` → 409 `PRICE_CHANGED` with `details: { items: [{ variantId, quantity, customerUnitPriceMinor }], deliveryFeeMinor, totalMinor }`; nothing is created and no stock is reserved. The client shows the new total and resubmits with the new value (new `Idempotency-Key`).
- Empty-body PAYMOB checkout without an address (until BD-11 is decided): `deliveryFeeMinor = 0`, exactly as today. If BD-11 makes the address mandatory, the unversioned route keeps accepting the empty body only until the compatibility window ends (TD-07).
- Reservation lifetimes per method, the proposed 30-minute proof deadline, the hold while a proof is reviewed and recovery without workers: `commerce/21` (Part Four; BD-07 / BD-18 pending).
- Stock is reserved for every line in the checkout transaction (Phase 0: `stockQuantity` decrement + RESERVE movement; Phase 1: reservations). Any line short → 400 `CHECKOUT_ITEM_UNAVAILABLE` (unchanged).
- The cart row is locked and re-read inside the transaction; the deleted-items count must equal the lines ordered (R5).

Response — existing fields unchanged (`id`, `orders[]`, `paymobIntentId`, `clientUrl`, `paymentSetupFailed`), plus additive fields:

```json
{
  "paymentMethod": "TRANSFER",
  "paymentStatus": "UNPAID",
  "currency": "EGP",
  "items": [
    { "orderItemId": "…", "variantId": "…", "quantity": 1, "customerUnitPriceMinor": 53000, "lineTotalMinor": 53000 },
    { "orderItemId": "…", "variantId": "…", "quantity": 1, "customerUnitPriceMinor": 42400, "lineTotalMinor": 42400 }
  ],
  "itemsTotalMinor": 95400,
  "delivery": { "zoneCode": "CAIRO_GIZA", "feeMinor": 6000 },
  "deliveryFeeMinor": 6000,
  "totalMinor": 101400,
  "reservationExpiresAt": "…",
  "paymentInstructions": {             // TRANSFER only
    "paymentCode": "RV-8F3A21",
    "amountMinor": 101400,
    "accounts": [{ "id": "…", "channel": "INSTAPAY", "label": "Riven", "identifier": "riven@instapay" }],
    "submitBefore": "…"
  }
}
```

Shoppers see customer prices only. The vendor-rate / Riven-profit split is never returned on shopper routes (it is internal; vendors see it per BD-26, finance staff on admin routes).

`GET /checkout/options?governorate=&city=` (SHOPPER) → available methods for the current cart (`{ method, available, reason? }[]`), per-line current customer prices, `itemsTotalMinor`, the delivery zone and `deliveryFeeMinor` for that address (or `deliveryAvailable: false` with reason `DELIVERY_AREA_NOT_SERVED`), `totalMinor` (to send back as `expectedTotalMinor`), COD cap. It is a quote: nothing is reserved or frozen.

## 3. Paymob (**deferred to the PAYMOB activation milestone**, TD-21) — behaviour unchanged for clients, made safe underneath

*2026-10-27:* PAYMOB remains a supported payment method and is **not rejected**; it stays disabled in production and the design below is implemented later, gated by PMA-01 – PMA-08 (`commerce/21` §5.1). The late-success outcome is BD-17 (pending).

### 3.1 Attempts
- `POST /checkout` (PAYMOB) and `POST /checkout/:id/retry-payment` create a `PaymentTransaction` `CREATED` row and commit **before** calling Paymob; a second transaction moves it to `INITIATED` with `providerIntentId`, `providerOrderId`, `clientUrl`, `expiresAt`, `graceUntil` (`commerce/03` §3.1).
- One open attempt per group (partial unique). `retry-payment`:
  - attempt live → returns its `clientUrl` (fixes R25; previously 400 `PAYMENT_ALREADY_SET_UP`, which is now returned only when the group is already paid);
  - previous attempt terminal and `now < reservationCapAt` → new attempt;
  - `now ≥ reservationCapAt` → 409 `RESERVATION_EXPIRED`.
- Legacy `OrderGroup.paymob*` fields are written only by `projectLegacyPaymentFieldsInTx` (`commerce/06` §4).

### 3.2 Webhook (`POST /webhooks/paymob`, unchanged route and signature checks)
1. Verify HMAC (unchanged). Insert `payment_provider_events` (`ON CONFLICT DO NOTHING`); duplicate event → 200 `{ received: true, outcome: 'duplicate' }`.
2. Unsigned or invalid → stored with `signatureValid=false`, 401 (unchanged codes).
3. Every signed event type is stored (success, decline, void, refund) — not only successes (R20).
4. Success → W3 lock sequence: L1 group → match attempt by signed `order.id` (`providerOrderId`, falling back to `providerIntentId`) → verify **amount and currency** (R19) → apply `commerce/03` §3.1.
5. Outcomes stay as today (`paid`, `duplicate`, `orphan`, `amount_mismatch`, `double_payment`, `unmatched`) plus `currency_mismatch`; each non-`paid` outcome creates a `PaymentException` instead of only logging (R2, R6).
6. `paidAt` is set only when orders actually moved to PAID (R9).

### 3.3 Expiry and reconciliation workers
- Expiry worker (existing job, rewritten): `FOR UPDATE SKIP LOCKED` on candidate groups; skips groups with a live attempt; releases at `min(graceUntil, reservationCapAt)`; never cancels a group whose attempt SUCCEEDED.
- Payment reconciliation worker (new, every minute): for attempts `INITIATED` past `expiresAt`, call the Paymob inquiry (TQ-01) **outside** any transaction, then apply the result under W7. Unreachable Paymob → no change; the cap still releases stock.

## 4. Manual transfer (Phase 3)

### 4.1 Receiving accounts
`receiving_accounts` rows (seeded from configuration; admin-editable by FINANCE_APPROVER): channel, label, identifier, linked ledger `BANK:*` account. Shown in `paymentInstructions`.

### 4.2 Proof upload
`POST /orders/groups/:groupId/payment-proofs/upload-url` (SHOPPER, owner) → presigned POST to the private bucket, key `payment-proof/<userId>/<uuid>`, 5 min, 10 KB–5 MB, jpeg/png/webp (`commerce/07` §4).

### 4.3 Proof submission — `POST /orders/groups/:groupId/payment-proofs`
Body: `{ key, channel, senderPhone, transactionRef, receivingAccountId, claimedAmountMinor, currency }`; `Idempotency-Key` (scope `proof-submit`).

Validation, in order (each failure is a coded 4xx):

| Check | Error |
|---|---|
| group owned by caller | 404 `ORDER_GROUP_NOT_FOUND` |
| method TRANSFER, group PLACED | 409 `PROOF_NOT_ACCEPTED_FOR_GROUP` |
| within submit / resubmit window and before cap | 409 `PROOF_WINDOW_CLOSED` |
| attempts < BD-06 max | 409 `PROOF_ATTEMPTS_EXHAUSTED` |
| no open proof | 409 `PROOF_ALREADY_OPEN` |
| channel allowed and matches the receiving account | 400 `PROOF_CHANNEL_INVALID` |
| `currency` = group currency; `claimedAmountMinor` > 0 | 400 `PROOF_AMOUNT_INVALID` |
| `senderPhone` is an Egyptian mobile number (E.164 `+20 1x…`) | 400 `PROOF_PHONE_INVALID` |
| reference normalizes and matches the channel pattern | 400 `PAYMENT_REFERENCE_INVALID` |
| file: key owned, exists, size, magic bytes | 403 `PROOF_FILE_NOT_OWNED` / 400 `PROOF_FILE_INVALID` |
| reference claim | 409 `PAYMENT_REFERENCE_ALREADY_USED` |

`claimedAmountMinor ≠ totalMinor` is **accepted** and flagged for the reviewer (the shopper's claim is not trusted either way; the reviewer enters what actually arrived). Identical screenshot SHA-256 already used by another group → accepted but flagged `DUPLICATE_IMAGE` for the reviewer.

Same transaction: PaymentTransaction (attempt 1, PENDING_VERIFICATION) created on first proof; proof SUBMITTED; claim CLAIMED (+ event); group `paymentStatus = AWAITING_REVIEW`; reservation expiry extended (`commerce/03` §3.2); outbox `payment_proof.submitted`; audit.

### 4.4 Review (FINANCE)
- `PATCH /admin/payment-proofs/:id/claim` → UNDER_REVIEW, reviewer = caller.
- `PATCH /admin/payment-proofs/:id/approve` body `{ receivedAmountMinor, receivingAccountId, note? }` — reviewer only; `receivedAmountMinor` is what the reviewer saw arrive in Riven's account.
  - `= totalMinor` → approve (`commerce/03` §3.2, §6.3 if stock was released).
  - `> totalMinor` → approve + `PaymentException(TRANSFER_OVERPAYMENT)` + refund REQUESTED for the excess (FD-05).
  - `< totalMinor` → 409 `TRANSFER_SHORTFALL` (reviewer must reject NEEDS_CORRECTION with the remaining amount, FD-05).
- `PATCH /admin/payment-proofs/:id/reject` body `{ kind: NEEDS_CORRECTION | FRAUDULENT, reason }`.
- `PATCH /admin/payment-proofs/:id/reassign` (FINANCE_APPROVER).
- `GET /admin/payment-proofs?status=&escalated=&channel=` · `GET /admin/payment-proofs/:id` (includes a ≤ 5 min signed image URL, group total, previous attempts, reference-claim history, duplicate-image flag).
- SLA escalation: while workers are postponed (TD-13) "overdue" is **computed on read** (`now > reviewDueAt`) and shown in the queue (`commerce/01` §13); a scheduled maintenance run (TD-18, pending) may additionally mark `escalatedAt` and write `payment_proof.sla_breached` (notification NE-43).

### 4.5 Reference claims (`commerce/03` §5)
- `GET /admin/payment-reference-claims?ref=&channel=`
- `POST /admin/payment-reference-claims/:id/disputes` (FINANCE, maker; reason + evidence keys)
- `PATCH /admin/payment-reference-claims/:id/resolve` body `{ to, reason }` (FINANCE_APPROVER, checker ≠ maker)

## 5. COD (payment side)

- Checkout with `COD`: PaymentTransaction `AWAITING_COLLECTION`; group `paymentStatus = AWAITING_COLLECTION`; reservations ACTIVE until `createdAt + COD_CONFIRM_WINDOW`.
- `PATCH /admin/orders/groups/:id/cod-confirmation` (OPS/SUPPORT) body `{ outcome: CONFIRMED | UNREACHABLE | CANCELLED_BY_CUSTOMER, note }` → CONFIRMED moves the group to CONFIRMED (reservations CONFIRMED); the other outcomes cancel the group and release stock.
- Collection, remittance and reconciliation: `fulfilment-module-spec.md` §4.

## 6. Payment exceptions

- `GET /admin/payment-exceptions?status=&type=` (FINANCE)
- `PATCH /admin/payment-exceptions/:id/refund` → creates a Refund (`vendor-settlement-spec.md` §9), status REFUND_IN_PROGRESS; the refund goes to the original sending instrument where possible, otherwise to a verified customer destination (`commerce/15`, FD-26 / SD-10 pending)
- `PATCH /admin/payment-exceptions/:id/resolve` body `{ resolution, reason }` — without refund requires maker-checker.

## 7. Shopper read endpoint

`GET /orders/groups/:groupId/payment` (owner) → method, status, amounts, `paymentCode`, instructions, open attempt (`clientUrl` while live), proofs (status, rejection kind/reason, attempt numbers — never other users' data), reservation expiry. Used for polling and app-restart recovery (`commerce/09` §5).

## 8. Error codes (new)

`SHIPPING_ADDRESS_REQUIRED`, `DELIVERY_AREA_NOT_SERVED`, `PRICE_CHANGED`, `COD_NOT_AVAILABLE`, `COD_LIMIT_EXCEEDED`, `PAYMENT_METHOD_UNAVAILABLE`, `RESERVATION_EXPIRED`, `PAYMENT_ATTEMPT_OPEN`, `ORDER_GROUP_NOT_FOUND`, `PROOF_NOT_ACCEPTED_FOR_GROUP`, `PROOF_WINDOW_CLOSED`, `PROOF_ATTEMPTS_EXHAUSTED`, `PROOF_ALREADY_OPEN`, `PROOF_CHANNEL_INVALID`, `PROOF_AMOUNT_INVALID`, `PROOF_PHONE_INVALID`, `PAYMENT_REFERENCE_INVALID`, `PAYMENT_REFERENCE_ALREADY_USED`, `PROOF_FILE_NOT_OWNED`, `PROOF_FILE_INVALID`, `PROOF_ALREADY_CLAIMED`, `PROOF_ALREADY_REVIEWED`, `NOT_PROOF_REVIEWER`, `PROOF_UNDER_REVIEW`, `TRANSFER_SHORTFALL`, `INVALID_PAYMENT_PROOF_TRANSITION`, `CLAIM_RELEASE_REQUIRES_APPROVAL`, `MAKER_CANNOT_APPROVE`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, `STATE_CONFLICT`, `TRY_AGAIN`.

Kept unchanged: `CART_EMPTY`, `CHECKOUT_ITEM_UNAVAILABLE`, `PAYMENTS_NOT_CONFIGURED`, `PAYMENT_ALREADY_SET_UP` (narrowed meaning, §3.1), `ORDER_GROUP_FORBIDDEN` (replaced by 404 on `/v1`, R18), `WEBHOOK_SIGNATURE_MISSING`, `WEBHOOK_SIGNATURE_INVALID`.

## 9. Audit (`AdminAction` / `AdminTargetType` additions)

Actions: `PAYMENT_PROOF_CLAIMED`, `PAYMENT_PROOF_APPROVED`, `PAYMENT_PROOF_REJECTED`, `PAYMENT_PROOF_REASSIGNED`, `PAYMENT_REFERENCE_DISPUTED`, `PAYMENT_REFERENCE_RESOLVED`, `PAYMENT_EXCEPTION_OPENED` (system), `PAYMENT_EXCEPTION_RESOLVED`, `COD_CONFIRMATION_RECORDED`, `RECEIVING_ACCOUNT_CHANGED`, `ORDER_GROUP_EXPIRED` (system), `PAYMENT_LATE_RECEIVED` (provider).
Targets: `ORDER_GROUP`, `PAYMENT_TRANSACTION`, `PAYMENT_PROOF`, `PAYMENT_REFERENCE_CLAIM`, `PAYMENT_EXCEPTION`, `RECEIVING_ACCOUNT`.

## 10. Failure scenarios

| Scenario | Behaviour |
|---|---|
| Paymob down at checkout | attempt INITIATION_FAILED; `paymentSetupFailed: true`; stock held until cap; retry allowed |
| Crash between attempt CREATED and Paymob call | reconciliation worker inquires by `special_reference`; none → EXPIRED |
| Webhook arrives before the `INITIATED` transaction committed (signed `order.id` not stored yet) | no attempt matches → event stays stored as `RECEIVED` / `unmatched`; the reconciliation worker re-processes unmatched signed events once a matching attempt exists; nothing is lost |
| Webhook storm / replay | inbox dedup; one effect |
| Admin approves while shopper cancels | L1 serializes; cancel refused once UNDER_REVIEW (`PROOF_UNDER_REVIEW`) |
| Storage unavailable during proof submit | 503 `TRY_AGAIN`; nothing claimed (file check precedes the transaction) |
| Two proofs with the same reference from different shoppers | second gets 409; dispute workflow if legitimate |

## 11. Tests

Unit (state machines, normalization, validation, checkout pricing breakdown and zone resolution); e2e (transfer happy path, needs-correction loop to max attempts, fraud rejection, overpayment, COD confirm/unreachable, Paymob paths unchanged, `PRICE_CHANGED` round trip, unserved area, Paymob intention amount = items + delivery fee); concurrency C-E*, C-F*, C-H*, C-1…C-4, C-FR1, C-X1, C-P1, C-PR1, C-DZ1 (`commerce/05`); acceptance criteria 32–35 (`commerce/10` §2a); contract tests (`commerce/06` §4.2); smoke steps for every new route (`scripts/smoke-live.mjs`).

## 12. Open items (go back to Ibrahim / technical approver)

BD-05, BD-06, BD-07, BD-11, BD-13, BD-14, BD-15, BD-17, BD-18, BD-19, BD-30, FD-02, FD-04, FD-05, FD-14, FD-17, FD-18, FD-20, FD-21, SD-01, SD-05, TD-07, TD-14; questions TQ-01, TQ-02, TQ-03, TQ-05, TQ-14, TQ-17, TQ-18. (TD-03 approved 2026-10-24.)
