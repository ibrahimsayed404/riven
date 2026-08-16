# Riven — Payments (Paymob) Module Specification

## 1. Overview & Scope
The Payments module is responsible for the financial infrastructure of Riven:
1. **Organizer Listing Fees**: One-time payment required to transition a bazaar from `DRAFT` to `PUBLISHED` (`POST /payments/bazaar-fee`).
2. **Vendor Subscriptions**: Recurring subscriptions for vendor storefront landing pages (`POST /payments/vendor-subscription`).
3. **Paymob Webhook Processing**: Cryptographic HMAC-SHA512 verification, amount consistency validation, atomic idempotency guards, and asynchronous state transitions (`POST /payments/webhook/paymob`).

> **Key Business Rule (riven-spec.md §1 & §2)**: Riven is a discovery platform, not an e-commerce marketplace. **No shopper transactions, no product sales commissions, no in-app checkout for products.**

---

## 2. Data Model & Entities

```
User (ORGANIZER | VENDOR)
  │
  ├── Vendor
  │     └── Subscription (1:1)
  │           ├── id (UUID)
  │           ├── vendorId (UUID -> Vendor.id, onDelete: Cascade)
  │           ├── plan (String, e.g. "MONTHLY_STANDARD", "ANNUAL_STANDARD")
  │           ├── status (SubscriptionStatus: TRIALING, ACTIVE, PAST_DUE, CANCELED)
  │           ├── paymobRef (String?, nullable)
  │           ├── currentPeriodEnd (DateTime?, nullable)
  │           └── createdAt / updatedAt
  │
  └── Payment (Audit Trail / Ledger)
        ├── id (UUID)
        ├── payerType (PayerType: VENDOR | ORGANIZER)
        ├── payerId (UUID -> Vendor.id or Organizer.id)
        ├── amount (Decimal 10,2)
        ├── purpose (PaymentPurpose: SUBSCRIPTION | BAZAAR_FEE)
        ├── paymobRef (String?, @unique)
        ├── status (PaymentStatus: PENDING, SUCCEEDED, FAILED, REFUNDED)
        └── createdAt / updatedAt
```

---

## 3. Payment Flows & Concurrency Protections

### 3.1 Duplicate Payment Initiation Guard
- When calling `POST /payments/bazaar-fee` or `POST /payments/vendor-subscription`:
  - The repository queries for an existing `PENDING` `Payment` row for the target entity (`payerType`, `payerId`, `purpose`).
  - If a recent pending payment exists (< 30 minutes old), the endpoint returns the **existing pending payment details and checkout URL** rather than creating multiple open billing sessions for the same fee.
  - If the previous pending payment is expired (> 30 minutes old), it is marked `FAILED` (timed out) and a new `PENDING` payment session is generated.

### 3.2 Webhook Atomic Idempotency Guard (Zero Read-Then-Write)
- Paymob webhooks may arrive concurrently or repeatedly upon network retries.
- **Atomic Transition Guard**:
  - The transition from `PENDING` to `SUCCEEDED` is executed using an atomic conditional update:
    ```typescript
    const result = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PaymentStatus.PENDING,
      },
      data: {
        status: PaymentStatus.SUCCEEDED,
        paymobRef: paymobTransactionId,
      },
    });
    ```
  - If `result.count === 1`: This invocation won the transition. It proceeds immediately within the **same `$transaction`** to apply downstream side effects (`Bazaar.status = PUBLISHED` or `Subscription.status = ACTIVE`).
  - If `result.count === 0`: The payment is either non-existent or already transitioned by a concurrent webhook delivery. The transaction cleanly completes and the endpoint returns `200 OK` (`{ received: true, duplicate: true }`) without running duplicate side effects.

### 3.3 Amount Verification in Webhook Handler
- HMAC signature verifies the payload came from Paymob, but amount verification confirms the customer paid the exact required listing/subscription fee.
- Before triggering status updates:
  - The server verifies: `paymobPayload.amount_cents === Math.round(payment.amount.toNumber() * 100)`.
  - **Amount Mismatch Protocol**:
    1. **Status Transition**: Atomically transition `Payment.status = FAILED` (with metadata note / error reason indicating amount mismatch).
    2. **Structured Log & Alert**: Emit an `error` log containing:
       `[PAYMENT_AMOUNT_MISMATCH] Payment ID: <id> | Expected Cents: <expected> | Received Cents: <received> | Paymob Trans ID: <trans_id>`
       This immediately surfaces pricing bugs or tampering to engineering/operations.
    3. **HTTP Response**: Return **`200 OK`** (`{ success: false, error: "AMOUNT_MISMATCH", ignored: true }`) to Paymob. Returning a 4xx/5xx would cause Paymob to retry the webhook deterministically on exponential backoff, which cannot fix a static payload mismatch and causes log spam.
    4. **Abort Downstream Side Effects**: No `Bazaar` or `Subscription` updates are executed.

### 3.4 Subscription Renewal Mechanism & Grace Period Resolution
- **Paymob Tokenized Recurring Billing**:
  - During the first subscription payment, Paymob saves and tokenizes the vendor's payment card.
  - On each renewal period (every 30 days for monthly, 365 days for annual), Paymob's recurring billing engine automatically charges the saved card token and posts a `TRANSACTION` webhook to `/payments/webhook/paymob` **with no manual client action required**.
- **Successful Renewal**: Webhook extends `currentPeriodEnd = currentPeriodEnd + 30 days` and sets `Subscription.status = ACTIVE`.
- **Failed Renewal**:
  - Webhook transitions `Subscription.status = PAST_DUE` (and `Vendor.subscriptionStatus = PAST_DUE`).
  - Vendor enters the **3-day grace period**. The vendor receives push/in-app notifications and can manually update their payment card via the vendor portal.
  - If Paymob succeeds on auto-retry during the 3 days: Webhook restores status to `ACTIVE`.
  - If 3 days elapse without successful payment: The BullMQ background worker marks the subscription `CANCELED` (hiding the vendor from discovery feeds per `specs/vendor-module-spec.md §3.1`).

---

## 4. Paymob Integration & Webhook Security

### 4.1 HMAC-SHA512 Verification
Every webhook request delivers an HMAC hash. The server validates the signature:
1. Concatenate key fields in lexicographical order (amount_cents, created_at, currency, error_occured, has_parent_transaction, id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded, is_standalone_payment, is_voided, order.id, owner, pending, source_data.pan, source_data.sub_type, source_data.type, success).
2. Calculate HMAC using `PAYMOB_HMAC_SECRET` via `crypto.createHmac('sha512', secret)`.
3. If HMAC does not match: return `401 Unauthorized` (`INVALID_WEBHOOK_SIGNATURE`).

---

## 5. Endpoints & API Contract

### `POST /payments/bazaar-fee`
- **Auth**: `Role.ORGANIZER` (Owner only)
- **Body**: `{ "bazaarId": "string UUID" }`
- **Response**: `200 OK` → `{ "paymentId": "uuid", "paymentUrl": "string URL", "status": "PENDING" }`
- **Errors**:
  - `404 Not Found` — `BAZAAR_NOT_FOUND`
  - `403 Forbidden` — `NOT_BAZAAR_OWNER`
  - `400 Bad Request` — `BAZAAR_ALREADY_PUBLISHED`

### `POST /payments/vendor-subscription`
- **Auth**: `Role.VENDOR`
- **Body**: `{ "plan": "MONTHLY_STANDARD" | "ANNUAL_STANDARD" }`
- **Response**: `200 OK` → `{ "paymentId": "uuid", "paymentUrl": "string URL", "status": "PENDING" }`
- **Errors**:
  - `404 Not Found` — `VENDOR_NOT_FOUND`
  - `400 Bad Request` — `INVALID_SUBSCRIPTION_PLAN`

### `GET /payments/my-subscription`
- **Auth**: `Role.VENDOR`
- **Response**: `200 OK` → `{ "subscription": { "plan", "status", "currentPeriodEnd" } }`

### `POST /payments/webhook/paymob`
- **Auth**: Public (HMAC Verified)
- **Body**: Paymob transaction callback object.
- **Response**: `200 OK` → `{ "received": true }`
- **Errors**:
  - `401 Unauthorized` — `INVALID_WEBHOOK_SIGNATURE`
  - `400 Bad Request` — `INVALID_PAYMENT_AMOUNT`

---

## 6. Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `INVALID_WEBHOOK_SIGNATURE` | 401 | Webhook HMAC signature verification failed |
| `INVALID_PAYMENT_AMOUNT` | 400 | Paid amount in webhook does not match expected ledger amount |
| `PAYMENT_NOT_FOUND` | 404 | Payment record not found for transaction |
| `BAZAAR_ALREADY_PUBLISHED` | 400 | Bazaar is already published; fee cannot be paid twice |
| `INVALID_SUBSCRIPTION_PLAN` | 400 | Unsupported subscription plan |
| `PAYMENT_GATEWAY_ERROR` | 502 | Upstream communication failure with Paymob API |
