# 05 — Race Condition Matrix, Lock Order per Workflow, Concurrency Test Suite

> Status: **DRAFT for review** · 2026-10-24. Lock levels L1–L7 and `withRetryableTx` are defined in `01-target-architecture.md` §4–5.
>
> **Rule for this document:** a race is "handled" only when a test in §6 reproduces it against real PostgreSQL (`riven_test`) and asserts the end state. Code reading (§3) is a hypothesis, not proof.

## 1. Error vocabulary used below

| Response | When |
|---|---|
| 200 (idempotent) | request repeats an already-applied transition with the same intent; nothing written |
| 409 `*_STATE_CONFLICT` / specific code | lost a business race (row no longer in the expected state) |
| 409 `REQUEST_IN_PROGRESS` | same idempotency key still executing |
| 422 `IDEMPOTENCY_KEY_REUSED` | same key, different payload |
| 503 `TRY_AGAIN` + `Retry-After` | lock timeout / retries exhausted on contention |
| 400 `CHECKOUT_ITEM_UNAVAILABLE` | not enough available stock (existing code, unchanged) |

## 2. Lock order per workflow

"Seq" is the exact acquisition order. Every workflow runs inside `withRetryableTx` with `lock_timeout = 5s`.

| # | Workflow | L1 group lock | Seq | Nested calls (their level) | On exhausted retry |
|---|---|---|---|---|---|
| W1 | Checkout (create) | no (new group) | idempotency claim (own tx) → L1 cart row `FOR UPDATE` ¹ → L6 balances sorted → L7 inserts (group, orders, reservations, movements, outbox, key COMPLETED) | `inventoryService.reserveInTx` (L6) | 503 |
| W2 | Payment initiation / retry-payment | yes | L1 → L3 attempt insert (CREATED) → commit → *Paymob call* → new tx: L1 → L3 guarded CREATED→INITIATED | — | 503 / 409 `PAYMENT_ATTEMPT_OPEN` |
| W3 | Paymob webhook | yes | L7 provider event insert (dedup) → L1 → L2 orders → L3 tx → L6 (reservations confirm: no counter change) → L7 ledger, audit, outbox | `inventoryService.confirmInTx` (L6 rows, no-op counters), `ledgerService.postInTx` (L7) | 503 → Paymob retries; inbox dedups |
| W4 | Shopper cancel | yes | L1 → L2 → L3 (cancel open attempt/proof) → L6 release sorted → L7 | `inventoryService.releaseInTx` | 409 `ORDER_STATE_CHANGED` |
| W5 | Admin cancel | yes | same as W4 (+ refund insert L4 if prepaid) | + `refundsService.requestInTx` (L4) | 409 |
| W6 | Expiry worker | yes, `SKIP LOCKED` | L1 (skip locked) → L3 check live attempt → L2 → L6 → L7 | as W4 | job retries next tick |
| W7 | Paymob reconciliation worker | yes, `SKIP LOCKED` | *inquiry call outside tx* → L1 → as W3 | as W3 | next tick |
| W8 | Proof upload URL | no | none (no DB write except an upload intent row L7) | — | — |
| W9 | Proof submit | yes | L1 → L3 tx (insert/lock) → L3 claim insert → L3 proof insert → L6 (extend: no counter change) → L7 | — | 409 / 503 |
| W10 | Proof claim-for-review | yes | L1 → L3 proof guarded | — | 409 `PROOF_ALREADY_CLAIMED` |
| W11 | Proof approve | yes | L1 → L2 → L3 proof, tx, claim → L6 (confirm, or re-reserve sorted) → L7 ledger/audit/outbox | inventory (L6), ledger (L7) | 409 `PROOF_ALREADY_REVIEWED` |
| W12 | Proof reject | yes | L1 → L2 (if cancelling) → L3 → L6 release (fraud / exhausted) → L7 | inventory (L6) | 409 |
| W13 | Reference dispute / release | yes (holding group) | L1 → L3 claim → L7 event | — | 409 |
| W14 | Vendor stock adjustment | no | L6 single guarded update → L7 movement | — | 409 `ADJUSTMENT_BELOW_RESERVED` / 503 |
| W15 | Intake verify | no | intake row `FOR UPDATE` (L5-equivalent, no group) → L6 sorted → L7 | — | 409 |
| W16 | Stocktake / admin adjustment approve | no | adjustment row guarded → L6 → L7 | — | 409 |
| W17 | COD confirmation call | yes | L1 → L2 → L3 → L6 confirm → L7 | — | 409 |
| W18 | Shipment transition (prepare, ready, out, fail, refuse) | no (yes for REFUSED: group cancel) | L4 shipment guarded → (REFUSED: L1 must be taken **first**: L1 → L2 → L4) → L7 | — | 409 `SHIPMENT_STATE_CONFLICT` |
| W19 | Shipment handover | no | L4 shipment guarded → L6 fulfil sorted → L7 movements, collection insert | inventory (L6) | 409 |
| W20 | Return received / inspection | no | L4 return guarded → L6 sorted → L7 | inventory (L6) | 409 |
| W21 | COD collection recorded | no | L4 collection guarded → L3 tx guarded ² → L7 ledger | ledger (L7) | 409 |
| W22 | Remittance allocation | no | L5 remittance `FOR UPDATE` → L5 collections sorted `FOR UPDATE` → L7 allocations, ledger | ledger (L7) | 409 `ALLOCATION_EXCEEDS_*` |
| W23 | Settlement create / approve | no | L5 settlement `FOR UPDATE` → L7 lines insert (partial unique on entry) | — | 409 `PAYABLE_ALREADY_ALLOCATED` |
| W24 | Payout send / confirm / fail | no | L5 settlement → L5 payout guarded → L7 ledger | ledger (L7) | 409 `PAYOUT_STATE_CONFLICT` |
| W25 | Refund process / complete | yes for initiation (W5); no for processing | L4 refund guarded → *provider call outside tx with idempotency key* → new tx L4 guarded → L3 tx `refundedMinor` (guarded CHECK) → L7 | ledger | 409 |

¹ The cart row (`carts`, one per user) is locked `FOR UPDATE` and its items re-read inside the transaction — fixes R5 even without an idempotency key. Cart rows belong to one user, so this lock never contends across users.
² W21 touches L4 then L3, which is **upward**. Allowed only because a COD transaction's state is changed by no other workflow once the group is CONFIRMED (W3, W9–W12 never apply to COD; W4/W5 require the group lock *and* refuse once a shipment is past READY_FOR_PICKUP, so they cannot run concurrently with a collection on a handed-over shipment). This exception is listed so it is tested (C-21), not assumed.

### 2.1 Workflows added 2026-10-25 (pricing, intake response, vendor portal, statements, payout confirmation)

| # | Workflow | L1 | Seq | Notes |
|---|---|---|---|---|
| W26 | Vendor changes a vendor rate | no | variant row guarded update (L6-adjacent; same row family as stock, single statement) → L7 audit, re-price, search enqueue | customer price recomputed in the same statement |
| W27 | Statement generation (vendor, period) | no | `INSERT vendor_statements … ON CONFLICT DO NOTHING` (unique vendor+period) → read `VENDOR_PAYABLE:V` entries with `created_at < periodEnd` → insert lines → verify closing = ledger balance | entries posted after `periodEnd` belong to the next period by timestamp, so concurrent postings cannot slip in or out; **Serializable retained** here unless the cut-off-by-timestamp test (C-ST2) passes on Read Committed |
| W28 | Intake vendor response | no | intake row `FOR UPDATE` → guard "no previous response" → insert response (+ dispute) → L7 | — |
| W29 | Intake dispute resolution | no | intake row `FOR UPDATE` → dispute guarded OPEN→RESOLVED → corrections → L6 balances sorted → L7 | maker-checker |
| W30 | Payout receipt confirmation (vendor) | no | payout row `FOR UPDATE` (L5) → guard status ∈ {SENT, CONFIRMED} and no prior confirmation → insert confirmation (+ discrepancy) → L7 | — |
| W31 | Payout discrepancy resolution | no | payout (L5) → discrepancy guarded → L7 journal + audit | maker-checker |
| W32 | Delivery-zone rate change | no | insert new rate row (append-only) | checkout reads the rate in force inside its own transaction |
| W33 | Re-pricing after a percentage change | no | per variant guarded update in batches → search fan-out | idempotent; affects catalogue only, never existing orders |
| W34 | Vendor portal reads | no | plain reads from the primary | no locks; reflects committed data |

### 2.2 Isolation per workflow (TD-01, conditionally approved)

| Isolation | Workflows |
|---|---|
| **Serializable (kept as today) until their concurrency tests pass on Read Committed** | W1 checkout, W4–W6 cancel / expiry (today's code) |
| **Read Committed + locks + guarded updates** (new code, tests written first) | W2, W3, W7, W9–W25, W26, W28–W33 |
| **Serializable retained by design** | W27 statement generation (unless C-ST2 proves the timestamp cut-off on Read Committed); category subtree writes (existing) |
| No transaction needed | W8 upload URL, W34 reads |

A workflow's row moves from the first group to the second only with its C-tests green on Read Committed in CI.

## 3. Existing protections — what must be proven

| Race | Claimed protection (code) | What the test must show | Test |
|---|---|---|---|
| **A** Two shoppers, last unit | Serializable + check-after-decrement + P2034 retry ×3 (`checkout.repository.ts:97-114`, `checkout.service.ts:29-62`) | With today's code: exactly one group, stock 0, loser 400 `CHECKOUT_ITEM_UNAVAILABLE` (or 500 `CHECKOUT_CONTENDED` — R24). With the Phase 0 code (Read Committed + guarded updates): same outcome, no 500, no `40001` surfaced. Scale run: 20 parallel checkouts for 5 units → exactly 5 groups, 5 reserved, 0 negative | C-A |
| **B** Duplicate/concurrent webhooks | `WHERE paymobTransactionId IS NULL` (`checkout.repository.ts:163-171`) | Same event ×10 in parallel → one SUCCEEDED, one journal, one audit; different event types for the same transaction stored once each; late success → exception | C-B |
| **C** Vendor + admin same order status | guarded `updateMany` (`orders.repository.ts:113-120`) | exactly one winner per transition; loser 409 `ORDER_STATE_CHANGED`; vendor cannot reach admin-only transitions (authz) | C-C |
| **D** Shopper + admin + expiry cancel | guarded per-order cancel, restock only for moved rows (`orders.repository.ts:141-154`) | one effective cancel; stock restored exactly once; others 200 no-op (admin, already cancelled) or 409; **no 500** (today: P2034 → 500, R10) | C-D1 |

The first run of C-A…C-D1 happens **against today's code** at the start of Phase 0, so the report records which claimed protections actually hold before anything is changed.

## 4. Race matrix

Format per race: **Initial** · **Concurrent** · **Winner** · **Loser (HTTP)** · **End state** (DB / inventory / finance) · **Audit/events** · **Test**.

### Phase 0 critical races

**E — Double-tap checkout**
- Initial: cart with 2 × variant V (available 5); same user.
- Concurrent: two `POST /checkout` (a) same `Idempotency-Key`; (b) no key; (c) same key, different body.
- Winner: first to claim the key (a) / first to lock the cart row (b).
- Loser: (a) 200 replay of the winner's response, or 409 `REQUEST_IN_PROGRESS` while running; (b) 400 `CART_EMPTY`; (c) 422 `IDEMPOTENCY_KEY_REUSED`.
- End: one group, 2 reserved, available 3, cart empty, one movement pair; one payment attempt; finance: none.
- Audit/events: one `order_group.placed`.
- Test: C-E1, C-E2, C-E3.

**F — Expiry while the shopper is paying on Paymob**
- Initial: group PLACED, attempt INITIATED, `expiresAt` = now − 1 min, `graceUntil` = now + 14 min.
- Concurrent: expiry worker tick; webhook success arrives.
- Winner: webhook (attempt is live → expiry skips the group).
- Loser: expiry: no action.
- End: group CONFIRMED, PAID; reservations CONFIRMED; journal PAYMENT_RECEIVED (Phase 3+).
- Variant F2: webhook arrives after `reservationCapAt` (group already CANCELLED by expiry): attempt SUCCEEDED + `PaymentException(LATE_PAYMENT)` OPEN; group stays CANCELLED; `paymentStatus` REFUND_REQUIRED; journal Dr PAYMOB_CLEARING / Cr CUSTOMER_REFUND_PAYABLE; outbox → FINANCE.
- Test: C-F1, C-F2.

**G — Vendor stock edit during checkout**
- Initial: available 10 (Phase 0: `stockQuantity` 10).
- Concurrent: checkout reserves 2; vendor sends (a) `delta −9`; (b) `setTo 10, expectedStockQuantity 10`.
- Winner/loser: (a) whichever row update runs second sees the first's result: if reservation first → 8, delta −9 → 409 `ADJUSTMENT_BELOW_RESERVED` (Phase 0: `ADJUSTMENT_NEGATIVE`); if delta first → 1, checkout → 400 unavailable. (b) reservation first → CAS mismatch → 409 `STOCK_CHANGED` with current value; CAS first → 10, then reservation → 8.
- End: never phantom stock; invariant `stockQuantity = opening + Σ movements` holds; CHECK never violated.
- Test: C-G1, C-G2.

**H — Cancellation vs Paymob webhook (both orderings)**
- Initial: group PLACED, attempt INITIATED (live).
- H1 cancel first: L1 lock → group CANCELLED (attempt CANCELLED, reservations RELEASED) → webhook then takes L1 → sees CANCELLED → attempt SUCCEEDED + LATE_PAYMENT exception; `paidAt` **NULL**; shopper cancel 200.
- H2 webhook first: group CONFIRMED/PAID → cancel takes L1 → 409 `ORDER_NOT_CANCELLABLE` (not 500).
- Rule while live: shopper cancel is **allowed** (explicit choice; the late-payment path is safe and visible) — confirm in BD-17.
- End: no CANCELLED group with `paidAt` set; no lost payment; legacy fields equal projection.
- Test: C-H1, C-H2 (each forced with a deterministic interleaving: a test hook holds the first transaction open after its L1 lock).

### Brief §8.3 races

**1 — Two admins approve the same proof** · Initial: proof UNDER_REVIEW (reviewer = admin1) · Concurrent: approve by admin1 ×2 (double click) and by admin2 · Winner: first admin1 request · Losers: admin1 repeat → 200 idempotent; admin2 → 403 `NOT_PROOF_REVIEWER` (not the claimer) · End: one APPROVED, tx SUCCEEDED, group CONFIRMED, one journal · Audit: one `PAYMENT_PROOF_APPROVED` · Test C-1.

**2 — One approves, another rejects** · Initial: UNDER_REVIEW · Concurrent: approve (admin1) vs reject (admin1, second tab) · Winner: first to take L1 · Loser: 409 `PROOF_ALREADY_REVIEWED` · End: exactly one terminal state, its side effects only · Audit: one row · Test C-2.

**3 — Shopper submits two proofs simultaneously** · Initial: group PLACED, no open proof · Concurrent: two submissions (different refs) · Winner: first under L1 · Loser: 409 `PROOF_ALREADY_OPEN` (partial unique index as backstop) · End: one SUBMITTED proof, one claim; the loser's reference **not** claimed · Test C-3.

**4 — Two orders claim the same reference** · Initial: groups G1, G2 (different shoppers) · Concurrent: both submit `(INSTAPAY, "AB 12-34")` → normalized `AB1234` · Winner: first `INSERT` on `(channel, normalized_ref)` · Loser: 409 `PAYMENT_REFERENCE_ALREADY_USED` · End: one claim (holder = winner), loser's proof not created · Test C-4.

**5 — Two admins allocate the same payable to different settlements** · Initial: payable entry P unallocated; settlements S1, S2 DRAFT · Concurrent: add P to S1 and S2 · Winner: first insert under partial unique `settlement_lines(ledger_entry_id) WHERE NOT released` · Loser: 409 `PAYABLE_ALREADY_ALLOCATED` · End: P in exactly one settlement; totals consistent · Test C-5.

**6 — Two workers process the same COD remittance** · Initial: remittance RECORDED · Concurrent: two "auto-allocate" jobs · Winner: first `FOR UPDATE` on the remittance; second waits then sees ALLOCATED → no-op · End: allocations once; Σ allocations ≤ reported · Test C-6.

**7 — Two workers allocate the same remittance amount** · Initial: remittance 1,000 unallocated; collections C1 (600), C2 (600) · Concurrent: allocate 600→C1 and 600→C2 · Winner: first under the remittance lock · Loser: 409 `ALLOCATION_EXCEEDS_REMITTANCE` (only 400 left) · End: Σ allocations ≤ received; C2 partially allocated only if explicitly requested · Test C-7.

**8 — Two admins pay the same vendor payout** · Initial: settlement APPROVED, payout PENDING · Concurrent: two "mark sent" · Winner: guarded PENDING→SENT · Loser: 409 `PAYOUT_STATE_CONFLICT` · End: one SENT journal; partial unique blocks a second live payout row · Test C-8.

**9 — Two workers process the same shipment transition** · Initial: shipment OUT_FOR_DELIVERY · Concurrent: DELIVERED ×2 (courier feed + ops) · Winner: guarded update · Loser: 200 idempotent (same target) · End: one DELIVERED journal (idempotent posting key) · Test C-9.

**10 — Cancellation and inventory restoration simultaneously** · Initial: group PLACED, 2 units reserved · Concurrent: shopper cancel + admin cancel + expiry · Winner: first L1 holder · Losers: admin 200 (already cancelled, no audit), shopper 409 or 200 per intent, expiry skip · End: reserved −2 exactly once; one RELEASE movement per item (unique `sourceEventKey`) · Test C-10.

**11 — Two workers process the same refund** · Initial: refund APPROVED · Concurrent: two processors · Winner: guarded APPROVED→PROCESSING · Loser: no-op · End: one provider call (idempotency key = refund id), one attempt row · Test C-11.

**12 — Refund succeeds while another worker retries it** · Initial: refund PROCESSING, provider succeeded, worker crashed before recording · Concurrent: retry worker + late provider callback · Winner: first guarded PROCESSING→COMPLETED · Loser: no-op · End: COMPLETED once, `refundedMinor` += once (CHECK ≤ amount), one journal · Test C-12 (fake provider returns the original result for a repeated idempotency key).

**13 — Return inspection and stock adjustment simultaneously** · Initial: 1 unit quarantined, on_hand 5, reserved 5 · Concurrent: inspection RESTOCK (+1 on_hand) and admin adjustment −1 on_hand · Both: single-row guarded updates on the same balance (L6) serialize · End: on_hand 5, quarantined 0; the adjustment is rejected if it would run first and break `on_hand ≥ reserved` (409), then succeeds on retry · Test C-13.

**14 — Two checkouts reserve overlapping variants in different cart orders** · Initial: V1, V2 each available 1 · Concurrent: cart A [V2, V1], cart B [V1, V2] · Both lock L6 sorted (V1 then V2) → no deadlock · Winner: first to V1 · Loser: 400 unavailable · End: no `40P01` observed (asserted from `pg_stat_database.deadlocks` delta = 0) · Test C-14.

**15 — Webhook arrives while the expiry worker is executing** · = F with the worker holding L1 first: worker sees live attempt → skips (no lock wait thanks to `SKIP LOCKED`, the webhook proceeds). If the attempt is no longer live: worker cancels, webhook → late-payment exception (H1) · Test C-15.

**16 — Vendor adjustment while a reservation is executing** · = G at L6 granularity: both single-row updates; outcome depends on order; invariant always holds · Test C-16.

### Point-10 additions (review of 2026-10-24)

| Id | Scenario | Expected |
|---|---|---|
| C-M1 | Phase 1a backfill running while 50 checkouts/s hit the same variants | after backfill: shadow balances = authoritative values; zero `inventory_discrepancies`; no checkout error other than unavailable |
| C-DL1 | 200 iterations: overlapping checkouts in opposite order + vendor adjustments + expiry + cancel, in parallel | zero `40P01` reaching a client; deadlock counter delta 0; all invariants hold |
| C-FR1 | claim rejected FRAUDULENT, then (a) another group submits it, (b) one admin tries to release | (a) 409 `PAYMENT_REFERENCE_ALREADY_USED`; (b) 403/409 — release needs DISPUTED + approver ≠ maker |
| C-L1 | the same journal source posted by two transactions | one journal; the second returns it |
| C-L2 | an unbalanced journal inserted (test-only SQL) | COMMIT fails with 23514; business change rolled back |
| C-L3 | UPDATE/DELETE on a posted entry | raises; row unchanged |
| C-X1 | Paymob attempt INITIATED, no webhook, inquiry endpoint unreachable | reservation released at `reservationCapAt`; a later success → LATE_PAYMENT exception |
| C-O1 | API instance killed after the business transaction commits and before inline processing *(reworded 2026-10-25 for the lease design, `01` §7)* | event and deliveries durable; the boot sweep of the restarted instance (or the scheduled drain) processes them; consumer effect applied once (`processed_events`) |
| C-O2 | one poison event among 100 | it goes DEAD; the other 99 processed |
| C-S1 | refund worker crashes after the provider call, retries | fake provider sees one logical refund (same idempotency key twice → original result) |
| C-P1 | fault injected inside `projectLegacyPaymentFieldsInTx` | whole transaction rolls back; webhook 500; retry succeeds; legacy-vs-new invariant query returns 0 rows |
| C-MC1 | full scenario suite run as web client and as mobile client | identical responses (ignoring ids/timestamps) and identical end state |
| C-21 | COD collection recorded while an admin tries to cancel the group | cancel 409 (shipment past READY_FOR_PICKUP); collection succeeds; no deadlock |

### Added 2026-10-25

| Id | Scenario | Expected |
|---|---|---|
| C-PR1 | vendor changes a vendor rate while a checkout of that variant runs | the checkout snapshots one consistent price (old or new, never a mix); if the client sent `expectedTotalMinor` for the old price and the new one won → 409 `PRICE_CHANGED`, nothing created |
| C-PR2 | API restarted with a different `RIVEN_PROFIT_PERCENTAGE` while orders exist | existing order items unchanged (snapshot); one new `pricing_config_versions` row; re-pricing command updates catalogue only |
| C-DZ1 | admin adds a new zone rate while checkouts run | each order group references exactly one rate row; fee equals that row; older groups unchanged |
| C-IN1 | vendor acknowledges while INVENTORY verifies the same intake | both succeed in either order (independent rows); inspection columns unchanged; one response row |
| C-IN2 | vendor double-clicks "dispute" | one response, one dispute; second → 409 `INTAKE_ALREADY_RESPONDED` |
| C-IN3 | dispute resolution approved twice in parallel | one correction set, one set of movements |
| C-ST1 | statement generated twice in parallel for the same vendor and period | one statement (unique key); second returns it |
| C-ST2 | a delivery posts for vendor V at the exact moment V's statement is generated | the entry appears in exactly one period (by timestamp); closing balance = ledger balance; no entry missing or duplicated across statements |
| C-PO1 | vendor confirms receipt while FINANCE_APPROVER confirms the payout from the bank | both recorded (separate rows); settlement closes only when both conditions hold |
| C-PO2 | vendor submits RECEIVED_PARTIAL twice | one confirmation, one discrepancy |
| C-PO3 | two admins resolve the same discrepancy | one resolution, at most one journal; loser 409 |
| C-VP1 | vendor A requests vendor B's order, intake, statement, payout, movement or product id | 404 on every route; no data leaked in errors or list filters |
| C-VP2 | order transitions while the vendor polls | every poll returns a state that existed (no partial transition), and the next poll after commit shows the new state and its timestamp |

### Added 2026-10-25 (gap closure)

| Id | Scenario | Expected |
|---|---|---|
| C-O3 | two API instances claim due deliveries at the same moment (500 deliveries, 2 × claim loops) | every delivery claimed by exactly one instance at a time (`SKIP LOCKED`); each consumer effect applied once; no delivery left PROCESSING after both loops finish |
| C-O4 | instance A claims a delivery, pauses (race hook) past its lease; instance B reclaims and completes; A resumes and tries to complete | B's completion succeeds; A's guarded completion updates 0 rows and its transaction rolls back (incl. its `processed_events` insert); effect applied once; `attempts` = 2 |

### Added 2026-10-27 (v7)

| Id | Scenario | Expected |
|---|---|---|
| C-IN4 | two admins approve the same intake line at the same moment | guarded transition: one APPROVED, the other 409 `INTAKE_LINE_ALREADY_DECIDED`; exactly one `INTAKE_ACCEPTED` movement (`sourceEventKey` unique); balance increased once |
| C-PR3 | vendor changes a price while a checkout for that variant runs (checkout reads the variant `FOR SHARE`) | either the order snapshot has the old price and version and the change applies afterwards, or the checkout sees the new version and answers 409 `PRICE_CHANGED`; never a snapshot that mixes versions; payment amount = snapshot total |
| C-RSV1 | proof submission at the deadline ∥ expiry run for the same group (race hook after each L1 lock) | exactly one outcome: proof accepted and reservation kept, **or** 409 `PROOF_WINDOW_CLOSED` and one release — never a proof accepted for a released order |
| C-RSV2 | sweep-before-reserve for a new checkout ∥ a proof being submitted for the overdue group | the sweep re-checks under the group lock and skips a group whose proof was accepted in time; otherwise one release; the new checkout sees a consistent available quantity |
| C-MNT1 | two scheduled maintenance runs overlap, the manual `expire-overdue` command runs at the same time, and a request applies lazy expiry to the same group | `SKIP LOCKED` per group + guarded release, with the manual command on the same code path: each reservation released once, one `RELEASE` movement each, no run waits on another |
| C-MNT2 | worker A processing a group stalls past its BullMQ lock; the job is re-delivered to worker B while A resumes | per-group transactions + `SKIP LOCKED` + guarded release: the group is released by exactly one of them; the other finds nothing eligible; two `MaintenanceRun` rows, totals consistent |
| C-MNT3 | several worker / API instances run the schedule reconciler at the same moment after the scheduler disappeared | all upsert the same fixed scheduler id: exactly one schedule exists afterwards; no tick produces two concurrent executions of the expiry job |
| C-HND1 | withdrawal dispatch recorded twice in parallel | one `RETURN_TO_VENDOR` movement (`withdrawal-line:<id>:dispatch` unique); hold released once |

## 4a. Initial state, operations and expected effects for every test

Every C-test above is specified by its race entry (§3–4: initial state, concurrent operations, winner/loser, end state in DB / inventory / finance) **plus** the invariants of §5, which are asserted after every run. `14-acceptance-test-scenarios.md` §G restates, per test group, the expected **ledger effect** and **inventory effect** explicitly, so a reviewer can check them without reading the prose entries.

## 5. Invariants checked after every concurrency test

1. `product_variants.stock_quantity >= 0`; Phase 1: `on_hand >= reserved + held`, `reserved >= 0`, `held >= 0` for every balance (`held` added in v7); `held` = Σ ACTIVE holds.
2. Phase 0: `stockQuantity = opening + Σ movements` per variant. Phase 1: `reserved = Σ quantity of ACTIVE+CONFIRMED reservations` per balance; `on_hand`, `damaged`, `quarantined` = Σ respective movement deltas.
3. No group `CANCELLED` with `paidAt` set; no group CONFIRMED without a SUCCEEDED attempt (prepaid) or COD confirmation.
4. At most one open payment attempt and one open proof per group.
5. Every journal balanced per currency; trial balance = 0.
6. No payable entry in two live settlements; Σ allocations per remittance ≤ received; `remitted ≤ collected` per collection.
7. Legacy `Order.status` = projection; legacy `paymob*` fields = projection of the latest Paymob attempt.
8. Every mandatory action has exactly one audit row (counted per test).
9. `pg_stat_database.deadlocks` unchanged across the test.
10. Every order item created after Phase 3: `customerUnitPrice = vendorRate + rivenProfit` and `rivenProfit = round_half_up(vendorRate × bps / 10 000)`; every group: `vendorTotal + rivenProfitTotal = itemsTotal`, `itemsTotal + deliveryFee = total`, `deliveryFee` = its referenced rate row.
11. Every ISSUED statement: closing balance = ledger `VENDOR_PAYABLE:V` balance at `periodEnd`; every statement line references a distinct ledger entry; no ledger entry appears in two statements.
12. Every payout with a vendor confirmation: `sent − acknowledged` = the discrepancy amount (or no discrepancy when equal).
13. Outbox: every event has one delivery per registered consumer; after a drain no delivery is PROCESSING with an expired lease; `processed_events` rows ≤ 1 per (consumer, event) and every PROCESSED delivery has one.
14. Inventory custody: no reservation and no `reserved > 0` on a balance at a non-sellable warehouse; Phase 1b: `stockQuantity` = Σ available over sellable warehouses for every variant.
15. Refunds: Σ COMPLETED refunds ≤ payment amount per transaction; every refund with a split has `vendorShare + rivenShare = amount`; no refund exists for a return line without an ACCEPTED inspection.
16. Dispatched stock: every reservation of a shipment that is HANDED_TO_COURIER or later is FULFILLED (never ACTIVE / CONFIRMED / RELEASED afterwards); Σ `SHIPMENT_OUT` for a shipment = its quantities; no unit of a shipment not yet RETURNED_TO_WAREHOUSE and inspected `ACCEPTED_RESTOCK` is counted in `on_hand`.

## 6. Concurrency test suite design

- **Location:** `apps/api/test/concurrency/*.concurrency.spec.ts`, run by a separate Jest project (`pnpm --filter @riven/api test:concurrency`), **never** mocked Prisma.
- **Database guard:** refuses to run unless the database name ends in `_test` (same rule as `scripts/smoke-live.mjs`); creates its own data with unique prefixes; does not `deleteMany` shared tables.
- **True parallelism:** N independent `PrismaClient` instances (connection pool ≥ N) or N HTTP requests to one booted app via `Promise.all`; a start barrier releases all workers at once.
- **Deterministic interleavings** (for H1/H2, F, 13): a test-only hook (`RACE_HOOKS`, compiled out of production builds by an env guard) lets a test pause a transaction after a named point (e.g. "after L1 lock") until released.
- **Repetition:** probabilistic races run ≥ 50 iterations; deterministic ones once per ordering.
- **Assertions:** the per-race expectations of §4 plus the invariants of §5, queried directly with SQL.
- **CI:** runs after the e2e job against the throwaway postgis container; a failure blocks merge. Execution time budget: < 5 min.
- **Evidence:** each phase report includes the raw Jest output of this suite (CLAUDE.md "show real evidence").
