# 21 — Checkout Inventory Reservation and Payment Expiration (Part Four)

> Status: **DRAFT for review — documentation only, not implemented** · 2026-10-27 (v7, Part Four). Consolidates and refines the reservation and expiry rules spread over `03` §3 and §6, `01` §13, `05` and `payments-module-spec2.md` §3–5; where this document is more specific, it governs.
>
> **Decision status — nothing new is approved here:**
> - **BD-07** (windows) stays **PENDING IBRAHIM**. This document records Youssef's **proposal of 2026-10-27: 30 minutes** to submit an InstaPay / wallet proof (the earlier recommendation was 2 h).
> - **BD-18** (stock while a proof waits) stays **PENDING IBRAHIM**. Proposal: the reservation **stays active while a timely proof awaits review** (the earlier recommendation released it at a 72 h cap).
> - **BD-19** (review SLA), **BD-13** (COD confirmation call and window), **BD-17** (late payment: refund or revive), **BD-06** (proof attempts) — **pending**.
> - **TD-13** approved (no background workers); **TD-18** (scheduled maintenance) **pending Youssef**.
> - FD-21 and FD-29 approved (snapshot rules, `20`).
>
> Requirements RSV-01 – RSV-10, DSP-01 – DSP-03, MNT-01 – MNT-18, PMA-01 – PMA-08; scenarios AT-RSV-01 – AT-RSV-14, AT-DSP-01 – AT-DSP-03, AT-MNT-01 – AT-MNT-23, AT-PMA-01; concurrency C-RSV1, C-RSV2, C-MNT1 – C-MNT3. **TD-18** mechanism: BullMQ + Redis + dedicated worker, **every 10 minutes**, proposed by Youssef 2026-10-27, **pending formal approval** (§8.1); TD-13 amendment **TD-22**, worker architecture **TD-23** and `MaintenanceRun` retention **TD-24** pending (§8.4, §8.5, §8.3.1). Operational reliability review (2026-10-27): §8.2.1, §8.5, §8.6, §8.8 – §8.10; infrastructure and implementation readiness (hosting, alert delivery, code gaps, decision package): `22`; implementation roadmap R0 – R4 with gates: `23`.
>
> **Update 2026-10-27 (clarifications from Youssef):** PAYMOB is **deferred, not rejected** (§5, TD-21); dispatched stock after courier handover is never available (§3.3); scheduled reservation maintenance is **required** (§8; mechanism TD-18 pending).

## 1. No reservation on Add to Cart

Adding to the cart, changing a quantity or opening the cart **never reserves stock**. The cart performs only a soft check against current availability (existing `cart.service.ts:49,79` → 400 `INSUFFICIENT_STOCK`) so the customer is not shown an impossible quantity. Two customers may hold the last unit in their carts at the same time; the first to complete checkout gets it. The checkout transaction is the only enforcement point (`inventory-module-spec.md` §11).

## 2. Atomic reservation at checkout / order creation

Inside the single checkout transaction (W1, `05` §2; `20` §4), in this order:
1. idempotency claim (`Idempotency-Key`, own short transaction) and cart row lock;
2. price validation and **snapshot** (`20` §4) — variant rows read `FOR SHARE`, sorted;
3. **reservation** of every line by a guarded update on the sellable balance, sorted by `(warehouseId, variantId)`: Phase 0 `stockQuantity = stockQuantity − q WHERE stockQuantity ≥ q` + `RESERVE` movement; Phase 1+ `reserved += q WHERE on_hand − reserved − held ≥ q` + `StockReservation` ACTIVE;
4. order group, orders, items, payment attempt (amount = snapshot total), audit, outbox;
5. commit.

**All or nothing:** if any line is short, the whole transaction rolls back — no order, no snapshot, no reservation, no payment attempt — and the client gets 400 `CHECKOUT_ITEM_UNAVAILABLE` naming the line. Isolation: Read Committed with guarded updates (TD-01; the existing Serializable checkout keeps its isolation until C-A passes on Read Committed).

## 3. Reservation lifetime per payment method

Every reservation carries `expiresAt` (current deadline, may be extended by rule) and the group carries `reservationCapAt` (hard limit where one applies). All times are database `now()`.

| Method | From checkout | Extended when | Released when | Never released while |
|---|---|---|---|---|
| **TRANSFER — InstaPay / wallet** | `expiresAt = createdAt + 30 min` (**proposed**, BD-07 pending; configurable `TRANSFER_SUBMIT_WINDOW`) | a proof is submitted **before** `expiresAt` → the reservation stays ACTIVE for as long as the proof is SUBMITTED / UNDER_REVIEW (**proposal**, BD-18 pending); after a NEEDS_CORRECTION rejection a resubmission window applies (`TRANSFER_RESUBMIT_WINDOW`, value pending BD-07) | no proof by `expiresAt`; resubmission window lapsed; proof rejected as fraudulent or attempts exhausted (BD-06); shopper / admin cancel before review starts | a timely proof awaits review |
| **COD** | ACTIVE; **no prepaid payment deadline**; `expiresAt = createdAt + COD_CONFIRM_WINDOW` (24 h proposed, BD-13 pending) only for the confirmation call | confirmation call CONFIRMED → reservation CONFIRMED (no expiry) until handover | confirmation outcome UNREACHABLE / CANCELLED_BY_CUSTOMER, window lapsed without confirmation, admin cancel before handover | confirmed and awaiting shipment |
| **PAYMOB** (disabled in production, TD-13 / R-D2) | `expiresAt = min(initiatedAt + 60 min + 15 min grace, reservationCapAt)`; cap `createdAt + 90 min` (BD-07 pending) | a retry before the cap creates a new attempt but **never moves the cap** | grace passed and no success; cap reached | an attempt is live (`INITIATED`, before `graceUntil`) |

**After payment succeeds** (proof approved, Paymob success) or **after COD confirmation**, the reservation becomes CONFIRMED and has no expiry; it ends as FULFILLED at courier handover, or RELEASED by a cancellation that is still allowed (FD-14).

**Current code vs this table (verified 2026-10-28, `23` §11.1a):** only Paymob exists in code, and every unpaid checkout expires by one generic TTL (`CHECKOUT_PENDING_TTL_MINUTES`, default 60, from `createdAt`). That rule is not method-aware, so it would also expire a future COD group. COD must therefore not be enabled for checkout in any deployed environment until its expiry eligibility is separated from prepaid-payment expiry and AT-RSV-09, AT-RSV-10 and AT-DSP-02 pass (`10` §5 Phase 4 row; `23` §11.1a).

### 3.1 The 30-minute proof deadline (proposal)
- The deadline is shown to the shopper at checkout (`paymentInstructions.submitBefore`) and in the order screen; NE-01 carries it.
- Submission is judged by the **database time at the moment the proof transaction takes the group lock**: `now() ≤ expiresAt` → accepted; otherwise 409 `PROOF_WINDOW_CLOSED`, even if the reservation has not been released yet (a late maintenance run never extends a deadline).
- A proof submitted in time **freezes the deadline**: from then on only the review outcome decides (approve → CONFIRMED; needs correction → resubmission window; fraud / attempts exhausted → release).

### 3.2 Hold while the proof awaits review (proposal, BD-18)
- The reservation stays ACTIVE while the proof is SUBMITTED or UNDER_REVIEW. The review SLA (BD-19, proposed 4 business hours) triggers **escalation**, not release.
- Safety backstop (proposal, BD-18): if a proof is still unreviewed after `TRANSFER_REVIEW_MAX_HOLD` (value pending; e.g. 72 h) the case is escalated to OD-03 and Ibrahim; the stock is **not** released automatically. If Ibrahim prefers the earlier rule (release at the cap and re-reserve on approval, `03` §6.3), only this row changes.

### 3.3 COD (and every method) after courier handover — dispatched stock is never available

At `READY_FOR_PICKUP → HANDED_TO_COURIER` (signed manifest, COU-02; `03` §7), in the same transaction:
- each reservation of the shipment goes `CONFIRMED → FULFILLED`;
- the RIVEN balance changes `on_hand −= q` and `reserved −= q` with a `SHIPMENT_OUT` movement (`sourceEventKey = shipment-out:<shipmentItemId>`, unique);
- the units are now **dispatched — in courier custody** (`inTransit` in the vendor quantity view): they are counted in neither `on_hand` nor `available`, and no reservation for them exists to release.

Consequences (DSP-01 – DSP-03):
- **No release path reaches dispatched units.** Release only applies to `ACTIVE | CONFIRMED` reservations (§4); expiry, the COD confirmation window and shopper / admin cancellation do not apply after handover (cancel → 409, C-21).
- **Refused / failed / undeliverable COD:** the shipment goes `REFUSED | FAILED_ATTEMPT (max) → RETURNING → RETURNED_TO_WAREHOUSE`; on physical receipt the units enter **quarantine** (`RETURN_TO_QUARANTINE` movement) and become available **only** after an authorized inspection with outcome `ACCEPTED_RESTOCK` (same inspection rules as customer returns, `03` §9.3); damaged units go to `damaged`. Nothing returns to `available` automatically or because a status changed at the courier.
- **Lost / damaged in transit:** LOST / DAMAGED_IN_TRANSIT (maker-checker, FD-25); lost units never come back into stock.
- **Courier role:** transportation and custody only. The courier signs the handover manifest (accepting custody), reports delivery, refusal and collected cash; it does **not** inspect products or approve their condition — inspection is Riven's, on return.

## 4. Release after valid expiration or cancellation

A release is one guarded transition per reservation (`ACTIVE|CONFIRMED → RELEASED`), with `reserved −= q` (Phase 1+) or `stockQuantity += q` (Phase 0) and one `RELEASE` movement keyed `release:<reservationId>` (unique) — so a release can never happen twice. In the same transaction: group → CANCELLED with the reason (`EXPIRED_NO_PROOF`, `EXPIRED_NO_PAYMENT`, `COD_UNREACHABLE`, `CANCELLED_BY_SHOPPER`, `CANCELLED_BY_ADMIN`), the payment attempt → EXPIRED / CANCELLED, legacy status projection, audit, outbox (NE-06 / NE-09). The order's **price snapshot is unchanged**.

Guards (checked under the L1 group lock): never release a group with a SUCCEEDED attempt; never release while a timely proof is SUBMITTED / UNDER_REVIEW (proposal §3.2); never release while a Paymob attempt is live.

## 5. PAYMOB — supported, **deferred** (not rejected)

**Status (TD-21, Youssef's instruction of 2026-10-27):** PAYMOB **stays part of Riven** — in the architecture, the payment-method model, the checkout contract and the existing code (`infra/paymob`, one webhook route) — and **will be implemented and activated later**. For the current phases it is **disabled in production** (`PAYMOB_*` unset, R-D2) and its new flows (attempt lifecycle, provider-event inbox processing, reconciliation inquiry, late-success recovery) are **not implemented now**; they move to a separate **PAYMOB activation milestone** (`README.md` roadmap). When to activate is a business decision (**BD-43, pending Ibrahim**). Nothing in this documentation marks PAYMOB as rejected: *deferred* = designed and kept, built later; *rejected* would remove it (no PAYMOB decision is REJECTED).

**Late success (BD-17 — pending Ibrahim, not approved):** the design below shows the **recommended** refund outcome so that no payment can be lost; it is **not** an approved business rule and is not implemented now. The alternative (revive the order by re-reserving at the snapshot price if stock exists) remains open.

### 5.1 Requirements before PAYMOB activation (PMA-01 – PMA-08)

| ID | Must be complete and proven before PAYMOB is enabled in production | Proven by |
|---|---|---|
| PMA-01 | Attempt lifecycle: attempt row committed **before** the provider call; one open attempt per group; `retry-payment` never moves the cap | C-E1 family, `03` §3.1 |
| PMA-02 | Payment expiration: window + grace + hard cap enforced from stored timestamps; reservation released exactly once after expiry | C-X1, AT-RSV-11 |
| PMA-03 | Webhook idempotency: every signed event stored in the provider-event inbox before processing; duplicates are no-ops; amount and currency verified | C-B, AT-FIN-02, AT-FIN-03 |
| PMA-04 | Delayed success callbacks: a success after cancellation, expiry or cap is recorded, never fulfils the cancelled order, opens a `PaymentException` | C-F2, C-H1, C-H2, AT-FIN-04 |
| PMA-05 | The **approved** late-payment behaviour (BD-17: refund or revive) implemented exactly as Ibrahim decides | blocked by BD-17 |
| PMA-06 | Reconciliation when the webhook never arrives: provider inquiry (TQ-01) run by a scheduled executor (R-D4, TD-18) | C-X1 in the target deployment |
| PMA-07 | Refund execution path for PAYMOB money (manual first; provider API refunds FD-12 deferred) with reconciliation against Paymob settlement reports (REC-CHK-02) | AT-RFD family, REC-CHK-02 |
| PMA-08 | Legacy `paymob*` fields as a projection written in the same transaction; existing Paymob tests pass unchanged | C-P1, `06` §4.2 |

Until PMA-01 – PMA-08 are met and BD-43 is approved, PAYMOB is not offered by `GET /checkout/options` in production and the existing unversioned behaviour (`paymentSetupFailed: true` when unconfigured) is unchanged.

### 5.2 Designed late-success behaviour (recommended refund outcome — pending BD-17)
- After `graceUntil` (or the cap) with no success, the reservation is released and the group cancelled (§4).
- A signed success that arrives later is **never lost**: stored in the provider-event inbox; attempt → SUCCEEDED; group **stays CANCELLED** and is never fulfilled; `PaymentException(LATE_PAYMENT)` OPEN; `paymentStatus = REFUND_REQUIRED`; journal Dr PAYMOB_CLEARING / Cr CUSTOMER_REFUND_PAYABLE; FINANCE notified (NE-44); refund through the refund workflow (`15`).
- Whether to revive the order instead (re-reserve at the **snapshot** price if stock exists) is **BD-17 — pending Ibrahim**; refund is a recommendation only.
- BD-17 also matters outside PAYMOB: a customer can transfer money after the 30-minute proof deadline; the proof is refused (`PROOF_WINDOW_CLOSED`) and the money is handled as an unmatched payment through the refund workflow (`15`) until BD-17 says otherwise.

## 6. Concurrency

| Race | Resolution | Test |
|---|---|---|
| Two shoppers, last unit | guarded update; one order, loser 400 | C-A, AT-INV-06 |
| Proof submitted at the deadline ∥ expiry | both take the L1 group lock; the proof transaction checks `now() ≤ expiresAt`; the expiry transaction checks "no proof SUBMITTED"; whichever locks first wins, the other becomes a no-op or 409 `PROOF_WINDOW_CLOSED` — never "proof accepted and stock released" | C-RSV1 |
| Shopper cancel ∥ proof review starts | L1 lock; cancel refused once UNDER_REVIEW (409 `PROOF_UNDER_REVIEW`) | C-2 family |
| Expiry ∥ Paymob webhook | live-attempt guard; late success → exception | C-F1, C-F2, C-H1, C-H2 |
| Sweep-before-reserve ∥ a proof just submitted for that group | the sweep takes each overdue group's L1 lock and re-checks; a group with a SUBMITTED proof is skipped | C-RSV2 |
| Cancel ∥ cancel ∥ expiry | one effective release (`release:<id>` unique) | C-10, C-D1 |
| Price change ∥ checkout | `FOR SHARE` read; consistent snapshot or 409 | C-PR3 |
| Two maintenance runs overlap (slow run + next schedule) ∥ lazy expiry | `FOR UPDATE SKIP LOCKED` per group + guarded release; each reservation released once | C-MNT1 |
| Cancel / expiry ∥ courier handover | handover takes the L1 lock; once FULFILLED, release paths find nothing to release; cancel after handover → 409 | C-21, AT-DSP-02 |

## 7. Idempotency

Checkout: `Idempotency-Key` + cart lock (C-E1 – E3). Proof submission: `Idempotency-Key` (scope `proof-submit`) + one open proof per group (partial unique). Expiry / release: guarded transitions + unique release keys — re-running any expiry path is harmless. Approval after release: re-reservation keyed `re-reserve:<orderItemId>:<approvalId>`.

## 8. Scheduled reservation maintenance and recovery (MNT-01 – MNT-06)

**Requirement (confirmed by Youssef, 2026-10-27):** reservation expiry must be processed by **reliable scheduled maintenance**. Expiring only when someone opens an order is **not sufficient**: an abandoned unpaid order that nobody touches again would hold stock indefinitely. The *mechanism* (host scheduler calling the maintenance command, a worker when TD-13 is revisited, or another executor) is **TD-18 — still pending Youssef**; this document fixes what any mechanism must do. Nothing is implemented here.

| Aspect | Requirement |
|---|---|
| Responsibility (MNT-01) | a scheduled run of the expire-overdue command every **10 minutes** (proposed; configurable; changed from 5 min on 2026-10-27) in production; owner OD-01 (technical, unassigned); lazy expiry and sweep-before-reserve stay as **additional** safety nets, never as the mechanism |
| Database as source of truth (MNT-02) | candidates are selected **only** from stored data: `SELECT … FROM stock_reservations WHERE status = 'ACTIVE' AND expires_at <= now()` (Phase 1+; Phase 0: groups PLACED past their deadline) joined to the group guards of §4 (no live attempt, no timely proof under review, no success) — no in-memory timers, no queue state, no client clock |
| Idempotent release (MNT-03) | each candidate group is processed in its own short transaction under its L1 lock (`FOR UPDATE SKIP LOCKED`, so runs never wait on requests or on each other); guarded `ACTIVE → RELEASED` + unique `release:<reservationId>` movement key; a group released by another path in the meantime is a no-op |
| Missed / delayed runs (MNT-04) | a run processes **everything** overdue, oldest first, in bounded batches (at most 500 groups per batch, looping until none remain or the 4-minute run budget is spent; the next run continues); because deadlines are stored timestamps, a run after downtime releases exactly what is due and never extends a deadline; a run that crashes midway leaves only fully committed or untouched groups and the next run continues |
| Run record (MNT-05) | each run writes a `MaintenanceRun` row (fields in §8.6) and its audit rows (`13` §3.3); a failed group does not stop the run — it is logged and retried next run |
| Monitoring and alerting (MNT-06) | `/health` exposes: last successful run time, number of overdue ACTIVE reservations, oldest overdue age, last run duration, consecutive failures. Alerts (thresholds in §8.6, proposed, TBD with OD-01) → OD-01, escalating to OD-08 |

Missed runs are therefore harmless for correctness (stock is held longer, never released wrongly) and visible within minutes. **Production go-live is blocked until a scheduled executor runs this command and the alerts above are wired (PRG-03, R-D8).**

### 8.1 Selected mechanism — BullMQ + Redis + dedicated worker (TD-18, **proposed by Youssef 2026-10-27, pending formal approval**)

**What already exists (verified read-only):** the API already runs an in-process BullMQ repeatable job — queue `orders`, job `expire-pending-checkouts`, scheduler `expire-pending-checkouts-scheduler` upserted on module init with pattern `*/5 * * * *` (`modules/orders/jobs/orders-jobs.service.ts`, `orders-expiry.processor.ts`), calling `OrdersService.expireStalePendingGroups(ttl)` with `CHECKOUT_PENDING_TTL_MINUTES` (default 60). The proposal **evolves this job** (no second scheduler, no parallel mechanism); the repo's BullMQ setup (`infra/queue`, `@nestjs/bullmq`) is reused. **Proposed interval: every 10 minutes (`*/10 * * * *`)** — a change from today's code (every 5 min) that will be made only when TD-18 is approved and implemented; nothing is changed now.

| Component | Role | Rule |
|---|---|---|
| **BullMQ** | manages the recurring job | one job scheduler with a **fixed id** (`expire-pending-checkouts-scheduler`, upserted, idempotent across restarts and instances) every **10 minutes** (`*/10 * * * *`); job payload is empty — it carries **no** reservation ids or deadlines; ids contain no `:` (CLAUDE.md) |
| **Redis** | queue coordination and job persistence | coordination only; losing Redis loses at most scheduler and job entries, never business state; required production settings in §8.3 (TQ-27) |
| **Reservation expiration worker** (dedicated) | executes the job | a separate long-running process of the same codebase (entry point running only the `orders` queue processor), so HTTP load and deploys of the API do not stall maintenance; **this needs the scoped TD-13 amendment TD-22** (C33, §8.4) — until it is approved, the same processor keeps running in-process in the API as today |
| **PostgreSQL** | source of truth | every decision ("is it overdue? is it still eligible?") is made from persisted rows inside the release transaction (MNT-02) |
| **Prisma** | data access | per-group transactions through the orders / inventory repositories (`…InTx`), lock order of `01` §4 |
| **`MaintenanceRun`** | execution record | one row per job execution, written in PostgreSQL (MNT-05) |
| **Monitoring** | detection | reads `MaintenanceRun` and reservation tables from **PostgreSQL**, so it still works when Redis or the worker is down (MNT-06, MNT-10) |

**Execution flow (per job run):**
1. BullMQ fires the scheduled job (every 10 min).
2. The worker inserts a `MaintenanceRun` row (status RUNNING, `jobId`, `scheduledFor`, `workerInstance`, `backlogAtStart`, `oldestOverdueAtStart`).
3. It selects overdue candidates from PostgreSQL (`expires_at <= now()`, status ACTIVE; Phase 0: PLACED groups past their deadline), oldest first, **in batches of at most 500 groups** (configurable), looping until none remain or the run's time budget (**4 min**, well below the 10-min interval) is spent; anything left is processed by the next run (`catchUp = true` when the run starts with a backlog older than one interval).
4. For each group, a short transaction: `SELECT … FOR UPDATE SKIP LOCKED` on the group (L1) → **re-validates** against current rows (still PLACED; no SUCCEEDED attempt; no timely proof SUBMITTED / UNDER_REVIEW; no live PAYMOB attempt; reservations still `ACTIVE`) → guarded `ACTIVE → RELEASED` with the unique `release:<reservationId>` movement → group CANCELLED with its reason → audit, outbox → commit.
5. Reservations that are `CONFIRMED` or `FULFILLED` (courier handover, `§3.3`) are **never candidates**: the query and the guarded update both require `status = 'ACTIVE'`.
6. The run updates its `MaintenanceRun` row (SUCCEEDED / PARTIAL / FAILED; candidates, released, skipped, failed, batches, duration, last error).
7. A per-group failure is logged on the run and retried next run; it never aborts the whole run.

**Safety properties:**
| Requirement | How it holds |
|---|---|
| Idempotency | release is a guarded update + unique movement key; a repeated job, a retried job or two runs over the same group release at most once |
| Crash recovery | a running job's BullMQ lock is renewed automatically while the worker is alive; if the worker dies, stalled-job detection re-delivers the job (`maxStalledCount` 1) or the next scheduled tick runs; groups committed before the crash stay released (each group is its own transaction), the rest are picked up; the schedule itself is protected by **schedule reconciliation** (§8.2); BullMQ does **not** replay missed ticks — the next run's database query catches up on everything overdue, and deadlines (stored timestamps) are never extended. *(Corrected 2026-10-27: the earlier text said "lock duration ≥ run budget"; BullMQ renews locks, so the lock is not sized to the budget.)* |
| Concurrency | worker concurrency 1 for this queue and a single scheduler; if two workers or overlapping runs do exist, `SKIP LOCKED` per group + guarded updates make them skip each other's rows and never double-release (C-MNT1, C-MNT2) |
| Database authority | the job payload is ignored for eligibility; any value placed in Redis cannot mark a reservation expired (AT-MNT-09) |
| Bounded processing | ≤ 500 groups per batch, one short transaction per group, 4-minute budget per run (below the 10-minute interval, so runs do not overlap in normal operation). *Technical review:* consistent with the lock hierarchy (one L1 lock + L6 rows per transaction, `SKIP LOCKED`, no long transactions). Throughput is **not proven**: at an assumed 20–50 ms per group transaction a run handles roughly 5,000–12,000 groups — to be measured on the rehearsal snapshot (`06` §7) before go-live |
| Inventory protection | only `ACTIVE` reservations of eligible groups are released; dispatched stock and confirmed COD / paid orders are excluded (§3.3, §4) |
| Execution tracking | every run, including failed and partial runs, has a `MaintenanceRun` row |

**Fallbacks (secondary safeguards, not replacements):** sweep-before-reserve and on-access expiry stay as safety nets; the audited command `POST /admin/maintenance/expire-overdue` (PLATFORM_OPERATOR) calls the same service method **directly, without Redis or BullMQ** (MNT-13), so it works during a Redis outage. If the dedicated worker is not yet approved or not running, production go-live is still blocked (R-D8).

**Interval consistency:** scheduler every **10 minutes** (`*/10 * * * *`); alert "no successful run for **25 min**" (two missed intervals + the 4-min budget + margin); alert "reservation overdue by more than **30 min**" (well beyond the normal-conditions estimate below, so it means missed runs or an uncleared backlog); the same values are used everywhere (`01` §13, `13` §3.1 and §5, `08`, `10`, `14`). Two separate values must not be confused with the interval: the existing code's `CHECKOUT_PENDING_TTL_MINUTES` default (60) is today's abandoned-checkout window, and the **30-minute** TRANSFER proof window (proposal, BD-07 pending — unchanged by this update) is a per-reservation deadline stored in the database. With a 10-minute interval a TRANSFER reservation under the proposed 30-minute proof window (BD-07 pending; today's code uses a 60-minute TTL for every unpaid group, `23` §11.1) is normally released about 30–44 minutes after checkout; it can never be released early, and a timely proof is never affected.

**Release delay — an estimate, not a guarantee or SLA (clarified 2026-10-27).** Under **normal operating conditions** (worker running, Redis reachable, database healthy, schedule present, backlog smaller than one run can clear) an overdue reservation is expected to be released **up to roughly 14 minutes** after its deadline: up to one 10-minute interval until the next tick, plus up to the 4-minute run budget. This figure is an **estimate**, not a maximum, a hard guarantee or a customer-facing SLA, and no requirement, test or alert treats it as one. The actual delay **can be longer** during worker downtime or restarts, Redis outages or data loss, database problems (unavailability, lock timeouts, slow transactions), scheduler delays (tick drift, a schedule being recreated by the reconciler) or a backlog larger than one run's budget. In all of these cases the delay only **holds stock longer**: nothing is released early or wrongly, and deadlines (stored timestamps) are never extended. Recovery is the **PostgreSQL-based catch-up**: the first successful run after the service recovers (or the manual command, MNT-13) selects everything overdue from PostgreSQL, oldest first, in bounded batches across as many runs as needed (MNT-04). Longer delays are detected by the 25-minute no-successful-run alert and the 30-minute overdue-reservation alert (§8.6), both unchanged.

**Additional requirements (`08` §8):** MNT-07 (single upserted BullMQ scheduler, empty payload), MNT-08 (stalled-job recovery and scheduler re-registration), MNT-09 (worker concurrency and per-group `SKIP LOCKED`), MNT-10 (monitoring reads PostgreSQL), MNT-11 (schedule reconciliation, §8.2), MNT-12 (Redis production configuration, §8.3), MNT-13 (manual command independent of Redis), MNT-14 (queue retention), MNT-15 (`MaintenanceRun` retention independent of BullMQ, §8.3.1), MNT-16 (queue isolation, §8.5), MNT-17 (worker lifecycle and supervision, §8.8), MNT-18 (throughput validated, §8.9).

### 8.2 Schedule reconciliation — Redis outage, data loss, FLUSHALL (MNT-11)

Re-registering the scheduler only on worker boot is **not sufficient**: the job-scheduler entry can disappear while the worker keeps running (Redis restart without persistence, FLUSHALL, eviction, manual deletion). The design therefore adds a **schedule reconciler** (a lightweight loop inside each reservation-worker process — and, while the job runs in-process, inside each API instance — not a separate worker):

- **Every 60 seconds** (and at boot), it calls BullMQ to read the scheduler `expire-pending-checkouts-scheduler` for the `orders` queue; if it is missing or its pattern differs from `*/10 * * * *`, it calls `upsertJobScheduler` with the **same fixed id**, pattern and empty template.
- **Idempotent and multi-instance safe:** the upsert is keyed by the fixed scheduler id, so any number of instances reconciling at the same moment converge on **one** schedule — never duplicates. No instance generates its own scheduler id.
- **Redis unavailable:** the reconciler (and BullMQ's connection) retries with backoff; nothing is lost in PostgreSQL; when Redis returns, the next reconciliation recreates the schedule automatically — **no manual intervention** for normal recoverable failures.
- Each reconciliation that had to recreate the schedule writes a `MaintenanceRun` row with `command = SCHEDULE_RECONCILE` and raises the informational alert "schedule recreated".

| Scenario | Behaviour | Guarantee |
|---|---|---|
| 1. Redis temporarily unavailable | jobs cannot be scheduled or delivered; reconciler and connection retry; PostgreSQL alert "no successful run for 25 min" fires if the outage lasts | first run after recovery releases everything overdue; no deadline extended |
| 2. Redis loses persisted queue data | scheduler and pending jobs gone | reconciler recreates the scheduler within 60 s of Redis being reachable |
| 3. FLUSHALL / equivalent loss | same as 2 | same as 2 |
| 4. Scheduler disappears while the worker runs | worker idle, process healthy | reconciler (60 s) recreates it; the missing-run alert covers a broken reconciler |
| 5. Application / worker restart | boot-time reconciliation + stalled-job re-delivery | normally at most one interval missed (estimate; longer if the restart itself is slow); catch-up from PostgreSQL |
| 6. Deployment interrupts the worker | the interrupted run's committed groups stay released; job stalled → re-delivered or next tick | no partial group states (one transaction per group) |
| 7. Several instances register the schedule | all upsert the same fixed id | exactly one schedule |

**Limitations (explicit):** missed ticks are **not** replayed — recovery comes from the next run reading PostgreSQL, which is sufficient because eligibility never depends on the tick; while Redis is down **no scheduled run happens at all** — release is delayed (never wrong) and the manual command (MNT-13) is the operator fallback; Redis persistence (§8.3) only reduces recovery work (fewer lost job records) and is **never** the recovery mechanism — PostgreSQL is.

#### 8.2.1 Three kinds of recovery, and eight Redis / worker failure scenarios (reliability review 2026-10-27)

"Recovery" means three different things. They are never treated as equivalent:

| Layer | What is recovered | Mechanism | What it does **not** do |
|---|---|---|---|
| **Recurring schedule** | the job-scheduler entry `expire-pending-checkouts-scheduler` (and its next pending job) in Redis | the schedule reconciler: `upsertJobScheduler` with the fixed id, at boot and every 60 s (§8.2) | it restores **future** ticks only; missed ticks are not replayed; it releases nothing |
| **BullMQ job** | one job (the next delayed tick, an active job, a failed-job record) | BullMQ itself: stalled-job detection re-delivers an active job whose lock expired (`maxStalledCount` 1), **only if Redis still holds it** | a job lost with Redis data is not recovered, and is not needed: no job carries business state (empty payload) |
| **Business operation** | release of every reservation whose stored deadline has passed | the next run that executes (scheduled, re-delivered or the manual command, MNT-13) selects overdue rows **from PostgreSQL**, oldest first, in bounded batches (MNT-02, MNT-04) | it never depends on which jobs or ticks existed; it never releases before `expires_at <= now()` (database clock) and never writes a deadline |

| # | Scenario | Schedule | Jobs | Business state (PostgreSQL) |
|---|---|---|---|---|
| 1 | Redis restarts **without** data loss | scheduler and next delayed job survive | an active job at restart loses its lock → re-delivered once or replaced by the next tick | committed groups stay released; the interrupted group rolled back; next run continues |
| 2 | Redis restarts with **partial** data loss (e.g. an older snapshot) | the scheduler entry may be missing, **or present without its next pending job** | lost jobs are gone; surviving ones run | catch-up on the next run |
| 3 | Redis loses **all** queue data (FLUSHALL, new instance) | missing → recreated by the reconciler within 60 s of Redis being reachable | all lost, including failed-job records (`MaintenanceRun` rows unaffected, §8.3.1) | catch-up on the next run |
| 4 | The recurring schedule disappears while everything runs | reconciler recreates it (≤ 60 s); "schedule recreated" alert | — | next tick runs as normal |
| 5 | Worker offline while reservations expire | intact; the scheduler keeps **one** pending job, so ticks do not pile up into many jobs *(expected BullMQ behaviour — verify in AT-MNT-18)* | the pending job runs when a worker returns | overdue reservations stay ACTIVE (held longer, never released wrongly); alerts fire (§8.6); manual command available; catch-up on return |
| 6 | Redis unavailable, PostgreSQL available | cannot be read or written | none delivered | **no scheduled run happens**; the manual command (MNT-13) and on-access expiry still work; PostgreSQL-based alerts fire |
| 7 | Redis available again after an outage | ioredis reconnects; reconciler verifies or recreates within 60 s | the pending job (if it survived) or the next tick runs | first run releases everything overdue, across as many runs as the backlog needs |
| 8 | A job is duplicated or processed twice (stalled re-delivery while the first worker still runs, manual enqueue, overlap with the manual command) | unaffected (fixed id: never two schedules) | both executions run | `SKIP LOCKED` per group + guarded `ACTIVE → RELEASED` + unique `release:<reservationId>` movement key: each reservation released at most once; the second execution counts it as skipped; two `MaintenanceRun` rows (§8.10) |

**Reconciler check (scenario 2):** a scheduler entry that exists but has no next pending job would never fire again. The reconciler therefore treats the schedule as healthy only if the scheduler exists, its pattern is `*/10 * * * *` **and** its next run time is not more than one interval in the past; otherwise it upserts again with the same id (the upsert re-creates the next job). *Implementation acceptance criterion:* verify this with the installed BullMQ 6.3.0 (`getJobScheduler` returns the scheduler with its `next` time; confirmed present in the installed type definitions) in AT-MNT-12. The PostgreSQL alert "no successful run for 25 min" is the backstop if the check is wrong.

**Critical requirements — where each is enforced:**

| Requirement | Enforced by |
|---|---|
| PostgreSQL is the source of truth; Redis is never the only record of an expired reservation | expiry state lives only in `stock_reservations` / order rows; Redis holds no reservation ids or deadlines (empty payload, MNT-02, MNT-07) |
| Missing schedules recreated idempotently, never duplicated | fixed-id `upsertJobScheduler` (MNT-11, C-MNT3, AT-MNT-13) |
| Expired reservations discovered by PostgreSQL catch-up | MNT-02, MNT-04 (AT-MNT-02, AT-MNT-07) |
| Never released before the deadline | candidate query and re-validation inside the transaction use the database clock `now()` (MNT-02) |
| Deadlines never extended | no maintenance path writes `expires_at` / `reservationCapAt` (§8.10 item 11) |
| Never released twice | §8.10 items 2, 3, 5, 6 |

### 8.3 Redis production configuration (MNT-12; facts to confirm — TQ-27 stays open)

Verified in the repository (read-only, 2026-10-27): BullMQ connects through `REDIS_URL` (`infra/queue/queue.module.ts`, `redis-connection.ts`; TLS via `rediss://`, db number honoured); local `docker-compose.yml` runs `redis:7-alpine` with a data volume and **no explicit configuration** (no `maxmemory-policy`, `appendonly` or `save` settings in the repo); production uses Redis Cloud whose settings **cannot be read from the repository**; the `orders` queue is registered **without** `removeOnComplete` / `removeOnFail` options (the search queue has them), so completed and failed expiry job records accumulate in Redis; no Redis monitoring exists.

| Setting | Required for production | Status |
|---|---|---|
| `maxmemory-policy` | `noeviction` (BullMQ requirement; eviction could silently delete schedulers or jobs) | **to confirm** on Redis Cloud (TQ-27) |
| Persistence | AOF (`appendfsync everysec`) or RDB snapshots — reduces lost job records after a restart | **to confirm** (TQ-27) |
| Restart behaviour | after restart, reconciler recreates the scheduler (§8.2) | design |
| Queue retention (MNT-14) | bounded cleanup of completed and failed jobs, §8.3.1; `MaintenanceRun` in PostgreSQL is the history, not Redis (MNT-15) | **gap in current code** — to change when TD-18 is implemented |
| Connection failure handling | BullMQ / ioredis auto-reconnect; worker connections configured as BullMQ requires (`maxRetriesPerRequest: null`); the process does not exit on a transient Redis error | to verify at implementation |
| Monitoring | Redis reachability, memory usage vs limit, evictions = 0, connected worker count, failed / stalled job counts in `orders` | **missing** — to add (`13` §5) |

**Capacity and connections (to measure, TQ-27):** Redis memory used by BullMQ is small and bounded by §8.3.1 (one scheduler, at most one pending expiry job, bounded completed / failed sets per queue), but the plan's memory limit, current usage and **connection limit** must be known. Each BullMQ worker opens its own connections (including a blocking one), in addition to the API's queues and throttler, so the connection count for the API plus the worker process is measured in staging and compared with the plan's limit.

**Evidence required to close TQ-27** (all from the real production Redis, recorded in `11` §TQ-27 with date and who checked):
1. The eviction policy shown in the provider dashboard (or `CONFIG GET maxmemory-policy` where the plan allows it) = `noeviction`.
2. The persistence setting (AOF and its fsync policy, or snapshot interval), or an explicit statement that the plan has none.
3. The memory limit, `INFO memory` used memory, and `INFO stats` `evicted_keys` = 0.
4. The plan's connection limit against the measured connection count of API + worker.
5. A restart (or failover) test on an equivalent staging database: which keys survive, and that the reconciler restores the 10-minute schedule (AT-MNT-06, AT-MNT-11, AT-MNT-12).
6. Whether the provider restarts or migrates the database without notice (maintenance policy).

Until all six are recorded, TQ-27 stays **open** and no Redis setting in this document counts as a production fact.

#### 8.3.1 BullMQ job retention vs `MaintenanceRun` retention (MNT-14, MNT-15)

Two different records with two **independent** retention policies:

| | BullMQ job record | `MaintenanceRun` row |
|---|---|---|
| Where | Redis (`orders` queue; later `outbox`, `reconciliation` — §8.5) | PostgreSQL `maintenance_runs` |
| What it is | queue coordination data: job state, attempts made, failure reason / stack | the **operational audit record** of a maintenance execution (§8.6) |
| Authoritative? | no — can be lost with Redis (§8.2) | yes — used by monitoring, alerts and investigations |
| Retention | bounded cleanup (below) | own period, **TD-24 (pending)** |

**BullMQ job retention (proposal under TD-18; the current `orders` queue has none — §8.3):**

| Job state | Proposed policy | Notes |
|---|---|---|
| Completed | `removeOnComplete: { count: 100, age: 86400 }` — keep at most the last 100 completed jobs and none older than 24 h | one job every 10 min ≈ 144 per day, so Redis holds about the last 16 h; the history is in `MaintenanceRun` |
| Failed (final) | `removeOnFail: { count: 1000, age: 604800 }` — keep at most 1,000 finally failed jobs, none older than 7 days | long enough to inspect a failure after a weekend; bounded so a failure storm cannot grow Redis without limit |
| Retrying | expiry job: `attempts: 1` (proposed) — the next 10-minute tick is the retry, because every run re-reads PostgreSQL; queues with `attempts > 1` (e.g. `reconciliation`, §8.5) wait in `delayed` between attempts and `removeOnFail` applies **only after the final attempt** | stalled re-delivery (`maxStalledCount` 1) is not an attempt and is unaffected |
| Inspection before cleanup | the failed set (`failedReason`, stack, `attemptsMade`) is read-only operator data in Redis while it is kept; the **`MaintenanceRun` row** (status FAILED / PARTIAL, `error`, counts) is the record investigated, and it remains after cleanup | investigations never depend on Redis job records alone |
| Growth | **count is the hard bound**: it is applied every time a job of that kind finishes, so the completed set never exceeds 100 and the failed set never exceeds 1,000 per queue. **Age is best-effort**: BullMQ 6.3.0 has no background timer, so a job older than its age is removed only when another job of the same kind finishes later (a single failure in a quiet week stays in the failed set beyond 7 days until the next failure). Job counts per queue are monitored (§8.3 Monitoring, `13` §5) | values configurable; final values set at implementation |

**Verified against the installed BullMQ 6.3.0 (read-only, 2026-10-27; `bullmq@6.3.0` resolved from `apps/api`, `@nestjs/bullmq` 11.0.5):**
- `removeOnComplete` / `removeOnFail` accept `boolean | number | KeepJobs`. `KeepJobs` is `{ count }` or `{ age, count?, limit? }`, with `age` in **seconds**.
- With both `age` and `count`, the jobs kept are those that satisfy **both** limits.
- Eviction is evaluated only when another job of the same kind finishes (no timer).
- `removeOnFail` acts only when a job **fails after all attempts**, so a job waiting for a retry is never removed.
- `upsertJobScheduler(id, repeatOpts, { name, data, opts })` accepts `opts` of type `JobSchedulerTemplateOptions` (job options without `jobId`, `repeat`, `delay`, `deduplication`), so `removeOnComplete`, `removeOnFail` and `attempts` can be set on the scheduler's template. Worker-level `removeOnComplete` / `removeOnFail` (`KeepJobs`) also exist; job-level values override them.
- `getJobScheduler(id)` and `getJobSchedulers()` exist (used by the reconciler).
- **Failed-job inspection before cleanup:** `queue.getFailed()` and the job's `failedReason`, `stacktrace` and `attemptsMade`, read-only, by the operator. Investigations start from `MaintenanceRun` (`13` §1.8).

These limits bound what the application keeps in Redis; whether job records survive a Redis restart depends on persistence and eviction settings that are **not verified** (TQ-27, MNT-12). Today's search queue (`removeOnComplete: true`, `removeOnFail: { count: 1000 }`, `attempts: 5`) is not changed by this proposal.

**`MaintenanceRun` retention (PostgreSQL):**
- `MaintenanceRun` is an operational audit record in PostgreSQL and is the **permanent operational audit source until an approved retention policy exists** (TD-24). Its retention is **independent of BullMQ cleanup** (MNT-15). Neither BullMQ cleanup nor any Redis data loss can delete its rows: they live in another system.
- `jobId` is a plain reference string with no link into Redis. Removing a BullMQ job (`removeOnComplete` / `removeOnFail`, `clean`, `obliterate`, FLUSHALL, Redis data loss) **never deletes or updates** the corresponding `MaintenanceRun` row; no code path deletes or changes `maintenance_runs` rows in reaction to BullMQ events. A `jobId` that no longer exists in Redis is expected and harmless.
- **Retention period: not decided — TD-24, pending Youssef.** *Proposal (not approved, not to be treated as approved):* keep every row for at least 12 months. Until TD-24 is decided **no cleanup process exists or may be built that deletes `MaintenanceRun` rows**. Any future purge would be a separate, audited PostgreSQL maintenance operation, by age only, never triggered by BullMQ, never touching RUNNING rows or rows inside the monitoring windows of §8.6.
- The audit rows, inventory movements and outbox events written by a run are separate append-only records with their own rules; they are never removed together with a `MaintenanceRun` row.

### 8.4 TD-13 amendment — one dedicated reservation-maintenance worker (TD-22, pending; C33)

- **TD-13 stays exactly as approved on 2026-10-24** ("background workers postponed"); its history is not rewritten.
- **Proposed amendment TD-22 (pending Youssef):** *permit exactly one dedicated worker process type — the reservation-expiration worker of TD-18 — running only the `orders` queue's expiry job and its schedule reconciler.*
- **What it permits:** deploying, running and supervising that process (one or more replicas of the same process type, safe by §8.1 / §8.2).
- **What it does not permit:** any other background worker or business process (outbox drain, payment reconciliation, PAYMOB, notifications, settlements, …) — each needs its own decision (TD-23 for outbox and reconciliation); it does not change TD-13's temporary alternatives for the other workflows.
- **Relationship:** TD-18 (mechanism) depends on TD-22 for the *dedicated* part; without TD-22 the same mechanism runs in-process in the API (today's arrangement), which is acceptable for go-live only if R-D8 is met (scheduled runs + alerts). C33 records the conflict until TD-22 is decided.

### 8.5 Outbox drain and reconciliation runs — worker architecture (TD-23, pending)

**Recommended (Youssef's stated preference, not approved):** separate logical responsibilities — one BullMQ **queue per responsibility** (`orders` reservation expiry; `outbox` drain; `reconciliation` runs), each with its own scheduler, concurrency limit, retry policy, `MaintenanceRun.command`, metrics and alerts. They **may share one worker process** at first; each queue has its own processor, so one failing or slow responsibility does not block the others.

| Aspect | Shared process (separate queues) | Separate processes |
|---|---|---|
| Advantages | one deployable; fewer moving parts; simpler hosting on a small team | full failure and resource isolation; independent scaling and deploys |
| Disadvantages | a crash or memory leak stops all responsibilities at once; CPU / DB-pool contention between queues | more processes to deploy, supervise and monitor |
| Failure isolation | logical only (queue-level); process-level failure is shared | complete |
| Resource contention | shared DB connection pool and event loop — mitigated by per-queue concurrency limits and per-run budgets | none between them |
| Operational complexity | low | medium |
| Independent deployment / scaling needed? | not for MVP volumes (assumption, to revisit with measurements) | when one responsibility needs scaling or a different release cadence |

**Per-queue policies (proposed under TD-23; values configurable, not approved):**

| Responsibility | Trigger | Concurrency | Retry | Retention | Monitoring record |
|---|---|---|---|---|---|
| Reservation expiry (`orders` queue) | every 10 min (TD-18) | 1 | job `attempts: 1`; next tick retries; stalled re-delivery once | §8.3.1 | `MaintenanceRun` `EXPIRE_OVERDUE`; alerts §8.6 |
| Schedule reconciler (a loop inside the process, **not** a queue job — §8.2) | every 60 s + boot | single-flight: a check is skipped while the previous one is in flight; per-call timeout | on error: logged, retried at the next 60-s tick (backoff while Redis is unreachable); never more than one call in flight | nothing in Redis | `MaintenanceRun` `SCHEDULE_RECONCILE` when it recreates the schedule; consecutive-failure counter on `/health` |
| Outbox drain (`outbox` queue) | every 5 min (proposed, `01` §7.5) | 1 | job `attempts: 1`; per-delivery retries live in `outbox_deliveries` (backoff, max 10 → DEAD, `01` §7) | §8.3.1 limits | `MaintenanceRun` `OUTBOX_DRAIN`; outbox metrics `01` §7.7 |
| Reconciliation runs (`reconciliation` queue, Phase 3b+) | per `12` | 1 | `attempts: 3`, exponential backoff (waits in `delayed`, holding no concurrency slot) | §8.3.1 limits | `ReconciliationRun` (`02`); alerts per `12` |

**Failure isolation in a shared process (MNT-16):**
- Each queue has its **own BullMQ worker** with its own concurrency, so a failing, retrying or backlogged queue can occupy only its own slots. It cannot take the outbox drain's slot, and a job is never processed by another queue's worker.
- The schedule reconciler is single-flight with a timeout, so repeated failures cannot pile up calls or block the event loop.
- Errors in one processor or in the reconciler are caught. They mark only that job (or that check) failed and never crash the process.
- Each run is bounded (batch size, time budget, concurrency 1 per queue), so no queue holds more than one database transaction at a time from the shared pool.
- Failure and recovery stay visible in each responsibility's own record, so a failing reconciliation never hides or delays the outbox drain's signals.
- **Limitation (unchanged):** a process-level failure (crash, out-of-memory, blocked event loop) stops all queues in that process, and a Redis outage stops every queue in any arrangement. Those are detected by each responsibility's PostgreSQL-based alerts, not prevented by queue isolation.
- Proven by **AT-MNT-16**, which applies only if TD-23 selects the shared process.

**Separate queues are not process isolation (reliability review 2026-10-27).** Four levels must be kept apart:

| Level | What it isolates | Given by separate BullMQ queues? | How this design handles it |
|---|---|---|---|
| Queue-level concurrency | waiting, active, delayed and failed jobs of one queue | **yes** — each queue has its own lists; a backlog in `reconciliation` never enters `orders` or `outbox` | built in |
| Worker-level concurrency | how many jobs of one queue run at once | **only** if each queue has its own BullMQ `Worker` with its own `concurrency` (default 1 in BullMQ 6.3.0) | one worker per queue, each concurrency 1 (table above); a job in `delayed` (waiting for a retry backoff) holds **no** slot. *Implementation acceptance criterion:* no shared worker processes two queues |
| Process-level CPU and memory | Node event loop, heap, Prisma connection pool, open sockets | **no** — everything in one process shares them | concurrency 1 per queue and bounded runs keep at most one transaction per queue in flight (≤ 3 from the worker process at Phase 3b, ≤ 2 before); the Prisma pool for the worker process is sized explicitly above that (value set at implementation); no processor runs CPU-heavy work without yielding (a blocked event loop stops lock renewal and makes other queues' jobs stall); memory and CPU are measured under load (§8.9) |
| Infrastructure-level | Redis, PostgreSQL, host | **no** — shared by every arrangement, including separate processes | detected, not prevented: each responsibility has its own PostgreSQL-based alerts; a Redis or PostgreSQL outage stops all queues (§8.2.1, §8.6) |

**What a shared process cannot give:** a crash, out-of-memory kill or blocked event loop in one processor stops **all** responsibilities in that process; a memory leak in one shortens the life of all; heavy reconciliation queries compete for the same pool and CPU. AT-MNT-16 shows queue- and worker-level isolation under the faults it injects; it does **not** show process-level isolation, and no test of fixed duration proves reliability under every production failure.

**Schedule reconciliation never blocks expiry processing:** the reconciler is a timer in the process, not a job on the `orders` worker's slot; it makes at most two short Redis calls per check with a timeout, never waits for the expiry job, and a failing check does not stop the worker from processing jobs that are already scheduled. Startup reconciliation is non-blocking: the worker starts consuming even if the first check fails, and the next 60-s check retries. *(Today's code awaits `upsertJobScheduler` inside `onModuleInit`, so startup waits on Redis — implementation acceptance criterion: the TD-18 worker must not block startup on reconciliation.)*

**When one queue keeps failing (proposed; no automatic pause):**

| Responsibility | Repeated failure means | What happens automatically | Alert (§8.6) | Operator action |
|---|---|---|---|---|
| Reservation expiry | 3 consecutive FAILED / PARTIAL runs | keeps running every tick (each run is safe on its own; no circuit breaker) | P1 | diagnose; run the manual command if the scheduled path stays broken |
| Schedule reconciler | 5 consecutive failed checks (≈ 5 min) | keeps checking every 60 s with backoff while Redis is unreachable | P2 (the 25-min no-run alert is the backstop) | check Redis and the scheduler |
| Outbox drain | a delivery fails 10 times → DEAD; 3 consecutive failed drain jobs | other deliveries continue; DEAD deliveries wait for requeue (`01` §7.9) | DEAD: per `01` §7.7; jobs: P2 | inspect, fix, requeue |
| Reconciliation runs | a job fails its 3 attempts; 3 consecutive failed runs | job moves to the failed set; `ReconciliationRun` FAILED; the next scheduled run tries again | P2 | the operator may pause **only** the `reconciliation` queue (pausing one queue does not affect the others) while investigating |

Recommendation: shared process with separate queues for the MVP, with each queue's health monitored separately; split into processes when monitoring shows contention. **A shared process is acceptable for the MVP only if** (a) the load tests of §8.9 show the expiry run staying within its budget while the outbox drain (and, from Phase 3b, reconciliation runs) load the same process; (b) memory and CPU headroom is measured there; (c) each responsibility has its own PostgreSQL-based alerts; and (d) the host supervises and restarts the process (§8.8). If any of these fails, separate processes are required. At Phase 0 go-live only expiry and the outbox drain exist; reconciliation runs arrive in Phase 3b+. Placing the outbox drain in the reservation worker's process needs TD-23 in addition to TD-22, which permits only the expiry worker. **Pending (TD-23)**; nothing is approved or implemented. The outbox drain interval (proposed every 5 min, `01` §7.5) is independent of the reservation-maintenance interval (10 min).

### 8.6 `MaintenanceRun` and monitoring

`MaintenanceRun` (`02` §3.8) records: run id; command; BullMQ job id; scheduled execution time; actual start and finish; worker instance; status (RUNNING, SUCCEEDED, PARTIAL, FAILED); batch count; processed (candidates examined), released, skipped and failed counts; error; backlog and oldest overdue age at start; catch-up flag; stalled re-delivery attempt; triggered by (schedule / admin / reconciler). Failed and partial runs are always recorded (a run that dies before finishing is closed as FAILED by the next run or the reconciler when its `startedAt` is older than the budget + margin).

**Alerts (reliability review 2026-10-27; thresholds and severities proposed, TBD with OD-01; severity aligned later with OD-08's severity matrix):**

Severity: **P1** — notify OD-01 immediately, escalate to OD-08 if not acknowledged in 30 min; **P2** — notify OD-01, handle the same day; **P3** — informational, dashboard only. A "successful run" is an `EXPIRE_OVERDUE` run that finished as SUCCEEDED or PARTIAL (it executed and released what it could; PARTIAL is alerted separately). Every alert is **deduplicated** as one open alert per condition (per run for run-level alerts), re-notified every 60 min while open; "auto-clear" means the evaluator closes it when the condition is false at the next evaluation.

| # | Alert | Detection source | Exact trigger | Sev. | Operator action | Recovery | Auto-clear |
|---|---|---|---|---|---|---|---|
| A1 | No successful run | PostgreSQL `maintenance_runs` | `now() − max(finishedAt)` of successful `EXPIRE_OVERDUE` runs > **25 min** (two missed 10-min ticks + 4-min budget + margin) | P1 | use A9–A13 to tell whether the worker, Redis, PostgreSQL or the schedule is the cause; run the manual command if not resolved within 15 min | fix the cause; the next run catches up | yes, on the next successful run |
| A2 | Run failed | PostgreSQL | any `EXPIRE_OVERDUE` run FAILED (including a stale RUNNING row closed as FAILED) | P2 | read the run's `error`; check logs | next run retries | yes, on the next successful run |
| A3 | Repeated failures | PostgreSQL | 3 consecutive `EXPIRE_OVERDUE` runs FAILED or PARTIAL | P1 | as A1; look for a common failing group | fix; the next run retries | yes, after one SUCCEEDED run |
| A4 | Run exceeded its budget | PostgreSQL | a run RUNNING for more than **5 min**, or finished with duration > 5 min (4-min budget + 1-min margin: a run that stops at its budget finishes its current group a few seconds later, so "> 4 min" alone would fire on every budget-limited catch-up run; valid only if each maintenance transaction is bounded by `lock_timeout` / `statement_timeout` — review in `22` §4.5) | P2 | look for a stuck transaction (lock wait) or a budget check that is not working | stuck run ends or is closed as FAILED | yes |
| A5 | Reservation overdue | PostgreSQL. Phase 0: groups matching the expiry eligibility rule; Phase 1: `stock_reservations` | Phase 0: ≥ 1 eligible group with `createdAt < now_app − TTL − 30 min` (application clock, as the candidate cutoff; > 90 min old with today's 60-min TTL). Phase 1: any ACTIVE reservation more than **30 min** after its deadline. One signal with count and oldest age (`23` §11.11) | P1 | check A1–A4; run the manual command | catch-up releases it | yes, when none is overdue > 30 min (proposed: after 2 consecutive clean evaluations) |
| A6 | Backlog | PostgreSQL `maintenance_runs.backlogAtStart` | > 500 overdue groups at the start of a run (P3); on 3 consecutive runs without shrinking (P2) | P3 / P2 | P2: compare with measured throughput (§8.9); check failures | catch-up across runs | yes, when below 500 |
| A7 | Release integrity | PostgreSQL invariant queries (`05` §5 inv. 1, 2, 16) run after each run and daily | a reservation RELEASED without exactly one RELEASE movement, a movement without its reservation transition, or a FULFILLED reservation released | P1 (incident, `13` §1.10) | stop and investigate; no manual stock edit | per `12` discrepancy process | no — closed by the operator |
| A8 | Schedule recreated | PostgreSQL (`SCHEDULE_RECONCILE` rows) | reconciler recreated the schedule (P3); more than 3 times in 24 h (P2: Redis is losing data) | P3 / P2 | P2: check Redis persistence / eviction (TQ-27) | automatic | event (P3); P2 clears after 24 h without recreation |
| A9 | Worker unavailable | PostgreSQL + host | no `EXPIRE_OVERDUE` run **started** (no row at all) for 25 min while Redis is reachable (A11 clear) and the schedule is present; host process status where the platform exposes it; BullMQ connected-worker count = 0 (Redis-based, informational) | P1 | restart the worker through the host; manual command meanwhile | supervisor restart (§8.8) | yes |
| A10 | Worker crash loop | PostgreSQL + host | ≥ 2 stale RUNNING rows closed as FAILED within 60 min, or ≥ 3 restarts in 30 min reported by the host | P1 | read the crash cause; roll back the release if it started with a deploy | fix; supervisor restarts | yes, after 60 min without a crash |
| A11 | Redis unavailable | API / worker Redis ping, external monitor | ping fails for > 2 min (P2); > 10 min (P1) | P2 / P1 | check the provider; manual command while it lasts | reconnect; reconciler; catch-up | yes |
| A12 | Redis memory / eviction | Redis `INFO` (Redis-based) | used memory > 80 % of the limit (P2); `evicted_keys` increasing (P1: BullMQ data being dropped) | P2 / P1 | check job retention (§8.3.1) and the eviction policy (TQ-27) | free memory / fix the policy | yes |
| A13 | PostgreSQL unavailable | API health check, external monitor; the alert evaluator itself | database ping fails, **or the evaluation of A1–A7 cannot run** (an evaluation that fails is reported as this alert, never as "no alert") | P1 | database runbook (`13` §1.1) | Prisma reconnects; catch-up | yes |
| A14 | Schedule missing, reconciler failing | worker health counter, logs | 5 consecutive failed reconciler checks | P2 | check Redis and the scheduler entry | reconciler succeeds | yes |
| A15 | Processing failures | PostgreSQL | a run PARTIAL (`failed > 0`); the same group failing in 3 consecutive runs (P1) | P2 / P1 | read the per-group error in the logs; fix the data or the cause | next run retries the group | yes |

How the alerts tell causes apart: **worker unavailable** = A9 (no run started, Redis fine); **Redis unavailable** = A11; **PostgreSQL unavailable** = A13; **missing recurring schedule** = A8 / A14, with A1 as the backstop; **queue backlog** = A6; **processing failures** = A2, A3, A15; **stock-release failures** = A5 (not released) and A7 (released wrongly).

**Who evaluates the alerts:** not the worker (a dead worker must still raise A1 / A9) and not Redis. Proposed: a health endpoint in the API computes A1 – A7, A9, A10 and A15 from PostgreSQL, and an external monitor polls it and the API health check and delivers notifications. The monitoring and paging tool is **not chosen** (TQ-33); the proposed delivery design — external heartbeats and health-endpoint monitors that still alert when PostgreSQL, Redis or the worker is down — and its provider comparison are in `22` §4. Today `/health` returns a static `{ status: 'ok' }` without checking PostgreSQL or Redis (verified read-only), so none of these signals exists yet.

Monitoring of missing or failed runs never depends on Redis: it reads `maintenance_runs` and `stock_reservations` from PostgreSQL (MNT-10). `MaintenanceRun` rows are kept independently of BullMQ job cleanup (§8.3.1, MNT-15; period TD-24 pending).

### 8.7 Scenario coverage

| # | Scenario | Test | Requirement | Criterion |
|---|---|---|---|---|
| 1 | Normal recurring execution every 10 min | AT-MNT-10 | MNT-01, MNT-07 | 60 |
| 2 | Redis temporary outage | AT-MNT-11 | MNT-11, MNT-13 | 63 |
| 3 | Redis data loss / FLUSHALL | AT-MNT-06 | MNT-08, MNT-11 | 63 |
| 4 | Schedule missing while the worker runs | AT-MNT-12 | MNT-11 | 63 |
| 5 | Reconciliation by several instances | AT-MNT-13, C-MNT3 | MNT-11 | 63 |
| 6 | Worker crash during processing | AT-MNT-06, C-MNT2 | MNT-08 | 60 |
| 7 | Worker restart and recovery | AT-MNT-06 | MNT-08 | 60 |
| 8 | Two workers concurrently | AT-MNT-08, C-MNT1 | MNT-09 | 60 |
| 9 | Two-hour outage and catch-up | AT-MNT-07 | MNT-04, MNT-10 | 60 |
| 10 | Crafted job payload | AT-MNT-09 | MNT-02, MNT-07 | 60 |
| 11 | PostgreSQL transaction rollback | AT-MNT-14 | MNT-03 | 60 |
| 12 | Partial batch failure | AT-MNT-15 | MNT-04, MNT-05 | 60 |
| 13 | Monitoring while Redis is unavailable | AT-MNT-07, AT-MNT-11 | MNT-10 | 60 |
| 14 | No duplicate inventory release | AT-MNT-03, AT-MNT-08, C-MNT1 | MNT-03 | 60 |
| 15 | Courier-handover inventory protected | AT-MNT-05, AT-DSP-02 | DSP-01, MNT-02 | 61 |
| 16 | Reconciler / reconciliation failure does not starve the outbox drain in a shared process (TD-23) | AT-MNT-16 | MNT-16, OBX-05 | 63 |
| 17 | BullMQ job cleanup never removes `MaintenanceRun` history | AT-MNT-17 | MNT-14, MNT-15 | 60 |
| 18 | Unexpected worker termination and automatic restart | AT-MNT-18, AT-MNT-06 | MNT-17, MNT-08 | 64 |
| 19 | Graceful shutdown during an active run; deploy overlap | AT-MNT-19 | MNT-17 | 64 |
| 20 | Worker recovery after a Redis outage | AT-MNT-11 | MNT-17, MNT-11 | 63, 64 |
| 21 | Worker recovery after a database outage | AT-MNT-20 | MNT-17, MNT-10 | 64 |
| 22 | Throughput, budget and backlog recovery under load | AT-MNT-21 | MNT-18, MNT-04 | 65 |
| 23 | Alert catalogue, causes distinguished, auto-clear and deduplication | AT-MNT-04 | MNT-06, MNT-10 | 60 |
| 24 | Transaction-safety guarantees (§8.10) | AT-MNT-03, AT-MNT-05, AT-MNT-08, AT-MNT-09, AT-MNT-14, C-MNT1, C-MNT2, AT-DSP-02, AT-DSP-03 | MNT-02, MNT-03, MNT-09, DSP-01 – DSP-03 | 66 |
| 25 | A group skipped by `SKIP LOCKED` is released by a later run once its lock is gone | AT-MNT-22 | MNT-03, MNT-04 | 66 |
| 26 | Manual retry while the previous run is still RUNNING | AT-MNT-23 | MNT-03, MNT-13 | 66 |

### 8.8 Worker process supervision and lifecycle (MNT-17; TQ-16, TQ-28 open)

**Verified in the repository (read-only, 2026-10-27):**
- `render.yaml` (tracked) declares **one** service: `type: web`, `runtime: docker`, `plan: free`, `healthCheckPath: /health`. There is **no** worker service.
- `apps/api/Dockerfile` starts a single process, `CMD ["node", "dist/main.js"]` (the API). No process manager (pm2, supervisord) is installed, and no worker entry point exists.
- `/health` returns a static `{ status: 'ok' }`.
- `main.ts` calls `app.enableShutdownHooks()`. `@nestjs/bullmq` 11.0.5 closes every worker on application shutdown (`worker.close()`), and BullMQ 6.3.0's `close()` waits for active jobs to finish unless forced.
- Whether `render.yaml` is actually deployed cannot be told from the repository (API hosting status: TQ-09, TQ-16).
- *Official Render documentation (verified 2026-10-27, `22` §1.2):*
  - free web services spin down after 15 minutes without inbound traffic, may be restarted at any time and are "not for production";
  - background workers have no free instance type;
  - deploys start the new instance and send `SIGTERM` to the old one 60 s later, so old and new workers overlap;
  - the shutdown grace period (`maxShutdownDelaySeconds`) defaults to 30 s, maximum 300 s;
  - automatic restart of a crashed worker is not stated explicitly and must be demonstrated.

**Consequence (deployment blocker):** nothing in the current deployment configuration supervises a separate worker. The API process does **not** supervise one, and the only declared service is a free web instance.
- **Provider facts to confirm** against the provider's current documentation (not verified here): whether a free web instance sleeps when idle, and which service types run an always-on background process with automatic restart.
- A free web instance that sleeps would also stop today's in-process expiry job.
- Until the chosen host is shown to run the worker continuously and restart it automatically (TQ-16, TQ-28, evidence in `11`), **TD-18 cannot go live**, whether in-process or dedicated (R-D8, PRG-03).

**Required lifecycle (all proposals; mechanism per host, not chosen):**

| Behaviour | Requirement | Design | Status |
|---|---|---|---|
| Starts on deploy | the worker starts automatically with every release, from the same image | a separate service (or process) with its own start command for a worker entry point (to be created under TD-22); the API never starts or supervises it | blocked by TQ-16 / TQ-28 / TD-22 |
| Restarts after a crash | automatic restart without an operator | the host's restart policy | to verify (AT-MNT-18) |
| Health independent of the API | a dead worker is detected even when the API is healthy | A9 / A10 from PostgreSQL (no run started; stale RUNNING rows), host process status, BullMQ connected-worker count (informational) | design |
| Repeated crashes alert | crash loops are visible | A10 | design |
| Graceful shutdown | on SIGTERM no new group is started; the current group transaction finishes; the run is closed as PARTIAL with error `shutdown` and the job completes; the process exits within the host's grace period | the run checks a stopping flag **between groups**, because the 4-min budget can exceed the grace period (length to confirm per host). *Implementation acceptance criterion:* the run stops within a few seconds of SIGTERM | design (AT-MNT-19) |
| In-progress job if killed anyway | SIGKILL or crash mid-run leaves no partial group | PostgreSQL rolls back the open transaction when the connection drops; the job's lock expires → re-delivered once or the next tick runs; the RUNNING row is closed as FAILED by the next run | design (AT-MNT-06, AT-MNT-18) |
| No duplicate release on restart | — | §8.10 | design |
| Redis reconnection | a Redis outage never crashes the worker | ioredis reconnects with backoff; BullMQ resumes. *Implementation acceptance criteria:* an `error` listener is attached so a Redis error event never becomes an unhandled exception (verify with `@nestjs/bullmq` 11.0.5), and worker connections use `maxRetriesPerRequest: null` as BullMQ requires (verify how the options object from `redisConnectionFromUrl` is applied) | to verify (AT-MNT-11) |
| PostgreSQL reconnection | a database outage never crashes the worker | Prisma reconnects on the next query; a run during the outage fails (logged, BullMQ failed set). It **cannot write its own `MaintenanceRun` row while the database is down**, so A13 (not A2) reports it | to verify (AT-MNT-20) |
| Startup reconciliation | the schedule is verified at every start | boot check + 60-s loop, non-blocking (§8.5) | design |
| One schedule owner during deploys | old and new versions never fight over the schedule | today's API upserts `*/5 * * * *` on boot. During a rolling deploy an old instance and a new reconciler would keep rewriting the pattern. *Rule:* exactly one component type owns the schedule at a time — the API while the job runs in-process, the worker once TD-22 is approved — and the release that moves ownership or changes the pattern removes the old upsert. Overlap of old and new workers is safe for stock (§8.10) | design (AT-MNT-19) |

### 8.9 Throughput, backlog and budget validation (MNT-18; not measured)

The values 500 groups per batch, a 4-minute budget and a 10-minute interval are **unmeasured assumptions**. The estimate of 5,000–12,000 groups per run assumes 20–50 ms per group transaction and is **not evidence**. Today's code processes one batch of **100** groups per run with no time budget, and one failing group aborts the whole run (verified read-only, `orders.service.ts`). The proposal changes both, and must be measured before go-live.

**Load-test plan (AT-MNT-21; environment: the rehearsal snapshot of `06` §7 on hardware comparable to production — results are valid only for that size):**

| Run | Overdue groups at start | Concurrent API traffic | Purpose |
|---|---|---|---|
| L1 | 500 | none | baseline per-group cost; one batch |
| L2 | 1,000 | synthetic checkout, order reads and cancels at the expected peak rate (rate from Ibrahim's volume expectations; TBD) | multi-batch run under load |
| L3 | 5,000 | same, at twice the expected peak | budget behaviour; lock contention with requests touching the same groups (lazy expiry, cancels) |
| L4 | 10,000 | same as L3 | backlog after prolonged downtime; number of runs to recover |
| L5 | 5,000 | as L3, plus the outbox drain (and, from Phase 3b, a reconciliation run) in the same process | shared-process contention (TD-23 condition a) |
| L6 | 5,000 | as L3; the worker is killed mid-run and restarted | restart during processing: no partial group, no double release, recovery time |
| L7 | backlog from a 6-hour stopped schedule at L2 traffic | L2 traffic | catch-up after a prolonged outage; runs needed until backlog 0 |

Each dataset: groups with 1–3 orders and 1–5 lines; about 10 % guarded out (proof under review, live attempt) to exercise *skipped*; about 1 % forced failures to exercise *failed*.

| Measurement | How |
|---|---|
| Groups (orders) processed per second | `released` + `skipped` per run ÷ run duration |
| Total execution duration | `MaintenanceRun.startedAt` / `finishedAt` |
| Database query duration | `pg_stat_statements`: candidate query and per-group transaction p50 / p95 / p99 |
| Lock contention | `pg_locks` waits, lock-timeout errors, deadlocks (must be 0), rows skipped by `SKIP LOCKED` |
| Memory, CPU | worker process RSS / heap and CPU; database CPU |
| Backlog size, oldest overdue | `backlogAtStart`, `oldestOverdueAtStart` of each run |
| Skipped and failed records | `skipped`, `failed` |
| Backlog recovery time | time from the first run until a run starts with backlog 0 |
| API impact | API p95 latency during runs vs the same traffic without runs |

**Pass criteria (proposed, to confirm with Youssef):** P1 – P8 in `22` §7. These cover:
- each run's budget;
- L1 completing in one run;
- 10,000 groups cleared within 6 runs;
- no double release and no deadlocks;
- exact skipped / failed counts;
- API p95 ≤ 120 %;
- recovery with no manual step;
- memory below 70 %.

**Questions the measurements answer** (if one fails, the value changes through a revision of TD-18 and stays pending; the 10-minute interval and the proposed 30-minute TRANSFER proof window — BD-07 pending; today's TTL is 60 minutes, `23` §11.1 — are not changed by this plan):
- Is 500 a reasonable batch size? (Candidate-query p95 and memory per batch.)
- Is the 4-minute budget realistic? (Groups per run within the budget, finishing well below the 10-minute interval.)
- Can a 10-minute schedule keep up with normal traffic? (Expected overdue groups per 10 min, which is **unknown until volumes are estimated**, must be well below the measured groups per run.)
- Can the system recover after prolonged downtime? (Runs needed = backlog ÷ groups per run, × 10 min.)

**Backlog handling:**
- **Multiple batches per run:** yes. Each run loops over batches of ≤ 500, oldest first, until none remain or the budget is spent.
- **Backlog left after the budget:** the run stops after its current group and finishes SUCCEEDED (or PARTIAL if groups failed). The next tick continues, starting with `catchUp = true`. An immediate follow-up run is **not** part of the proposal (it would need a TD-18 revision if L4 shows recovery is too slow).
- **Alert thresholds:** A6 (> 500 at start; P2 when not shrinking) and A5 (overdue > 30 min).
- **Maximum acceptable backlog:** **not decided**. Proposed: the number of groups one run clears within its budget, as measured in L3. Until then, A6's 500 is the working threshold (OD-01).
- **Starvation of other queues:** expiry holds only its own slot, and its 4-minute budget leaves the slot idle for ≥ 6 of every 10 minutes. The outbox drain has its own slot. Database contention between them is measured in L5.
- **Delay estimate:** the ≈ 14-minute release delay remains an estimate under normal conditions, never an SLA (§8.1). During a backlog the delay grows with backlog ÷ throughput.

### 8.10 Transaction safety and duplicate processing

Statuses below:
- **Design** — guaranteed by the documented design.
- **Verified (Phase 0 code)** — present in today's code (read-only, `orders.repository.ts` `cancelPendingGroup` / `findStalePendingGroupIds`).
- **IAC** — implementation acceptance criterion: depends on an implementation detail not yet built or verified; it must be shown by a test or code review before TD-18's implementation is accepted (criterion 66).

No field or schema element is added here; the target names are those already in `02`.

| # | Guarantee | How it holds | Status | Test |
|---|---|---|---|---|
| 1 | The reservation state change and the stock release are atomic | one PostgreSQL transaction per group: guarded `ACTIVE → RELEASED`, the `RELEASE` movement and the balance change commit together or not at all | Phase 0 verified: order `PENDING → CANCELLED` and the `stockQuantity` increment run in one Serializable `$transaction`; target: IAC | AT-MNT-14 |
| 2 | Stock is never released twice | the guarded update (`WHERE status = 'ACTIVE'`) changes 0 rows if already released, and the unique `release:<reservationId>` movement key refuses a second movement | Phase 0 verified: restock only when the guarded `updateMany` moved exactly 1 row; target unique key: IAC (schema at Phase 1, `02`) | AT-MNT-03, AT-MNT-08, C-MNT1 |
| 3 | Concurrent workers cannot process the same group incorrectly | `FOR UPDATE SKIP LOCKED` on the group, then the guarded update; target isolation READ COMMITTED with bounded retry of 40001 / 40P01 and per-transaction `lock_timeout` / `statement_timeout` (comparison in `22` §5.3). **R0 keeps Serializable**, and the switch is a separate reviewed change after the `23` §11.3 suite | Phase 0: **not** present — today relies on Serializable isolation; a serialization failure is thrown, not retried, and aborts the whole run. Target: IAC (`SKIP LOCKED`, per-group error handling, `withRetryableTx`) | C-MNT1, C-MNT2, AT-MNT-15 |
| 4 | A crash before commit leaves no partial release | PostgreSQL rolls back an uncommitted transaction when the connection ends | design | AT-MNT-14, AT-MNT-18 |
| 5 | A crash after commit causes no duplicate release | the re-delivered job or next run finds the reservation RELEASED → guarded no-op, counted as skipped | design | AT-MNT-03, AT-MNT-06 |
| 6 | Retried or duplicated jobs are idempotent | empty payload; every decision re-read from PostgreSQL inside the transaction | Phase 0 verified (`data: {}`); payload ignored: IAC | AT-MNT-09 |
| 7 | Manual and scheduled execution cannot conflict | the manual command calls the **same** service method with the same transaction and locks (no second code path), so it behaves like an overlapping run | IAC (single code path) | C-MNT1 |
| 8 | Reservations handed to the courier are never released by expiry | the candidate query and the guarded update both require `status = 'ACTIVE'`; handover moves them to FULFILLED (§3.3, invariant 16) | Phase 0 verified: candidates are only groups whose orders are **all** PENDING (a SHIPPED / PAID / FULFILLED order excludes the group), and the guarded update requires PENDING; target: IAC | AT-DSP-02, AT-MNT-05, AT-MNT-09 |
| 9 | Returned stock stays quarantined until authorized inspection | expiry writes only `RELEASE` movements for ACTIVE reservations; returned units enter `quarantined` on receipt and leave it only through inspection (DSP-02, DSP-03) | IAC: code review / test that the expiry path writes no other movement type | AT-DSP-03, AT-MNT-05 |
| 10 | Expiry never releases inventory already handed over | dispatched units already left `on_hand` (`SHIPMENT_OUT`) and their reservations are FULFILLED, so there is nothing ACTIVE to release | design (as 8) | AT-DSP-02 |
| 11 | Deadlines are never extended and nothing is released early | the candidate query and re-validation use the database clock (`expires_at <= now()`); no maintenance path writes a deadline | IAC (code review) | AT-MNT-02, AT-MNT-07, AT-MNT-10 |
| 12 | One failing group cannot block other groups (no head-of-line blocking) | per-group error handling + keyset continuation within a run (`(deadline, id) > last attempted`), so a failing group is attempted once per run and newer groups are still processed (`22` §5.1, §5.2) | Phase 0: **not** present — candidates are oldest first and the first failure aborts the run, so a group that always fails blocks every later expiry. Target: IAC | AT-MNT-15 |

## 9. Reservation and the immutable price snapshot

- Reservation and snapshot are written in the **same transaction**; neither exists without the other.
- The payment amount checked at proof review, Paymob verification or COD collection is the **snapshot total**, never a recomputed price.
- Releasing, expiring or cancelling never changes the snapshot; a cancelled order keeps it for audit and for any refund.
- Re-reservation after a late approval (BD-18 earlier rule) or a revived late payment (BD-17) uses the **original snapshot** prices; if stock is gone → refund (`03` §6.3). Nothing is ever repriced after order creation (`20` §2).

## 10. Requirements (`08` §8)

| ID | Requirement |
|---|---|
| RSV-01 | Add-to-cart and cart edits never reserve stock |
| RSV-02 | Reservation happens only in the checkout transaction, atomically with the snapshot; all lines or none |
| RSV-03 | Each payment method has the reservation lifetime of §3; deadlines are stored DB timestamps |
| RSV-04 | A proof is accepted only if submitted by its deadline (judged under the group lock), regardless of when expiry runs |
| RSV-05 | A timely proof keeps the reservation active until reviewed (pending BD-18) |
| RSV-06 | COD has no prepaid deadline; only the confirmation-call window can release it before confirmation |
| RSV-07 | Release happens once, in one transaction with the cancellation, and never for a paid, under-review or live-payment group |
| RSV-08 | A late Paymob success is never lost and never fulfils a cancelled order (refund unless BD-17 decides otherwise) |
| RSV-09 | Missed maintenance runs never release wrongly or extend deadlines; sweep-before-reserve prevents abandoned orders blocking new ones; scheduled maintenance (MNT-01 – MNT-06) is mandatory |
| RSV-10 | The snapshot is never changed by reservation events; re-reservation uses the snapshot price |
| DSP-01 | Units handed to the courier are removed from `on_hand` and `reserved` in the handover transaction and are never available while in courier custody |
| DSP-02 | Dispatched units return to available only through physical receipt into quarantine and an authorized `ACCEPTED_RESTOCK` inspection |
| DSP-03 | The courier's role is transportation and custody only — no courier inspection or condition approval |
| MNT-01 – MNT-06 | Scheduled maintenance responsibility, database as source of truth, idempotent release, catch-up after missed runs, run records, monitoring and alerts (§8) |
| MNT-07 – MNT-18 | BullMQ scheduling with an empty payload on the existing job (every 10 min), worker crash / Redis recovery, worker concurrency safety, PostgreSQL-based monitoring, schedule reconciliation, Redis production configuration, Redis-independent manual command, bounded queue retention, `MaintenanceRun` retention independent of BullMQ, queue failure isolation in a shared process, worker lifecycle and supervision, measured throughput (§8.1 – §8.10; TD-18 / TD-23 proposals) |
