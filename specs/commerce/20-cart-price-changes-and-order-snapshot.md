# 20 — Cart Price Changes and the Immutable Order Price Snapshot

> Status: **DRAFT for review — documentation only, not implemented** · 2026-10-27 (v7, Part 2). Authoritative for cart price-change behaviour and the order pricing snapshot; `pricing-module-spec.md` §5 and `payments-module-spec2.md` §2 point here.
>
> **Decision status (reported by Youssef on 2026-10-27):**
> - **FD-02 — APPROVED by Ibrahim:** markup added on top of the vendor rate (vendor rate + markup = customer price), never deducted from the vendor. **The percentage is a variable** — currently 6 %, configured server-side, and **planned to become dynamic**; what "dynamic" means is **FD-28 (pending Ibrahim)**.
> - **FD-29 — APPROVED by Ibrahim:** temporary **flat delivery fee of 80.00 EGP per order**, recorded separately from the markup and never marked up. The location-based zones (FD-04, BD-30) remain pending as the later model.
> - **FD-21 — APPROVED by Ibrahim:** immediate price update in the cart with a per-item `UNCHANGED → CHANGED → REVIEWED` acknowledgment (the brief calls it "FD-17 Option C"; in the register it is FD-21 — C30). **FD-17 (what existing vendor prices mean at go-live) remains open**; this decision does not settle it.
> - Proposed technical details below (fields, locking, error codes) are **pending Youssef** (TD-14, TD-15, and this document).
>
> Requirements CPR-01 – CPR-10; scenarios AT-CPR-01 – AT-CPR-15; concurrency C-PR3.

## 1. Pricing calculation (unchanged arithmetic, `pricing-module-spec.md` §3)

`markupAmount = vendorBasePrice × markupPercentage` · `customerUnitPrice = vendorBasePrice + markupAmount`, in integer minor units (piastres), percentage held as basis points, per-unit round-half-up (FD-20, pending), no floating point.

| Vendor base price | Markup (6 %) | Customer unit price |
|---:|---:|---:|
| 500.00 | 30.00 | 530.00 |
| 600.00 | 36.00 | 636.00 |

Delivery fee: **80.00 EGP per order** (FD-29), added once per order group, never part of the markup or the vendor payable. Implemented through the existing zone model as a single national zone with one approved 80.00 rate (no parallel mechanism), so the move to real zones later is a data change.

**Dynamic markup (FD-28, pending):** the server reads the markup from a single pricing-configuration source; today that source is the environment variable recorded in `pricing_config_versions` (TD-15). If Ibrahim defines a dynamic markup (runtime admin setting, per category / vendor, effective dates), only the source changes — every calculation, snapshot and test below already takes the percentage as an input with a version id.

## 2. Cart is dynamic; checkout is validated; orders are immutable

| Stage | Price behaviour |
|---|---|
| Cart | always the **current** authoritative price; not guaranteed or locked |
| Checkout | prices recalculated on the server inside the order transaction; unreviewed changes block order creation |
| Order | an immutable snapshot per item and per order, written when the order is **committed** (not at add-to-cart, not at payment success) |
| Payment / retries | always the order snapshot; never recalculated |
| Invoices, statements, settlements, refunds | always the snapshot, never the current product price |

The server is the only source of prices; any price or total sent by the client is ignored (only `expectedTotalMinor` is accepted, as a consistency check, `payments-module-spec2.md` §2).

## 3. Cart-item price-change state (FD-21)

### 3.1 Logical fields (proposal; `CartItem` has no price columns today — no schema change now)
| Field | Meaning |
|---|---|
| `baselineUnitPriceMinor` | the price the customer last acknowledged, or the price when the item was added |
| `baselinePriceVersion` | the price version of that baseline (§3.3) |
| `currentUnitPriceMinor` | the latest authoritative price (computed on read, never trusted from the client) |
| `priceChangeStatus` | `UNCHANGED` · `CHANGED` · `REVIEWED` |
| `priceChangedAt` | when the cart first observed a difference from the baseline |
| `reviewedAt` / `reviewedPriceVersion` | when, and against which version, the customer acknowledged |

### 3.2 State machine
| From | To | When |
|---|---|---|
| — | UNCHANGED | item added; baseline = current price and version |
| UNCHANGED / REVIEWED | CHANGED | on any cart read or checkout, current price ≠ baseline price |
| CHANGED | CHANGED | further changes before acknowledgment: baseline stays the **last acknowledged** price; the latest price is shown |
| CHANGED | REVIEWED | the customer acknowledges **the latest price version** (`POST /cart/items/:id/acknowledge-price { priceVersion }`; a stale version → 409 `PRICE_CHANGED_AGAIN` with the new price) → baseline := acknowledged price |
| CHANGED | UNCHANGED / REVIEWED (no notice) | the price returns to the baseline value before acknowledgment (e.g. 500 → 600 → 500): the customer would pay the price already reviewed, so no notice is shown; the intermediate change is kept in the optional history |

The state is evaluated **lazily** on cart read and at checkout — no background fan-out to all carts when a vendor changes a price (consistent with TD-13). Viewing or refreshing the cart is **never** acknowledgment.

### 3.3 Price version
`priceVersion` = the variant's pricing version (incremented on every vendor-rate change, TD-14 materialization) combined with the `pricing_config_versions` id; any change of either produces a new version. Acknowledgment is recorded against that exact version, so a customer cannot acknowledge one price and pay another.

### 3.4 Customer experience
For every changed item: a visible **Price changed** badge, previous and current unit price, increase or decrease, updated subtotal and total from current prices, and an explicit **Acknowledge changes** / **Continue** action (per item or "acknowledge all" listing each item). The notice survives reloads until acknowledged.

### 3.5 Optional history (MVP-light)
`cart_item_price_events(cartItemId, fromMinor, toMinor, priceVersion, observedAt, acknowledgedAt?)` — written only when a cart read or checkout observes a change; useful for support and audit; no event-sourcing system.

## 4. Checkout validation and the snapshot

Inside the checkout transaction (`payments-module-spec2.md` §2, W1):
1. Lock the cart row (existing) and read each variant's pricing with `SELECT … FOR SHARE` in ascending id order (same row family as stock, L6 — the vendor-rate update W26 is a guarded update on the same row and therefore waits for, or is seen by, the checkout; no torn read).
2. Recompute vendor base price, markup amount, customer unit price, quantities, delivery fee (80.00), totals.
3. Every item must be UNCHANGED, or REVIEWED with `reviewedPriceVersion` = the current version. Otherwise: create nothing, reserve nothing, start no payment; update the cart state to CHANGED; respond **409 `PRICE_CHANGED`** with the affected items (previous, current, version) and the new total.
4. If `expectedTotalMinor` is sent and differs from the computed total → 409 `PRICE_CHANGED` (FD-21).
5. Write the order and the snapshot, reserve stock, create the payment attempt with **exactly the snapshot total**, commit.

The amount shown before confirmation = the amount stored on the order = the amount of every payment attempt (Paymob intention, transfer instructions, COD amount).

### 4.1 Snapshot fields
Per order item: `vendorBasePrice` (`vendorRateMinor`), `markupPercentage` (`markupBps`), `markupAmount` (`rivenProfitMinor`), `customerUnitPrice` (`customerUnitPriceMinor`), `quantity`, `currency`, `priceSnapshotAt`, `priceVersion` (variant version + `pricingConfigVersionId`). Per order group: `itemsTotalMinor`, `vendorTotalMinor`, `rivenProfitTotalMinor`, `deliveryFeeMinor` (80.00), `deliveryZoneRateId`, `totalMinor`, `currency`. All frozen by trigger (`order_items_pricing_frozen`, `02` §5). A payment failure never changes the snapshot.

## 5. Failure and attack cases

| Case | Safe behaviour |
|---|---|
| Client sends a manipulated price / total | ignored (DTO whitelist rejects unknown fields; server recomputes); a mismatching `expectedTotalMinor` → 409 |
| Stale cart / cache | the cart is recomputed from the database on read; checkout re-validates regardless |
| Vendor changes the price during checkout | either the checkout committed first (snapshot = old price, the change applies to future carts) or the change committed first (checkout sees the new version → 409 `PRICE_CHANGED`); never a mix (C-PR1, C-PR3) |
| Duplicate checkout requests | `Idempotency-Key` + cart lock (C-E1–E3) |
| Concurrent price updates and order creation | `FOR SHARE` read of the variant rows inside the order transaction (§4) |
| Payment amount ≠ snapshot | payment matched against `totalMinor`; any difference → `AMOUNT_MISMATCH` exception (existing) |
| Price change during a payment retry | retries reuse the order snapshot; the cart is irrelevant once the order exists |
| Repeated changes before acknowledgment | baseline = last acknowledged price; latest price shown (§3.2) |
| Acknowledging an outdated price | stale `priceVersion` → 409 `PRICE_CHANGED_AGAIN` |
| Product becomes unavailable while its price changes | checkout returns 400 `CHECKOUT_ITEM_UNAVAILABLE` (stock) before / alongside price issues; nothing created |

## 6. Requirements (`08` §8)

| ID | Requirement |
|---|---|
| CPR-01 | Cart prices are always current and computed on the server; carts never lock prices |
| CPR-02 | Per-item UNCHANGED / CHANGED / REVIEWED state with the last-acknowledged baseline |
| CPR-03 | Viewing is never acknowledgment; acknowledgment is bound to a price version |
| CPR-04 | Checkout blocks unreviewed changes with 409 `PRICE_CHANGED`; nothing is created or charged |
| CPR-05 | Final price validation and snapshot are atomic with order creation (variant rows read `FOR SHARE`) |
| CPR-06 | Immutable per-item and per-order snapshot written at order commit |
| CPR-07 | Payments and retries always use the snapshot total |
| CPR-08 | Client-provided prices are never trusted |
| CPR-09 | Delivery fee (80.00 EGP, FD-29) is separate from the markup and never marked up |
| CPR-10 | The markup percentage is a configured, versioned input — never hard-coded — so a dynamic source (FD-28) can replace it without changing calculations |
