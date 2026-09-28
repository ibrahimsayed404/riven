# Cart, Checkout & Orders Module Spec

**Status:** Draft for review
**Scope:** Shopper cart management, multi-vendor checkout with per-vendor sub-orders, Paymob payment integration (full — intent creation + webhook), order status lifecycle, vendor-facing order management.
**Depends on:** `User`, `Vendor`, `Product`, `ProductVariant`, `Cart`, `CartItem`, `OrderGroup`, `Order`, `OrderItem` (all already migrated per the fashion marketplace addendum).
**Blocked (partial):** Live Paymob testing requires sandbox credentials (`PAYMOB_API_KEY`, `PAYMOB_INTEGRATION_ID`, `PAYMOB_HMAC_SECRET`) — currently blank in `.env.example`. Integration code will be built and unit-tested with mocked HTTP responses; end-to-end verification against real Paymob waits until credentials exist. Flag clearly in implementation, don't let this block merging the rest of the module.
**Stock strategy:** Decrement at checkout (order creation), not at add-to-cart. Simpler, no reservation/TTL machinery. Accepted tradeoff: possible overselling under high concurrent demand on the same SKU — acceptable for now, revisit only if it becomes a measured problem.

---

## 1. Cart

Shopper-only (`@Roles(Role.SHOPPER)`). One cart per user (schema already enforces via `Cart.userId @unique`).

**Endpoints:**
- `GET /cart` — returns own cart with items, each item expanded with product title/current price/variant details (for display — but see Section 2 on why we don't trust this for checkout math).
- `POST /cart/items` — add item: `{ productId, variantId, quantity }`. If `(cartId, variantId)` already exists (unique constraint), increment quantity instead of erroring — natural "add another one" behavior.
  - Validate: product must be `isActive: true`, `deletedAt: null`, and vendor `verified: true` (same visibility rule as public product browsing — products have no approval gate, product decision 2026-09-27) — you can't add an invisible product to your cart.
  - Validate: `quantity <= variant.stockQuantity` at add-time (soft check — stock can still change by checkout time, re-validated there; this is just early UX feedback, not the source of truth).
- `PATCH /cart/items/:itemId` — update quantity. **`quantity: 0` removes the item** (same effect as DELETE) — one code path handles both reduce and remove, matching standard shopping-app UX (quantity stepper down to 0 = removed).
- `DELETE /cart/items/:itemId` — remove one item.
- `DELETE /cart` — clear entire cart.

**Auto-cart-creation:** A user's `Cart` row doesn't need to be created at registration — create it lazily on first `POST /cart/items` if it doesn't exist (`upsert` pattern), avoids an empty-cart row for every user who never shops.

## 2. Checkout

This is the highest-risk part of the module — real money, real stock, must be atomic.

**Endpoint:** `POST /checkout`

**Behavior (single Prisma `$transaction`, all-or-nothing):**
1. Re-fetch the cart fresh from DB (never trust client-supplied prices/quantities — the whole point of the earlier snapshot design).
2. For every `CartItem`, re-validate: product still approved+active+vendor verified, `variant.stockQuantity >= quantity`. If ANY item fails validation, abort the whole checkout with a clear error identifying which item(s) failed — don't partially checkout.
3. Group cart items by `vendorId` (via `product.vendorId`).
4. Create one `OrderGroup` (userId).
5. For each vendor group: create one `Order` (status: PENDING, subtotal = sum of that vendor's line items) + `OrderItem` rows with `titleSnapshot`/`priceSnapshot` captured NOW (current product title, current `variant.priceOverride ?? product.basePrice`) — this snapshot is what protects historical order accuracy per the addendum spec.
6. Decrement `variant.stockQuantity` for each item, within the same transaction (atomicity is the whole reason stock isn't decremented earlier).
7. Clear the cart (delete all `CartItem` rows) — only on successful transaction commit.
8. Call Paymob to create a payment intent for the total across all sub-orders (see Section 3), store `paymobIntentId` on the `OrderGroup`.
9. Return the `OrderGroup` with nested `Order`s and a Paymob redirect/iframe URL (whatever Paymob's flow requires — check their API docs for the exact integration pattern, likely "unified checkout" or iframe embed).

**Failure handling:** If Paymob intent creation fails AFTER the DB transaction committed (step 8, outside step 1-7's transaction boundary since it's an external HTTP call), the `OrderGroup`/`Order`s still exist in PENDING with no `paymobIntentId`. Don't roll back stock in this case — expose a "retry payment" endpoint (`POST /checkout/:orderGroupId/retry-payment`) that re-attempts Paymob intent creation for an existing PENDING order group, rather than trying to make the DB write and the external API call transactional together (not possible, and don't fake it).

## 3. Paymob Integration

**Payment intent creation** (called from checkout step 8):
- POST to Paymob's intention/payment endpoint with amount (sum of all sub-order subtotals, in the smallest currency unit per Paymob's requirement — confirm cents vs EGP piastres formatting), currency (EGP), and a reference tying back to our `OrderGroup.id`.
- Store the returned intent/payment key and any redirect URL needed for the client.

**Webhook handler:** `POST /webhooks/paymob` (public endpoint, no JWT — authenticated via HMAC signature instead)
- Verify the HMAC signature using `PAYMOB_HMAC_SECRET` against Paymob's documented signature scheme BEFORE processing anything — reject with 401 if invalid. This is the standard pattern for all payment webhooks (Stripe, Paymob, etc.) — never trust an unauthenticated POST claiming "payment succeeded."
- On verified success event: look up the `OrderGroup` by the reference passed back, set all its `Order`s from PENDING → PAID.
- On verified failure event: leave orders PENDING (don't auto-cancel — let the shopper retry payment) or move to a distinct state if Paymob distinguishes "failed" from "abandoned" — check their webhook payload docs, this needs their actual event taxonomy which we don't have without sandbox access. Flag as needing confirmation once credentials exist.
- Idempotency: Paymob (like most payment providers) may retry webhook delivery — handle receiving the same success event twice without double-processing (check current status before transitioning; if already PAID, no-op and return 200).

## 4. Order Status Lifecycle & Management

Matches the addendum spec:
```
PENDING → PAID → FULFILLED → SHIPPED → DELIVERED
              ↘ CANCELLED (from PENDING or PAID only)
```

**Shopper endpoints:**
- `GET /orders` — own orders (across all `OrderGroup`s), paginated, filterable by status.
- `GET /orders/:id` — single order detail with items.
- `POST /orders/:id/cancel` — Shopper-initiated cancel, only allowed if status is PENDING (before payment). Cancelling a PAID order requires the refund flow, which is explicitly out of scope for this pass (per the addendum's Section 7 open items) — reject with a clear message pointing to support/manual handling for now, don't silently fail or pretend to process it.

**Vendor endpoints:**
- `GET /vendors/me/orders` — orders belonging to the calling vendor (their own `Order` rows across all OrderGroups/customers), paginated, filterable by status.
- `GET /vendors/me/orders/:id` — single order detail (404 if not this vendor's order).
- `PATCH /vendors/me/orders/:id/status` — vendor transitions status forward: PAID→FULFILLED, FULFILLED→SHIPPED. Reject any transition that isn't the exact next forward step (no skipping, no going backward) — validate against the lifecycle strictly.

**Delivery confirmation** — **Confirmed: Shopper confirms delivery** (`POST /orders/:id/confirm-delivery`, only valid from SHIPPED status).

## 5. What's Explicitly Out of Scope

- Refunds/cancellation-after-payment (needs its own Payments-module-adjacent spec)
- Stock reservation at cart-add (deferred per checkout-time-decrement decision above)
- Shipping/tracking number fields (not in current schema — small addition if wanted later)
- Live Paymob end-to-end testing (blocked on credentials, build-and-unit-test only for now)

## 6. Open Items For Discussion

1. Paymob amount formatting (piastres vs EGP) and exact webhook event names need confirmation once you have API docs/sandbox access — the agent should build against Paymob's public documentation as a best guess, but flag clearly that this needs a real sandbox pass before production use.
