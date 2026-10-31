# Pricing Module Spec — Pass 1 (Riven markup on vendor rates, location-based delivery fees)

**Status:** Draft for review — **not implemented**. **v7 (2026-10-27, reported by Youssef):** FD-02 **approved by Ibrahim** with the condition that the percentage is a variable that will become dynamic (FD-28, pending); FD-21 **approved** (cart `UNCHANGED → CHANGED → REVIEWED`, detail `commerce/20`); FD-29 **approved** (flat delivery fee 80.00 EGP per order, temporary). Still pending: FD-17 (meaning of existing prices), FD-04 / BD-30 (zones, the later model), FD-20, FD-23, FD-28, BD-26, TD-14, TD-15 (`specs/commerce/08-decision-register.md`).
**Builds on:** `specs/fashion-marketplace-addendum.md` (product `basePrice`, variant `priceOverride`), `specs/vendor-module-spec.md` (product and variant routes), `specs/payments-module-spec2.md` §2 (checkout). None is modified.
**Architecture:** `specs/commerce/02` §3.2 (models), `commerce/03` §15 (price changes), `commerce/04` §3 and §7.5 (arithmetic, postings), `commerce/05` W26, W32, W33, `commerce/06` §5.3.1–5.3.2 (migration), `commerce/07` §10.
**Written against:** `apps/api/prisma/schema.prisma` @ `76921ed` + working tree, 2026-10-25. **Module:** `apps/api/src/modules/pricing/` (new; leaf module like `audit/`, imported by products, checkout and search).

---

## 1. Scope

| In | Out |
|---|---|
| Riven profit percentage (configuration, validation, history) | discounts, coupons, promotions |
| Unit price calculation (vendor rate → Riven profit → customer price) | per-vendor or per-category percentages (one global percentage in the MVP) |
| Materialized customer price on variants; re-pricing; search documents | multi-currency (FD-15, deferred) |
| Delivery zones, area mapping, zone rates; fee quote at checkout | courier rate cards and courier cost (fulfilment / FD-10) |

## 2. The profit percentage

- **Source:** environment variable `RIVEN_PROFIT_PERCENTAGE` (e.g. `6`). It is **required** — no default in code — so a missing value stops the API at boot instead of pricing silently with a remembered number. `.env.example` lists `RIVEN_PROFIT_PERCENTAGE=6`; `check:env` keeps it listed.
- **Validation (Zod, `infra/config/env.validation.ts`, FD-20):** a decimal string with at most 2 decimal places, `0 ≤ value ≤ 50`. Invalid (`-1`, `101`, `abc`, `6.123`) → the API refuses to start.
- **Representation:** converted once, **exactly**, to integer basis points by string arithmetic (no floating point): `"6"` → 600, `"6.5"` → 650, `"6.25"` → 625. All business code receives `markupBps`; nothing reads the env var except the config module. A grep test fails on a literal `6`, `0.06` or `600` used as a percentage in business code.
- **Who can change it:** *for now* nobody through the API — it changes by configuration + deploy (FD-23: a business decision with an effective date — the deploy time). **FD-02 is approved on the condition that the markup becomes dynamic**; FD-28 (pending) defines the dynamic source (e.g. an audited admin setting with an effective date). The design keeps the percentage behind one pricing-configuration source with a version id (TD-15), so replacing the env var by a dynamic source changes no calculation, snapshot or statement. Vendors can change their **vendor rate** only, never the markup.
- **History (TD-15):** at boot the pricing module compares the configured bps with the latest `pricing_config_versions` row; if different it inserts a new row (`percentText`, `markupBps`, `effectiveFrom = now()`, `deployId`, `recordedBy = 'boot'`) and an audit row `PRICING_CONFIG_CHANGED` (actor SYSTEM), in one transaction. Several instances booting together are safe: insert guarded by `pg_advisory_xact_lock` on a fixed key, then re-check.

## 3. Unit price calculation

One pure function, the only place the formula exists:

```
priceUnit(vendorRateMinor: int, markupBps: int) →
  rivenProfitMinor       = floor((vendorRateMinor × markupBps + 5 000) / 10 000)   // round half up, integer arithmetic
  customerUnitPriceMinor = vendorRateMinor + rivenProfitMinor
```

| Vendor rate | % | Riven profit | Customer price |
|---:|---:|---:|---:|
| 500.00 | 6 | 30.00 | 530.00 |
| 400.00 | 6 | 24.00 | 424.00 |
| 333.33 | 6 | 20.00 (1,999.98 → 2,000 piastres) | 353.33 |
| 99.99 | 6 | 6.00 | 105.99 |
| 0.01 | 6 | 0.00 | 0.01 |
| 500.00 | 6.5 | 32.50 | 532.50 |
| 500.00 | 0 | 0.00 | 500.00 |

Rules: per **unit**, then × quantity (no per-line re-rounding); the precision comes from `currencies.minorUnits` (EGP = 2); amounts are integers end to end; `vendorRateMinor > 0`. The delivery fee is **never** passed through this function (FD-02).

## 4. Prices on products and variants

### 4.1 What the vendor sets
Under FD-17 (a) (recommended), the existing fields become the vendor rate: `Product.basePrice` = default vendor rate, `ProductVariant.priceOverride` = variant vendor rate. Vendor routes (`/vendors/me/products…`, existing) keep these field names and gain explicit read-only fields: `vendorRate`, `markupPercent`, `rivenProfit`, `customerPrice` (BD-26: vendors see their rate and the customer price; the percentage is shown as information).

### 4.2 Materialization (TD-14, W26)
When a vendor creates or changes a rate, the same transaction computes and stores on the variant `vendorRateMinor`, `markupBps`, `customerPriceMinor`, `pricingConfigVersionId`, `pricedAt`, writes the audit row (`VENDOR_RATE_CHANGED`) and, after commit, enqueues the search sync (existing `SearchIndexQueue`). Product-level `basePrice` for display is converted by the same function on read.

### 4.3 What shoppers see (conflict C20)
The mobile app reads `basePrice` / `priceOverride` from public product responses and from search (`products/product-visibility.ts:25,36`, `products.service.ts:119-139`, `Riven-App/src/utils/money.ts`). To keep the app correct without a release, **shopper and public routes return customer prices in those same fields**, plus additive `customerPrice` fields; search documents index `basePrice`/`minPrice`/`maxPrice` as customer prices. Vendor and admin routes return the vendor rate in those fields and the customer price separately. The two meanings of one field name per audience are documented in the OpenAPI schemas (TD-11). Shoppers never see the vendor rate / profit split.

### 4.4 Percentage change (W33)
After a boot that recorded a new version, the module runs the **re-pricing command** in-process (batches of 500 variants, each a guarded update `WHERE markup_bps IS DISTINCT FROM $new`, idempotent, resumable), then enqueues a full search re-index. The same command is exposed as `POST /admin/pricing/reprice` (PLATFORM_OPERATOR, audited) for re-runs. This is not a background worker (TD-13): it runs at boot and on demand.

While re-pricing is in progress, the catalogue may briefly show the old customer price. Checkout always prices from the **current** vendor rate and the **current** bps (§5), so the shopper is never charged a stale price; if the shown total differs, checkout answers 409 `PRICE_CHANGED` (FD-21).

## 5. Pricing at checkout (snapshot)

*v7:* cart price-change acknowledgment (per item and price version), checkout refusal of unreviewed changes, the `FOR SHARE` read of variant pricing inside the order transaction and the full snapshot field list are specified in `commerce/20-cart-price-changes-and-order-snapshot.md`, which governs where it is more detailed than this section.

Inside the checkout transaction (`payments-module-spec2.md` §2), per order item: read the variant's current vendor rate, compute with the current bps, and **snapshot** `vendorRateMinor`, `markupBps`, `rivenProfitMinor`, `customerUnitPriceMinor`, `pricingConfigVersionId` (`commerce/02` §3.2). A trigger forbids updates of these columns afterwards. Group totals: `itemsTotalMinor`, `vendorTotalMinor`, `rivenProfitTotalMinor` (CHECK `vendor + profit = items`).

Effect of changes (`commerce/03` §15): carts hold no prices (live); placed and confirmed orders are never repriced; statements, settlements, refunds and returns use the snapshot only (acceptance criterion 33).

## 6. Delivery zones and fees (FD-04, BD-30)

**v7 — temporary flat fee (FD-29, approved by Ibrahim as reported by Youssef 2026-10-27):** 80.00 EGP per order, separate from the markup and never marked up. It is configured through this same model as **one national zone** mapped to every governorate with **one approved rate of 80.00** (entered by DELIVERY_PRICING, approved per `commerce/07`), so there is no parallel fee mechanism and orders snapshot `deliveryZoneRateId` exactly as below. Moving to real zones later (FD-04 / BD-30) is a data change. How the 80.00 is booked (Riven revenue or courier pass-through) is still FD-18.

### 6.1 Model (`commerce/02` §3.2)
- `DeliveryZone` (code, name, active).
- `DeliveryZoneArea` maps a **governorate** (ISO 3166-2:EG code, fixed list of 27 in code) and optionally a **city** to a zone. Resolution: an ACTIVE mapping for `(governorate, city)` wins over the governorate-wide mapping `(governorate, NULL)`. Mapping changes are maker-checker: a PENDING row becomes ACTIVE on approval, retiring the previous ACTIVE row in the same transaction (partial unique: one ACTIVE row per `(governorate, city)`).
- `DeliveryZoneRate` (append-only): `feeMinor`, `effectiveFrom`, maker, checker. The rate in force = the latest **approved** row with `effectiveFrom ≤ now()`. `effectiveFrom` cannot be in the past at approval (no back-dating).

### 6.2 At checkout
Address → mapping → zone → rate in force, read inside the checkout transaction; `deliveryFeeMinor`, `deliveryZoneId`, `deliveryZoneRateId` frozen on the group. No mapping, inactive zone or no approved rate → 400 `DELIVERY_AREA_NOT_SERVED`. A rate change after checkout never affects the order (criterion 35). The fee is charged once per order group (Riven ships one parcel per group, BD-09), not per vendor.

### 6.3 Accounting
Booked once at delivery: `DELIVERY_FEE_REVENUE` under FD-18 (a), or `COURIER_PAYABLE` under FD-18 (b) (`commerce/04` §7.5). Never part of the vendor payable or of Riven's product margin.

## 7. Endpoints

| Method & path | Who | Notes |
|---|---|---|
| `GET /pricing/governorates` | public | governorate codes and names (Arabic/English) with `served: boolean` — for the app's address picker (TQ-18) |
| `GET /checkout/options?governorate=&city=` | SHOPPER | quote (defined in `payments-module-spec2.md` §2) |
| `GET /admin/pricing/config` | PLATFORM_OPERATOR, FINANCE | current percentage, bps, version history |
| `POST /admin/pricing/reprice` | PLATFORM_OPERATOR | re-pricing command (§4.4); audited |
| `GET /admin/delivery-zones` · `GET /:id` | DELIVERY_PRICING, FINANCE, OPS | zones with mappings and rate history |
| `POST /admin/delivery-zones` · `PATCH /:id` `{ name?, isActive? }` | DELIVERY_PRICING | no approval needed: a new zone serves nothing until a mapping and a rate are approved; deactivating a zone makes its areas unserved for new checkouts only |
| `POST /admin/delivery-zones/:id/areas` `{ governorate, city? }` | DELIVERY_PRICING (M) | PENDING mapping |
| `PATCH /admin/delivery-zone-areas/:id/approve` · `/reject` | FINANCE_APPROVER (≠ maker) | activates / discards |
| `POST /admin/delivery-zones/:id/rates` `{ feeMinor, effectiveFrom }` | DELIVERY_PRICING (M) | PENDING rate |
| `PATCH /admin/delivery-zone-rates/:id/approve` · `/reject` | FINANCE_APPROVER (≠ maker) | |

## 8. Errors

`PRICING_CONFIG_INVALID` (boot), `VENDOR_RATE_INVALID`, `VARIANT_NOT_PRICED`, `PRICE_CHANGED`, `DELIVERY_AREA_NOT_SERVED`, `DELIVERY_GOVERNORATE_INVALID`, `DELIVERY_AREA_MAPPING_EXISTS`, `DELIVERY_RATE_BACKDATED`, `DELIVERY_CONFIG_STATE_CONFLICT`, `MAKER_CANNOT_APPROVE`, `REPRICE_IN_PROGRESS`.

## 9. Audit (TD-03: in the same transaction)

`PRICING_CONFIG_CHANGED` (SYSTEM), `PRICING_REPRICE_RUN`, `VENDOR_RATE_CHANGED` (actor vendor user; before/after rate and customer price), `DELIVERY_ZONE_CREATED|UPDATED`, `DELIVERY_AREA_MAPPING_PROPOSED|APPROVED|REJECTED`, `DELIVERY_RATE_PROPOSED|APPROVED|REJECTED`. Targets: `PRICING_CONFIG`, `PRODUCT_VARIANT`, `DELIVERY_ZONE`, `DELIVERY_ZONE_AREA`, `DELIVERY_ZONE_RATE`.

## 10. Tests

Unit: `priceUnit` table (§3) including rounding edges; bps parsing; env validation (valid and invalid values stop/allow boot); zone resolution (city override, governorate fallback, unserved, inactive zone, rate in force at a timestamp). Grep test: no hard-coded percentage. Concurrency: C-PR1 (vendor rate change during checkout → either old snapshot or `PRICE_CHANGED`, never a mix), C-PR2 (percentage change between two checkouts → each order keeps its own bps), C-DZ1 (rate approved during checkout → order references exactly one rate row) (`commerce/05`). E2E: catalogue → checkout options → checkout → order snapshot → delivered journal (`commerce/04` §7.5 numbers). Contract: the app-facing `basePrice`/`priceOverride` carry customer prices on public routes. Acceptance criteria 32–35 (`commerce/10` §2a).

## 11. Open items

FD-02, FD-04, FD-17, FD-18, FD-20, FD-21, FD-23, BD-26, BD-30, TD-11, TD-14, TD-15; questions TQ-17, TQ-18, TQ-19.

## 12. Pricing and migration readiness checklist (added 2026-10-25)

Nothing in this checklist changes a price or runs a migration; it lists what must be true before Phase 3a ships. Example kept as the reference: vendor rate **500 EGP**, markup **6 % = 30 EGP**, customer product price **530 EGP**, delivery fee **separate** (zone rate, never marked up).

| # | Item | Status / owner |
|---|---|---|
| 1 | FD-02 approved: vendor rate is the vendor's intended payable rate; customer price = vendor rate + approved markup; markup never applied to delivery fees | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef); dynamic markup source FD-28 pending |
| 2 | Percentage configured server-side only (`RIVEN_PROFIT_PERCENTAGE`, validated at boot, no API to change it, history in `pricing_config_versions`) — FD-23 approval and effective date for any change | design §2; FD-23 PENDING IBRAHIM; TD-15 PENDING YOUSSEF |
| 3 | FD-17 decided (existing prices = vendor rate / back-computed / re-confirmed) | PENDING IBRAHIM |
| 4 | **Vendor price reconfirmation** (needed under FD-17 c, recommended as a notice under a): each vendor receives the list of its variants with the rate Riven will treat as its vendor rate and the resulting customer price; the vendor confirms or edits each rate in the portal before go-live; unconfirmed variants stay unpriced and **not purchasable** (§4, `VARIANT_NOT_PRICED`); every confirmation is audited (`VENDOR_RATE_CHANGED` / `VENDOR_RATE_CONFIRMED`) | process design; Ibrahim (communication) |
| 5 | Rounding rule FD-20 approved (bps, per-unit round-half-up, line = unit × quantity) with the edge cases of §3 in tests | PENDING IBRAHIM + YOUSSEF |
| 6 | Cart behaviour: immediate price update with per-item `UNCHANGED → CHANGED → REVIEWED` acknowledgment; checkout reprices inside the transaction and refuses unreviewed changes with `PRICE_CHANGED` (`commerce/20`) | **APPROVED** 2026-10-27 (FD-21) |
| 7 | Snapshots: every order item stores vendor rate, bps, profit and customer price; group stores delivery fee + zone rate id; triggers forbid updates | design; criteria 33, 35 |
| 8 | Percentage change procedure: deploy → history row → re-pricing in batches → search re-index; existing orders untouched (C-PR2) | design §4.4 |
| 9 | Search re-indexing after any price change (vendor rate change enqueues; percentage change triggers full re-index); search shows customer prices (TQ-19) | design §4.2–4.4 |
| 10 | Delivery fee: flat 80.00 EGP per order as one national zone (FD-29) — **APPROVED** 2026-10-27; later zones: granularity (BD-30), zone list and fees (TQ-17), governorate picker in the app (TQ-18); rate history append-only, mapping changes maker-checked | flat fee APPROVED; zones PENDING IBRAHIM / courier data |
| 11 | FD-17 migration rehearsed on the snapshot (`commerce/06` §5.3.1), including the job report of any ±0.01 differences | Phase 3a exit (`commerce/10` §5) |
