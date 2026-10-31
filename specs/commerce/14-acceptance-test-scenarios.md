# 14 — Acceptance Test Scenarios

> Status: **DRAFT for review** · 2026-10-25 (gap-closure pass). Scenario ids are stable and referenced from `08` §8 (requirements) and `10` (criteria 41–52, phase exits, PRG gate). Nothing here is implemented.

**Rules for every scenario**
- Runs on **real PostgreSQL** (`riven_test`, or the rehearsal snapshot `riven_snapshot_test`). Mocked Prisma, SQLite or in-memory databases **never** count as proof of concurrency or database-enforced behaviour (TD-01 condition). Unit tests with mocks may exist *in addition*.
- After every scenario the invariants of `05` §5 (1–15) are queried with SQL; "Invariants" below lists the ones the scenario specifically stresses.
- Scenarios that depend on a pending decision are written against the **recommended default**, parameterized by configuration, and re-run when the decision is approved; they are marked *(pending X)*.
- Time-dependent scenarios use a controllable clock for the application and `now()`-relative fixtures in the database.

Columns: **Initial** state · **Operations** (concurrent where marked ∥) · **Expected** final state · **Invariants** (`05` §5) · **Ledger** effect · **Inventory** effect · **Proves**.

## A. Outbox (AT-OB)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-OB-01 | empty outbox; one product in stock | checkout commits; race hook kills the instance **after commit, before inline processing**; instance restarts | `order_group.placed` event + one delivery per consumer exist; boot sweep processes them; notification row exactly once | 13 | none | reservation committed before the crash, unchanged | OBX-01, OBX-04, C-O1 |
| AT-OB-02 | one PENDING delivery | inline attempt; consumer throws a retryable error | delivery back to PENDING, `attempts = 1`, `availableAt` = now + 1 s, `lastError` set; event row intact; next drain → PROCESSED | 13 | none | none | OBX-02 |
| AT-OB-03 | one PROCESSED delivery with its `processed_events` row | test forces the consumer to run again for the same event (replay) | `processed_events` conflict → no second effect; one notification | 13 | none | none | OBX-07 |
| AT-OB-04 | 500 due deliveries | two instances' claim loops ∥ | each delivery claimed by one instance at a time; all PROCESSED; each effect once | 13 | none | none | OBX-03, C-O3 |
| AT-OB-05 | push consumer, fake provider that times out | delivery processed; provider times out after accepting | effect row PENDING; after the send timeout: resent once (push is duplicate-tolerant); a non-tolerant fake effect is **not** resent and is escalated (DEAD with reason) | 13 | none | none | OBX-07 |
| AT-OB-06 | 20 PENDING + 5 PROCESSING (lease owner = old instance) | "deploy": old instance stopped, new instance boots; clock advances past the lease; scheduled drain runs | boot sweep processes the 20 at once; the 5 are reclaimed after lease expiry by the scheduled drain; none lost, none doubled | 13 | none | none | OBX-04, OBX-05 |
| AT-OB-07 | delivery claimed by A | A paused past its lease (race hook) ∥ B claims and completes; A resumes | B: PROCESSED; A's guarded completion updates 0 rows and rolls back; effect once; `attempts = 2` | 13 | none | none | OBX-03, C-O4 |
| AT-OB-08 | one poison delivery among 100 | drains with a controlled clock through the retry schedule | poison → DEAD (schema error: immediately; retryable error: after 10 attempts); 99 PROCESSED; DEAD metric = 1, alert raised | 13 | none | none | OBX-06, C-O2 |
| AT-OB-09 | one DEAD delivery | (a) admin without PLATFORM_OPERATOR calls drain / requeue; (b) PLATFORM_OPERATOR requeues with reason; (c) route enumeration looks for any delete/edit route | (a) 403; (b) PENDING, audit row with reason; (c) none exists | 8, 13 | none | none | OBX-09, AT-SEC-01 |
| AT-OB-10 | consumer registry | static test compares registry with the allow-list of `01` §7.8; consumer modules' imports checked (no ledger, inventory, payment, refund, settlement services) | identical; any new consumer touching money/stock fails CI until a TD decision adds it | — | — | — | OBX-08 |

## B. Inventory (AT-INV)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-INV-01 | Phase 1b; vendor premises `on_hand` 10 (`sellable=false`); RIVEN 0 | cart add 1; checkout; test-only SQL inserting a reservation at the premises balance | cart 400 `INSUFFICIENT_STOCK` (stock 0); checkout 400 `CHECKOUT_ITEM_UNAVAILABLE`; SQL insert raises (`stock_reservations_sellable_only`) | 1, 14 | none | unchanged | INV-01, INV-02 |
| AT-INV-02 | intake RECEIVED with accepted 5, not VERIFIED | checkout 1 | 400 unavailable; available 0 | 14 | none | `on_hand` RIVEN 0 | INV-01 |
| AT-INV-03 | intake verified: accepted 2, damaged 3 | checkout 3 | 400 unavailable; checkout 2 succeeds | 1, 14 | none | `on_hand` 2 → reserved 2; `damaged` 3 untouched | INV-05 |
| AT-INV-04 | vendor disputes an intake line claiming 2 more; a return line inspected DISPUTED | checkout of those units | only accepted units reservable; disputed claim and DISPUTED return stay non-reservable until resolution rows exist | 1, 14 | none | `quarantined` unchanged | INV-05 |
| AT-INV-05 *(pending BD-24)* | intake VERIFIED; vendor has not responded | checkout under BD-24 (a) and (b) configurations | (a) purchasable after VERIFIED; (b) purchasable only after ACKNOWLEDGED / DEEMED_ACKNOWLEDGED | 14 | none | INTAKE_ACCEPTED movement timing per option | INV-01 |
| AT-INV-06 | 1 unit available | two shoppers' checkouts ∥ | one group; loser 400; reserved 1; available 0 | 1, 2 | none | reserved +1 once | INV-04, C-A |
| AT-INV-07 | variant with 3 available | (a) cart PATCH quantity 5; (b) stale cart line of 5 then checkout; (c) checkout body with extra price/quantity fields; (d) vendor PATCH variant `stockQuantity`; (e) vendor stock endpoint aimed at a RIVEN balance; (f) Phase 1b test-only `UPDATE product_variants SET "stockQuantity"=99`; (g) admin product edit with a stock field | (a) 400 `INSUFFICIENT_STOCK`; (b) 400 unavailable, nothing created; (c) 400 (whitelist); (d) 400 `USE_STOCK_ENDPOINT`; (e) impossible — endpoint resolves the vendor's premises balance only; (f) trigger raises; (g) 400 (field not allowed) | 1, 14 | none | unchanged | INV-03, INV-04, INV-09 |
| AT-INV-08 | group PLACED, 2 units reserved | shopper cancel ∥ admin cancel ∥ expiry | one effective cancel; reserved −2 once; one RELEASE movement per item | 1, 2 | none (nothing posted before payment) | reserved −2 exactly once | INV-06, C-10, C-D1 |
| AT-INV-09 | delivered item; return approved | return shipment RECEIVED; then inspection ACCEPTED_RESTOCK on 1 unit, DISPUTED on 1 unit | after RECEIVED: `quarantined` +2, available unchanged; after inspection: `on_hand` +1 (available +1), 1 stays quarantined | 1, 14 | none until a refund is approved | as stated | INV-08, RET-04 |
| AT-INV-10 | existing variants with `stockQuantity` 7 (vendor-typed) | run Phase 0 opening movements, 1a backfill, 1b cutover on the rehearsal snapshot | movements `origin = VENDOR_DECLARED`; premises balances 7; `stockQuantity` 0 after cutover; checkout 400 | 2, 14 | none | premises 7, RIVEN 0 | INV-07 |
| AT-INV-11 | premises balance 7 | enumerate every inventory-service write path (property test over movement types) | no path increments RIVEN `on_hand` from a premises balance; only INTAKE_ACCEPTED, inspected RESTOCK, approved STOCKTAKE/ADJUSTMENT, approved INTAKE_CORRECTION do | 2 | none | — | INV-07 |
| AT-INV-13 *(pending TD-08, BD-08)* | RIVEN `on_hand` 10, reserved 3 | vendor requests +5; vendor requests −8 (WITHDRAW); INVENTORY proposes, FINANCE_APPROVER approves; then a −7 request approved ∥ a checkout reserving 1 | +5 refused at submission (decrease-only); −8 refused at apply (409 `ADJUSTMENT_BELOW_RESERVED`); −7 applies once; the race leaves `on_hand ≥ reserved` | 1, 2 | none | ADJUSTMENT movement `origin = RIVEN_VERIFIED`, `sourceType = ADJUSTMENT_REQUEST` | INV-10 |
| AT-INV-12 | premises 7, RIVEN 0 | vendor intake declared 7 → received 7 → accepted 6, damaged 1 → verified | RIVEN `on_hand` 6 (sellable), `damaged` 1; premises balance unchanged (declared count) | 1, 2, 14 | none | as stated | INV-07, INV-01 |

## B2. Inventory intake MVP (AT-INV-14 – AT-INV-33; v7, `19`)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-INV-14 | intake line requested 10 | OPS records physically received 7 | `missingQuantity` 3; `discrepancyAckStatus` ACK_REQUIRED; handover discrepancy created; nothing sellable | 14 | none | none | INT-01, INT-02, HND-01 |
| AT-INV-15 | received 7: accepted 6, damaged 1, missing 3, inspection COMPLETED | admin approves the line | line APPROVED (admin + time); **6** posted; other lines and discrepancies unaffected | 1, 2 | none | RIVEN `on_hand` +6 (`INTAKE_ACCEPTED`), `damaged` +1 | INT-04, INT-06 |
| AT-INV-16 | received 7 | inspection records accepted 6, damaged 2; then accepted 5, damaged 1, rejected 1 with reason, damage description + photo, counting report for the missing 3 | first refused (identity CHECK); second accepted; evidence rules satisfied | — | none | none | INT-03, INT-09 |
| AT-INV-17 | line A pending inspection 2; line B COMPLETED | approve A; approve B | A 409 `INSPECTION_INCOMPLETE`; B approved and posted; A's units unavailable | 14 | none | B only | INT-01, INT-04 |
| AT-INV-18 | received 5 | inspection with rejected 1 and no reason | 409 `REJECTION_REASON_REQUIRED`; nothing saved | — | none | none | INT-09 |
| AT-INV-19 | — | vendor submits the same intake twice with the same `Idempotency-Key` | one intake; second returns it | — | none | none | INT-14 |
| AT-INV-20 | intake X exists | vendor submits a new intake with a new key | a second intake is created | — | none | none | INT-14 |
| AT-INV-21 | line COMPLETED | two admins approve ∥ | one APPROVED; other 409 `INTAKE_LINE_ALREADY_DECIDED` with the current state | 1, 2 | none | posted once | INT-05, C-IN4 |
| AT-INV-22 | line APPROVED and posted | the approval request is retried (network retry) | no second movement (unique `sourceEventKey`); 409 or idempotent replay | 2 | none | unchanged | INT-06 |
| AT-INV-23 | line APPROVED, 6 posted; recount finds 5 | admin requests and approves an adjustment −1 with reason and evidence | new `ADJUSTMENT` movement referencing intake, line and original movement; previous 6, delta −1, result 5; original line and movement unchanged (trigger) | 2 | none | `on_hand` −1 | INT-07 |
| AT-INV-24 | `on_hand` 6, reserved 5, held 0 | adjustment −2 | 409 `ADJUSTMENT_BELOW_COMMITTED`; no order cancelled | 1 | none | unchanged | INT-08 |
| AT-INV-25 | line APPROVED, accepted 6, available 6 | vendor disputes 2 **accepted** units (wrong variant) | dispute SUBMITTED; hold of 2 (`held` +2); accepted and on-hand unchanged | 1, 14 | none | available −2 (held) | INT-11, INT-12 |
| AT-INV-26 | line with missing 3 | vendor disputes the missing 3 ("we sent 10") | dispute SUBMITTED; **no** hold; no balance change | 14 | none | none | INT-11 |
| AT-INV-27 | accepted-category dispute of 2, hold 2 | admin resolves PARTIALLY_RESOLVED: 1 unit moved to the correct variant by an approved adjustment, 1 confirmed | adjustment movements once; hold released (`held` −2); history intact; vendor payable untouched | 1, 2 | **none** | per adjustment | INT-13 |
| AT-INV-28 | accepted 6, 2 held by a dispute | shopper tries to buy 6 | at most 4 reservable; checkout of 5+ → 400 unavailable | 1, 14 | none | reserved ≤ 4 | INT-12 |
| AT-INV-29 | as AT-INV-28 | shopper buys 4 | succeeds | 1 | none | reserved 4 | INT-12 |
| AT-INV-30 | vendors A and B with intakes | A requests B's intake, line, evidence and dispute ids | 404 on every route | — | — | — | INT-10, C-VP1 |
| AT-INV-31 | line with an INTERNAL note and INTERNAL evidence | vendor reads the intake; requests the evidence signed URL | internal items absent; signed URL refused (404) | — | — | — | INT-10 |
| AT-INV-32 | line COMPLETED | fault injected at the audit insert during approval | whole transaction rolled back: line NOT_REVIEWED, no movement, balance unchanged, no outbox row | 1, 2, 8 | none | unchanged | INT-06 |
| AT-INV-33 | full intake with discrepancy, dispute and adjustment | read the audit trail and history | one audit row per step (submit, receive, inspect, approve, acknowledge, dispute, resolve, adjust) with actor, time, before / after; original counts visible next to corrections | 8 | none | — | INT-07 |

## B3. Handover discrepancies and withdrawals (AT-HND; v7, `19` §10)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-HND-01 | requested 100 | received 100 | `NOT_REQUIRED`; no acknowledgment step; normal inspection | — | none | none | HND-01 |
| AT-HND-02 | requested 100 | received 98; vendor acknowledges | discrepancy 2 INBOUND_INTAKE with both numbers; NE-53 sent; ACKNOWLEDGED with vendor and time; line approval was not blocked by the pending acknowledgment | — | none | per approval | HND-01, HND-02 |
| AT-HND-03 | discrepancy ACKNOWLEDGED | admin resolves with reason | RESOLVED with actor and time; no inventory change unless a separate adjustment; acknowledgment not recorded as liability | — | none | none | HND-03 |
| AT-HND-04 | withdrawal requested today | admin tries to process before 4 days | 409 `WITHDRAWAL_NOTICE_PERIOD`; allowed from `earliestProcessingAt` | — | none | none | HND-04 |
| AT-HND-05 | `on_hand` 10, reserved 4 | authorize 8; then authorize 6 | 8 refused (> available 6); 6 authorized → hold 6; checkout cannot take held units | 1 | none | `held` +6 | HND-04 |
| AT-HND-06 | authorized 50 | Riven dispatches 50; vendor records 48; vendor then tries to edit the dispatched quantity | discrepancy 2 OUTBOUND_WITHDRAWAL; both numbers kept; dispatched unchanged (403 / 409); admin sees it | — | none | `on_hand` −50 (once), hold released | HND-02, HND-05 |
| AT-HND-07 | dispatched 50 | vendor records 50; a customer return exists for the same variant | withdrawal closed, no acknowledgment; return untouched | — | none | — | HND-05 |
| AT-HND-08 | any discrepancy | inspect courier steps and settlement | no courier acknowledgment / inspection required; vendor payable and payouts unchanged | — | none | — | HND-06 |
| AT-HND-09 | withdrawal line dispatched 50 | vendor records 48; INVENTORY admin acknowledges; admin resolves with a reason; then anyone tries to change 50 or 48 (API and test-only SQL) | discrepancy 2 with both numbers; Riven acknowledgment recorded once (actor, time); resolution recorded separately; both quantities unchanged (trigger raises); no inventory, payable or settlement change without a separate adjustment | — | none | −50 once | HND-02, HND-03, HND-05 |

## C5. Checkout reservation and payment expiry (AT-RSV; v7 Part Four, `21`) *(windows pending BD-07, BD-13, BD-18, BD-19)*

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-RSV-01 | available 1 | two shoppers add it to their carts | both carts accepted; nothing reserved; available still 1 | 1 | none | none | RSV-01 |
| AT-RSV-02 | cart with lines A (stock ok) and B (short) | checkout | 400 `CHECKOUT_ITEM_UNAVAILABLE` naming B; no order, snapshot, reservation or payment attempt | 1, 2 | none | unchanged | RSV-02 |
| AT-RSV-03 | stock ok | TRANSFER checkout | order + snapshot + reservations + attempt in one commit; `expiresAt = createdAt + 30 min` (configured proposal) | 1, 2, 10 | none | reserved += q | RSV-02, RSV-03 |
| AT-RSV-04 | TRANSFER order, 29 min old | submit proof | accepted; reservation stays ACTIVE past the 30 min while the proof is SUBMITTED / UNDER_REVIEW | 4 | none | unchanged | RSV-04, RSV-05 |
| AT-RSV-05 | TRANSFER order, 31 min old, maintenance not yet run | submit proof | 409 `PROOF_WINDOW_CLOSED`; the next expiry run releases the stock once | 1, 2 | none | released once | RSV-04, RSV-09 |
| AT-RSV-06 | proof UNDER_REVIEW for longer than the review SLA | expiry paths run | no release; escalation flag / NE-43; reservation ACTIVE | — | none | unchanged | RSV-05 |
| AT-RSV-07 | proof rejected NEEDS_CORRECTION | no resubmission within the resubmission window | release once; group CANCELLED (EXPIRED_NO_PROOF); NE-06 | 1, 2 | none | released | RSV-07 |
| AT-RSV-08 | proof rejected FRAUDULENT | — | immediate release; claim REJECTED | 1, 2 | none | released | RSV-07 |
| AT-RSV-09 | COD order | 48 h pass before the confirmation call outcome is CONFIRMED within the window | no payment deadline; after CONFIRMED the reservation is CONFIRMED with no expiry | 1 | none | reserved | RSV-06 |
| AT-RSV-10 | COD order | confirmation outcome UNREACHABLE | release once; group CANCELLED (COD_UNREACHABLE) | 1, 2 | none | released | RSV-06, RSV-07 |
| AT-RSV-11 | PAYMOB (non-production), no webhook | grace and cap pass; later a signed success arrives | release at cap; later success → attempt SUCCEEDED + `LATE_PAYMENT` exception; group stays CANCELLED | 3 | Dr PAYMOB_CLEARING / Cr CUSTOMER_REFUND_PAYABLE | released once, never re-reserved automatically | RSV-08 |
| AT-RSV-12 | abandoned TRANSFER order past its deadline holding the last unit; no maintenance run | another shopper checks out the same variant | sweep-before-reserve releases the overdue reservation first; the new checkout succeeds | 1, 2 | none | released then reserved | RSV-09 |
| AT-RSV-13 | expired and released order | read the order | snapshot unchanged (prices, delivery fee, total) | 10 | none | — | RSV-10 |
| AT-RSV-14 | proof approved after an earlier release (only if Ibrahim keeps the release-at-cap rule, BD-18) | approve | re-reserve at the **snapshot** price; if stock is gone → `STOCK_UNAVAILABLE` exception and refund; never repriced | 3, 15 | refund path if needed | re-reserved or none | RSV-10 |

## C6. Dispatched stock, scheduled maintenance, PAYMOB deferral (AT-DSP, AT-MNT, AT-PMA; 2026-10-27, `21` §3.3, §5, §8)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-DSP-01 | COD order CONFIRMED, 2 units reserved, `on_hand` 10 | courier handover with manifest | reservations FULFILLED; `on_hand` 8, `reserved` 0; available unchanged by the handover (it already excluded the reserved 2); `inTransit` 2 | 1, 2, 14 | none (COD collection later) | `SHIPMENT_OUT` −2 once | DSP-01 |
| AT-DSP-02 | units handed over | COD confirmation window lapses; maintenance run; admin cancel; shopper cancel | nothing released; cancel → 409; available unchanged | 1, 2 | none | unchanged | DSP-01 |
| AT-DSP-03 | COD shipment refused | parcel returned and received; then inspected ACCEPTED_RESTOCK 1, ACCEPTED_DAMAGED 1 | after receipt: `quarantined` +2, available unchanged; after inspection: available +1, damaged +1; courier never asked to inspect | 1, 14 | refusal postings per FD-08 | quarantine → per inspection | DSP-02, DSP-03 |
| AT-MNT-01 | abandoned TRANSFER order past its deadline; nobody opens it | scheduled run | released once by the run (not by any request); run record written | 1, 2 | none | released | MNT-01, MNT-02 |
| AT-MNT-02 | 1,200 overdue groups after a 6 h scheduler outage | next run | processed oldest first in bounded batches until none remain; every release once; no deadline extended | 1, 2 | none | released | MNT-04 |
| AT-MNT-03 | run crashes after 300 groups | next run | the 300 stay released (committed), the rest are released now; nothing doubled | 2 | none | released once | MNT-03, MNT-04 |
| AT-MNT-04 | evaluator running against PostgreSQL; each condition of `21` §8.6 A1 – A15 produced in turn (no successful run 25 min; FAILED run; 3 consecutive failures; run > 5 min; reservation overdue 30 min; backlog > 500 and not shrinking; a release-integrity violation in a test fixture; schedule recreated; worker stopped with Redis up; crash loop; Redis stopped; Redis memory / eviction; PostgreSQL stopped; reconciler failing; PARTIAL run) | health evaluation every minute; condition kept for 2 h, then removed | each condition raises **its own** alert with the severity of §8.6 (worker, Redis, PostgreSQL, missing schedule, backlog, processing failure and release failure distinguishable); one open alert per condition, re-notified at most every 60 min; alerts that auto-clear close at the next evaluation after the condition ends; A7 stays open until closed by the operator; PostgreSQL stopped → A13, never silence; **delivery:** each alert reaches its destination of `22` §4.4 (one test incident per severity received by the named owner), with its dedup key, and a recovery notification where the provider supports it; with PostgreSQL stopped, the external heartbeat (M1) and dependency monitor (M4) still raise an incident | — | — | — | MNT-06, MNT-10 |
| AT-MNT-05 | a group with a timely proof under review, a live PAYMOB attempt (non-production), a SUCCEEDED group and a group whose units were handed to the courier, all past `expiresAt`; returned units in `quarantined` for another variant | scheduled run; then the manual command | none of them released (guards of `21` §4, §3.3); `quarantined` unchanged; the expiry path wrote only `RELEASE` movements; run record counts them as skipped | 3, 4, 14, 16 | none | unchanged | MNT-02, RSV-07, DSP-01 |
| AT-MNT-06 *(TD-18 proposal)* | worker running with the scheduler; overdue groups exist | kill the worker mid-run and restart it; later flush Redis and restart the worker | after the kill: the stalled job is re-delivered (or the next tick runs), committed groups stay released, the rest are released once; after the flush: the scheduler is re-registered (boot or reconciler) and runs every 10 min again; one `MaintenanceRun` per execution incl. the failed one | 1, 2 | none | released once | MNT-07, MNT-08 |
| AT-MNT-07 | worker and Redis down for 2 h; 300 groups became overdue | services restored | the PostgreSQL-based alert fired during the outage (no successful run for 25 min, backlog); the first run catches up in bounded batches; no deadline extended | 1, 2 | none | released once | MNT-08, MNT-10 |
| AT-MNT-08 | two worker processes started by mistake (or a slow run overlaps the next tick) | both run | each group processed by one transaction at a time (`SKIP LOCKED`); every reservation released once; one movement per release | 2 | none | released once | MNT-09, C-MNT2 |
| AT-MNT-09 | a job is enqueued manually with a payload listing a reservation id that is not yet overdue / already FULFILLED | worker runs it | payload ignored; that reservation untouched; only database-eligible groups released | 1, 16 | none | unchanged for the listed id | MNT-02, MNT-07 |
| AT-MNT-10 *(TD-18)* | scheduler registered; reservations expiring over 1 h | observe | one execution every 10 min (`*/10 * * * *`), one `MaintenanceRun` each; each reservation released by the first run that starts after its deadline, never before (in these healthy conditions normally within ~14 min — an estimate, not asserted as an SLA); completed / failed job records in Redis stay within the retention limits of `21` §8.3.1 | 1, 2 | none | released once | MNT-01, MNT-07, MNT-14 |
| AT-MNT-11 | Redis stopped for 40 min with overdue reservations accumulating | during the outage: health check and manual `expire-overdue`; then restart Redis | PostgreSQL alert "no successful run for 25 min" fires together with A11 (Redis unavailable), not A9; the worker process stays up (no crash, no restart) and its connection reconnects by itself; the manual command works without Redis and releases overdue stock; after restart the reconciler re-establishes the schedule automatically; the next run finds nothing already released and processes the rest; no deadline extended | 1, 2 | none | released once | MNT-10, MNT-11, MNT-12, MNT-13 |
| AT-MNT-12 | worker running; (a) the scheduler entry is deleted from Redis (simulating data loss) without restarting anything; (b) the scheduler entry is kept but its next pending job is deleted (partial data loss) | wait ≤ 60 s each time | in both cases the reconciler recreates the scheduler with the same id and pattern (case b detected by the `next` time check, `21` §8.2.1); "schedule recreated" alert; runs resume; never two schedulers | — | none | — | MNT-11 |
| AT-MNT-13 | three API / worker instances start together after a FLUSHALL | all reconcile at once | exactly one scheduler `expire-pending-checkouts-scheduler` exists; no duplicate executions per tick | — | none | — | MNT-11, C-MNT3 |
| AT-MNT-14 | overdue group G | fault injected inside G's release transaction (after the guarded update, before commit) | G's transaction rolls back completely (reservation ACTIVE, no movement, no audit, no outbox); the run continues with other groups and records G as failed; the next run releases G once | 1, 2, 8 | none | released once, next run | MNT-03 |
| AT-MNT-15 | batch of 500 overdue groups, 3 of them failing (e.g. lock timeout), one of the 3 being the **oldest** group and failing on every attempt | run; then two more runs | 497 released; run status PARTIAL with `failed = 3` and the error; each failing group attempted **once** per run (keyset continuation); the always-failing oldest group never blocks newer groups (no head-of-line blocking) and raises A15 P1 after 3 runs; the 2 transient failures are released by the next run; nothing partially released; `MaintenanceRun` totals add up | 1, 2 | none | 497 now, 3 later | MNT-04, MNT-05 |
| AT-MNT-16 *(TD-23)* | shared worker process (TD-23 MVP option) hosting the `orders` queue (expiry job + schedule reconciler), the `outbox` queue and the `reconciliation` queue; 1,000 overdue groups; 200 due outbox deliveries | for 30 min: (a) a fault hook makes every schedule-reconciler check throw (Redis itself healthy); (b) one `reconciliation` job fails on every attempt and 50 more are queued; active job counts per queue sampled every second; then remove the faults | expiry runs continue on the existing schedule and release the 1,000 groups across runs within their budgets; outbox drain runs on every 5-min tick and processes all due deliveries (`MaintenanceRun` `OUTBOX_DRAIN` SUCCEEDED; oldest-pending age below its alert); sampled active counts never exceed each queue's limit (1); the reconciliation backlog stays in its own queue (waiting / delayed counts of `orders` and `outbox` unaffected); retries wait in `delayed` holding no slot; never more than one reconciler call in flight; no stalled jobs in `orders` or `outbox`; failures recorded only in their own records (reconciler counter / log, failed `ReconciliationRun`, BullMQ failed set) while A1 – A6 and the outbox alerts stay clear; after the faults are removed the reconciler succeeds within 60 s and the reconciliation queue drains. *Shows queue- and worker-level isolation under these injected faults only; not process-level isolation (crash, out-of-memory — AT-MNT-18) nor reliability under every production failure* | 1, 2, 13 | none | released once | MNT-16, OBX-05 |
| AT-MNT-17 | 200 completed and 20 finally failed expiry jobs, each with its `MaintenanceRun` row; one `reconciliation` job between attempts | in order, checking after each step: (a) completed-job cleanup — more jobs complete, past both the count and the age limit; (b) failed-job cleanup — more jobs fail; (c) the retrying job reaches its next attempt; (d) queue wipe (`obliterate`) in staging; (e) full Redis data loss (FLUSHALL, and a restart without persistence) | (a) completed set ≤ 100 (count), aged jobs removed when the next job completes; (b) failed set ≤ 1,000; (c) the retrying job is not removed before its final attempt; (d), (e) all job records gone; after **every** step all 220 `MaintenanceRun` rows are present and unchanged (status, counts, `error`, `jobId`); FAILED runs fully inspectable from PostgreSQL; no code path deletes or updates `maintenance_runs` (code search) | — | none | none | MNT-14, MNT-15 |
| AT-MNT-18 *(TD-18, TD-22)* | worker running under the chosen host's supervisor; overdue groups exist | (a) SIGKILL the worker while idle; (b) SIGKILL it mid-run after 100 groups; (c) make it crash on start 3 times in a row | (a), (b): the host restarts it without an operator (time to restart measured and recorded); boot reconciliation runs; the stale RUNNING row is closed as FAILED; the interrupted job is re-delivered once or the next tick runs; the 100 committed groups stay released, the rest released once; (c) A10 (crash loop) fires; A9 fires while it is down; no group partially released | 1, 2 | none | released once | MNT-17, MNT-08 |
| AT-MNT-19 *(TD-18)* | run in progress with 2,000 overdue groups | (a) SIGTERM the worker (as a deploy does); (b) rolling deploy: new worker version starts while the old one finishes, then the old one stops | (a) no new group starts after SIGTERM; the current group commits; the run is closed PARTIAL with error `shutdown`; the process exits within the host's grace period (measured); the next run continues; (b) old and new overlap safely (each group released once); exactly one scheduler with the new pattern after the old instance stops; no pattern flapping between versions | 1, 2 | none | released once | MNT-17 |
| AT-MNT-20 *(TD-18)* | worker and Redis running; overdue groups accumulate | stop PostgreSQL for 15 min, then start it | during the outage: runs fail and are logged, with BullMQ failed-set records; no `MaintenanceRun` row can be written; A13 fires (A1 is not silently skipped); the worker process stays up; after recovery: Prisma reconnects without a restart; the next run catches up; no partial group; no deadline extended | 1, 2 | none | released once | MNT-17, MNT-10 |
| AT-MNT-21 *(load test, `21` §8.9)* | rehearsal snapshot on production-like hardware; datasets L1 – L7 (500, 1,000, 5,000, 10,000; 5,000 + outbox / reconciliation load; restart mid-run; 6-hour outage catch-up) with ~10 % guarded-out and ~1 % failing groups | scheduled runs under the concurrent API traffic of §8.9 | all measurements of §8.9 recorded per run (throughput, duration, query p95, lock waits, deadlocks, memory, CPU, backlog, oldest overdue, skipped, failed, recovery time, API p95); pass criteria P1 – P8 of `22` §7 met, or the TD-18 values revised (and kept pending); no result is assumed before it is measured | 1, 2, 16 | none | released once | MNT-18, MNT-04 |
| AT-MNT-22 *(R0)* | overdue group G; a test connection holds `FOR UPDATE` on G's `order_groups` row | run N starts and reaches G; the test keeps the lock through run N + 1; then releases it; run N + 2 | runs N and N + 1: G skipped (`skipped` counted, no change to G, not retried within either run, other groups processed); run N + 2: G released exactly once (orders CANCELLED, one restock per variant, `released` counted); total restock for G equals its quantities; no run waits on the lock | 1, 2 | none | released once, after the lock is released | MNT-03, MNT-04 |
| AT-MNT-23 *(R0)* | 300 overdue groups; manual run A started by admin X (its HTTP request kept open or timed out by the client) | while A is RUNNING, admin X sends a second manual request B (different reason) | two `MaintenanceRun` rows, each RUNNING then final, each updated only by its own run (neither closed as stale, neither PARTIAL merely because of skips); `released_A + released_B = 300`; every group released exactly once (one restock per variant, no order changed twice); B's `skipped` = the groups it found locked or already released; two audit writes attempted with their own run ids and reasons; no 40001 escapes a run (retried); a third request beyond the throttle gets a coded 429 | 1, 2 | none | released once | MNT-03, MNT-05, MNT-13 |
| AT-PMA-01 | production configuration (`PAYMOB_*` unset) | `GET /checkout/options`; empty-body `POST /checkout` | PAYMOB not offered; unversioned behaviour unchanged (`paymentSetupFailed: true`); no Paymob intention created | — | none | — | PMA (deferral) |

## C4. Cart price changes and order snapshot (AT-CPR; v7, `20`)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-CPR-01 | vendor rate 500.00, 6 % | add to cart | baseline 530.00, UNCHANGED | — | none | none | CPR-01 |
| AT-CPR-02 | in cart at 530.00 | vendor rate → 600.00 | cart shows 636.00, CHANGED, increase from 530.00 | — | none | none | CPR-01, CPR-02 |
| AT-CPR-03 | in cart at 530.00 | vendor rate → 450.00 | 477.00, CHANGED, decrease | — | none | none | CPR-02 |
| AT-CPR-04 | CHANGED | open / reload the cart several times | still CHANGED; notice visible | — | none | none | CPR-03 |
| AT-CPR-05 | CHANGED at version v2 | acknowledge v2; then acknowledge a stale v1 | REVIEWED, baseline 636.00; stale → 409 `PRICE_CHANGED_AGAIN` | — | none | none | CPR-03 |
| AT-CPR-06 | REVIEWED at 636.00 | rate → 650.00 | CHANGED again, baseline 636.00 | — | none | none | CPR-02 |
| AT-CPR-07 | baseline 530.00 | rate 600 → 700 before acknowledgment | shows 742.00 vs baseline 530.00 (not 636.00) | — | none | none | CPR-02 |
| AT-CPR-08 | one item CHANGED | checkout | 409 `PRICE_CHANGED`; no order, no reservation, no payment attempt | 3 | none | none | CPR-04 |
| AT-CPR-09 | REVIEWED items | price change committed ∥ checkout (race hook after the cart lock) | either order at the reviewed price, or 409 `PRICE_CHANGED`; never a stale or mixed snapshot | 10 | none | reservation only if the order was created | CPR-05, C-PR3 |
| AT-CPR-10 | REVIEWED cart, 2 × 530.00 | checkout | snapshot per item: vendor 500.00, 600 bps, markup 30.00, unit 530.00, qty 2, EGP, `priceSnapshotAt`, version; group: items 1,060.00, delivery 80.00, total 1,140.00 | 10 | none at placement | reserved 2 | CPR-06, CPR-10 |
| AT-CPR-11 | order placed at 530.00 | vendor rate → 600.00 | order, items and totals unchanged (trigger) | 10 | none | none | CPR-06 |
| AT-CPR-12 | order total 1,140.00, payment failed | retry payment after a price change | attempt amount 1,140.00 | 3 | none | none | CPR-07 |
| AT-CPR-13 | — | checkout body carries `unitPrice: 1` or a forged total | 400 (whitelist) or 409 (`expectedTotalMinor` mismatch); prices from the server | — | none | none | CPR-08 |
| AT-CPR-14 | cart items total 1,060.00 | quote and checkout | delivery 80.00 shown separately; markup computed only on items (no markup on 80.00); total 1,140.00 | 10 | — | — | CPR-09 |
| AT-CPR-15 | three items, two change price | open cart; acknowledge one | both changed items flagged individually; checkout still blocked until the second is acknowledged | — | none | none | CPR-02, CPR-04 |

## C. Financial (AT-FIN)

Amounts in EGP; running example of `04` §7 unless stated.

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-FIN-01 | fixtures for every posting kind | post each; then test-only unbalanced insert | every journal balanced; unbalanced commit fails 23514 | 5 | balanced journals only | — | criterion 11, REC-04, C-L2 |
| AT-FIN-02 | PAYMOB attempt INITIATED (non-production config) | same signed success event ×10 ∥ | one SUCCEEDED, one journal, nine `duplicate` | 3, 5 | Dr PAYMOB_CLEARING 1,014.00 / Cr CUSTOMER_DEPOSITS once | reservations CONFIRMED once | C-B |
| AT-FIN-03 | attempt INITIATED | signed decline event | event stored; attempt FAILED; group PLACED; retry allowed until cap | 3, 4 | none | reserved until cap / release | R20 |
| AT-FIN-04 | group CANCELLED by expiry at the cap | late success event | attempt SUCCEEDED; `PaymentException(LATE_PAYMENT)` OPEN; group stays CANCELLED; `paidAt` NULL | 3 | Dr PAYMOB_CLEARING / Cr CUSTOMER_REFUND_PAYABLE 1,014.00 | none (released earlier) | C-F2, C-X1 |
| AT-FIN-05 | TRANSFER paid 1,014.00, not delivered; one item can no longer be supplied (BD-18) | refund 424.00 requested → approved (≠ maker) → executed with bank reference | refund COMPLETED; Σ refunds ≤ 1,014.00 | 5, 15 | Dr CUSTOMER_DEPOSITS 424.00 / Cr CUSTOMER_REFUND_PAYABLE; then Dr CUSTOMER_REFUND_PAYABLE / Cr BANK; **no** vendor payable or margin entries | that item's reservation released | RET-01 (exception path) |
| AT-FIN-06 | TRANSFER paid 1,014.00; group CONFIRMED, shipment PENDING | cancel after payment (FD-14) → refund full | group CANCELLED; refund COMPLETED | 3, 5, 15 | deposits → refund payable → bank (1,014.00); no payable / margin | reservations released once | `04` §7.9 |
| AT-FIN-07 | vendor V paid 15,000.00 (statement, settlement, payout CONFIRMED) | two items returned, inspected ACCEPTED_RESTOCK, refund approved under FD-19 (a) config, executed | V balance −1,000.00; next statement opening −1,000.00; earlier journals, statement and payout unchanged (trigger checks) | 5, 11, 15 | new reversal: Dr VENDOR_PAYABLE:V 1,000.00 · Dr RIVEN_PRODUCT_MARGIN 60.00 / Cr CUSTOMER_REFUND_PAYABLE 1,060.00; then refund paid | +2 to `on_hand` after inspection | RET-03, criterion 47, `04` §7.16 |
| AT-FIN-08 | payout SENT 30,000.00 | vendor RECEIVED_PARTIAL 28,000.00 (twice ∥) | one confirmation, one discrepancy 2,000.00 OPEN; payout row unchanged | 12 | none until resolution | — | C-PO2, criterion 38 |
| AT-FIN-09 *(pending FD-11)* | V balance −1,000.00 | (a) next month 3,000.00 delivered → settlement; (b) no sales → settlement attempt; (c) recovery by repayment; (d) write-off (maker FINANCE, checker FINANCE_APPROVER; maker approving own → refused) | (a) pays 2,000.00; (b) 409 `SETTLEMENT_NET_NOT_POSITIVE`; (c)/(d) balance 0 | 5, 6 | (a) netting through settlement lines; (c) Dr BANK / Cr VENDOR_PAYABLE 1,000.00; (d) Dr VENDOR_BALANCE_WRITE_OFF / Cr VENDOR_PAYABLE 1,000.00 | — | criterion 47 |
| AT-FIN-10 | — | same posting source by two transactions ∥; then same source with a different payload | one journal; second returns it; different payload → `LEDGER_SOURCE_CONFLICT` | 5 | one journal | — | C-L1, criterion 22 |
| AT-FIN-11 | test-only SQL creates a SUCCEEDED attempt for a CANCELLED group without an exception | run REC-CHK-03 twice | one `FinancialDiscrepancy` OPEN (second run does not duplicate); nothing corrected automatically | — | none | — | REC-01, REC-02, criterion 45 |
| AT-FIN-12 | COD shipment expecting 1,014.00 | delivery recorded with collected 900.00 | collection PARTIALLY_COLLECTED; `COD_SHORT_COLLECTION` exception; FINANCE investigates | 6 | Dr COURIER_RECEIVABLE / Cr CUSTOMER_DEPOSITS 900.00 | stock left at handover | FD-05, COU-03 |
| AT-FIN-13 | collection 1,014.00; courier statement deductions 55.14 | remittance received 1,000.00 | allocations 958.86 + deductions; excess 41.14 to unallocated cash | 6 | `04` §7.7 excess journal | — | `04` §7.7 |
| AT-FIN-14 *(pending FD-24)* | item delivered, vendor already paid | partial refund 100.00, approver chooses vendor share 100.00 (reason) ∥ a second approval attempt | one approval; split CHECK holds; V balance −100.00 | 5, 15 | Dr VENDOR_PAYABLE:V 100.00 / Cr CUSTOMER_REFUND_PAYABLE 100.00 (new journal) | none | FD-24, RET-03 |

## C2. Returns (AT-RET)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-RET-01 | delivered group | request → approve → physical return RECEIVED → inspection ACCEPTED_RESTOCK | **no Refund row, no refund journal** exists; refund only when FINANCE requests it from the inspection | 15 | none | quarantine → on_hand per inspection | RET-01 |
| AT-RET-02 | request REQUESTED | SUPPORT rejects | no return shipment, no stock, no money | — | none | none | RET-01 |
| AT-RET-03 | return RECEIVED | inspection REJECTED_RETURN_TO_CUSTOMER; FINANCE tries to request a refund citing it | refund request 409 `REFUND_SOURCE_INVALID`; goods leave quarantine back to the customer | 15 | none | `quarantined` −q | RET-01 |
| AT-RET-04 | return RECEIVED | inspection DISPUTED; refund request; then re-inspection ACCEPTED_DAMAGED (new row) | refund blocked until the new row; original row unchanged | 15 | none until approval | quarantined → damaged | RET-01, INV-05 |
| AT-RET-05 | refund REQUESTED by maker M | M approves; then approver A approves | M refused (CHECK / 403); A approves; reversal journal per FD-19 config; delivery journal untouched | 5, 15 | `04` §7.10 option per config | — | RET-01, RET-03 |
| AT-RET-06 | refund APPROVED | execute → bank bounce → FAILED → retry → COMPLETED | one REFUND_PAID journal; no automatic resend after FAILED | 5, 15 | refund payable → bank once | — | `03` §10 |
| AT-RET-07 | production configuration (`RETURNS_ENABLED=false`) | shopper POST return; exception refund flow | return 403 `RETURNS_NOT_AVAILABLE`; exception refund works | — | — | — | RET-02 |

## C3. Refund destinations (AT-RFD; v6, `15`) *(pending FD-26, SD-10)*

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-RFD-01 | InstaPay TRANSFER approved; overpayment refund REQUESTED | system pre-fills the original sender; FINANCE verifies against the original transaction; approver approves; FINANCE executes with reference + proof | COMPLETED to the original sender; snapshot frozen; NE-24 sent | 15 | refund payable → bank once | none | RFD-01, RFD-05 |
| AT-RFD-02 | COD group refunded after collection; no original instrument | customer submits a wallet whose holder name differs from the account name | destination REJECTED (name mismatch); refund stays AWAITING_DESTINATION; nothing sent | 15 | none | none | RFD-02 |
| AT-RFD-03 | refund APPROVED with destination D1 | customer submits D2 | D2 verified → refund back to UNDER_REVIEW; **new approval required**; D1 snapshot preserved in history | 15 | approval journal unchanged; no second liability | none | RFD-03 |
| AT-RFD-04 | refund PROCESSING | customer tries to change the destination ∥ FINANCE completes | change refused 409 `REFUND_DESTINATION_LOCKED`; completion succeeds | 15 | one `REFUND_PAID` | none | RFD-03 |
| AT-RFD-05 | customer-provided destination verified, cooling-off running | attacker session submits a new destination; FINANCE tries to approve before `usableFrom` | security notice NE-26 to all contacts; approval refused 409 `REFUND_DESTINATION_COOLING_OFF` | — | none | none | RFD-04 |
| AT-RFD-06 | refund COMPLETED | bank returns the transfer; FINANCE records RETURNED_BY_BANK (maker), approver confirms | refund AWAITING_DESTINATION; `refundedMinor` reduced; no automatic re-send | 15 | Dr BANK / Cr CUSTOMER_REFUND_PAYABLE (new journal) | none | RFD-06 |
| AT-RFD-07 | refund AWAITING_DESTINATION for 31 days | daily maintenance run | reminders at 1/7/30 days recorded; case assigned to OD-03; liability unchanged | — | `CUSTOMER_REFUND_PAYABLE` unchanged (never released to revenue) | none | RFD-08 |
| AT-RFD-08 | refund created by FINANCE user M | M approves it; snapshot reveal by SUPPORT | approval refused (CHECK / 403); SUPPORT reveal 403; FINANCE reveal audited | 8 | none | none | RFD-07, SEC-06 |

## D. Courier and COD (AT-COU)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-COU-01 | 3 shipments READY_FOR_PICKUP (2 COD) | handover without manifest; then with a manifest (count 3, COD total) | first 409 `COURIER_HANDOVER_REQUIRED`; then HANDED_TO_COURIER ×3 linked to the manifest; COD collections NOT_COLLECTED with the manifest amounts | 1, 2 | none | reservations FULFILLED; `on_hand` −q | COU-02 |
| AT-COU-02 | OUT_FOR_DELIVERY | failed attempt ×max | FAILED_ATTEMPT, attempts counted, then RETURNING → RETURNED_TO_WAREHOUSE | 1 | failed-delivery fee per FD-08 config (`04` §7.12) | quarantine on return | `03` §7 |
| AT-COU-03 | COD OUT_FOR_DELIVERY | customer refuses | REFUSED; group CANCELLED; collection COLLECTION_FAILED; parcel returns to quarantine | 3, 6 | no deposits posting; courier fee per FD-08 | quarantine +q, inspected later | BD-05 |
| AT-COU-04 | OUT_FOR_DELIVERY | DELIVERED ×2 ∥ (ops + re-entered statement) | one transition; second 200 no-op; one DELIVERED journal | 5 | one `DELIVERED` journal | — | COU-05, C-9 |
| AT-COU-05 | COD expected 1,014.00 | collected 900.00 recorded; FINANCE investigates; FINANCE_APPROVER approves a write-off proposal by FINANCE (and refuses one by the same person) | as AT-FIN-12; write-off maker ≠ checker | 6 | write-off Dr COURIER_LOSS_EXPENSE / Cr COURIER_RECEIVABLE | — | COU-04 |
| AT-COU-06 | two collections 600.00 each | remittance 1,000.00; allocate 600 + 400 | collections REMITTED_TO_RIVEN / PARTIALLY_REMITTED; 200.00 remains on `COURIER_RECEIVABLE`, aged | 6 | Dr BANK / Cr COURIER_RECEIVABLE 1,000.00 | — | COU-03, C-7 |
| AT-COU-07 | prepaid shipment HANDED_TO_COURIER | marked LOST (maker OPS, checker FINANCE_APPROVER) | LOST; refund or reship; vendor compensated per FD-25 config | 5 | `04` §7.18 compensation (+ courier claim when accepted) | stock already left; no restock | FD-25 |
| AT-COU-08 | shipment OUT_FOR_DELIVERY | courier reports damage | DAMAGED_IN_TRANSIT → RETURNING → RETURNED_TO_WAREHOUSE → inspection; liability per FD-25 | 1, 14 | per FD-25 after inspection | quarantine → damaged / on_hand per inspection | FD-25 |
| AT-COU-09 | production configuration with COD disabled | checkout with COD | 400 `PAYMENT_METHOD_UNAVAILABLE`; enabled only after Phase 5 exit + PRG-07 | — | — | — | COU-01 |

## E. Vendor portal (AT-VP)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-VP-01 | vendors A and B with mixed-vendor groups | every `/vendors/me/*` list as A | only A's rows (A's `Order` and items only inside mixed groups) | — | — | — | criterion 29, C-VP1 |
| AT-VP-02 | B's balance / movement ids | A requests them | 404 | — | — | — | C-VP1 |
| AT-VP-03 | intake RECEIVED with a correction | A reads the intake | declared / received / accepted / damaged / rejected / missing and *original → correction → current* | — | — | — | criterion 31 |
| AT-VP-04 | intake RECEIVED | acknowledge; dispute ×2 ∥ (separate intake) | one response each; second dispute 409 | — | — | corrections only after approval | C-IN2 |
| AT-VP-05 | order with transitions | poll during transitions | timeline in order with persisted timestamps; vendor status per `03` §14 | — | — | — | criterion 30, C-VP2 |
| AT-VP-06 | statement for 30 × 500.00 | open statement and a line | lines explain each amount; drill-down shows order, item, delivery date, ledger entry; total 15,000.00 | 11 | read-only | — | criterion 36 |
| AT-VP-07 | payout SENT with proof | vendor reads payout, opens proof, confirms | signed URL ≤ 5 min; Riven status and own confirmation shown separately | 12 | none | — | criterion 37 |
| AT-VP-08 | issued statement, SENT payout | vendor attempts PATCH/DELETE on statement / payout / confirmation routes; test-only SQL update | 404/405 on routes; triggers raise | 11 | unchanged | — | criterion 39 |
| AT-VP-09 *(pending BD-31, BD-32, SD-09)* | vendor with commerce restriction NO_NEW_LISTINGS; vendor suspended; vendor user deactivated | statements / balance / payout confirmation; create product | restricted & suspended: financial reads 200, confirmation 200, create product 403; deactivated: login 403 `ACCOUNT_DEACTIVATED`, FINANCE export recorded instead | — | unchanged liabilities | — | VND-01, VND-02 |
| AT-VP-10 | vendor with a CONFIRMED group in fulfilment | admin suspends the vendor (reject) | products hidden, new checkouts refused; the confirmed group still ships and delivers; payable posted and on the statement | 5 | normal `DELIVERED` journal | normal | VND-03 |

## F. Security (AT-SEC)

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-SEC-01 | admin users with each single permission | call every `/admin/*` route (enumerated from the router) | only matrix-allowed calls succeed (`07` §2); others 403; no route without a permission declaration | 8 | none on refusal | none | SEC-06, criterion 15 |
| AT-SEC-02 | two shoppers, two vendors | cross-account ids on every owner route | 404 everywhere | — | — | — | C-VP1, criterion 50 |
| AT-SEC-03 | admin without PLATFORM_OPERATOR; FINANCE maker | grant self permissions; maker approves own adjustment; public registration with `role: ADMIN`; vendor calls `/admin/*` | 403; CHECK refuses; 400; 403 | 8 | none | none | SEC-06 |
| AT-SEC-04 *(pending SD-07)* | verified payout account | vendor adds a new account; FINANCE tries to pay to it before verification and during cooling-off | new row PENDING; old deactivated (not edited); payouts refused with `PAYOUT_ACCOUNT_NOT_VERIFIED` / `_COOLING_OFF`; notifications recorded; audit rows | 8 | none | — | SEC-02, SEC-03 |
| AT-SEC-05 | — | same `Idempotency-Key` + same body ∥; same key + different body | replay / `REQUEST_IN_PROGRESS`; 422 `IDEMPOTENCY_KEY_REUSED` | 4 | at most one effect | at most one reservation | C-E1, C-E3 |
| AT-SEC-06 | — | replay a webhook, a proof submission, a payout confirmation, a used refresh token | inbox duplicate; claim conflict / idempotent replay; 409 `PAYOUT_ALREADY_CONFIRMED`; family revoked per SD-03 | 3, 12 | none extra | none extra | criterion 50 |
| AT-SEC-07 | fixtures with payout accounts, shopper PII, outbox events | snapshot all vendor / shopper / admin list responses, outbox payloads, error bodies, logs | no full account numbers (except the audited reveal), no shopper PII to vendors, no secrets in payloads, no stack traces; signed URLs ≤ 5 min | — | — | — | SEC-01, SEC-02 |
| AT-SEC-08 *(TD-17 for the role part)* | audited actions executed | count audit rows; as the runtime DB role attempt UPDATE/DELETE on audit, ledger, statements; attempt `ALTER TABLE … DISABLE TRIGGER` | one audit row per mandatory action with actor / reason / time; updates raise; ALTER refused for the runtime role | 8 | unchanged | unchanged | SEC-04, REC-03, criterion 14 |

## H. Notifications (AT-NTF; v6, `notifications-module-spec2.md`) *(pending BD-35, TD-20 for push / e-mail)*

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-NTF-01 | `payment.confirmed` event processed once | replay the delivery (requeue after PROCESSED, test-only) | one in-app notification (unique idempotency key) | 13 | none | none | NTF-02 |
| AT-NTF-02 | order CONFIRMED | notifications consumer throws on every attempt until DEAD | order, payment and stock state unchanged; DEAD delivery visible to OD-02 | 13 | none | none | NTF-01, NTF-03 |
| AT-NTF-03 | push provider fake returns errors | NE-12 processed | in-app row exists; push effect FAILED after 3 sends; business flow unaffected | 13 | none | none | NTF-03 |
| AT-NTF-04 | fixtures for every NE type | snapshot all payloads and rendered texts | no full account / reference numbers, no shopper PII to vendors, no fraud detail, no secrets | — | — | — | NTF-04, AT-SEC-07 |
| AT-NTF-05 | user disables an informational type and a transactional type | trigger both | informational suppressed; transactional delivered | — | — | — | NTF-05 |
| AT-NTF-06 | vendor with two registered contacts | payout account changed (NE-39) | notice to every contact on every available channel; if no channel reaches the user, a manual-contact record is required | — | — | — | NTF-06 |

## I. Financial holds (AT-HLD; v6, `07` §14) *(pending TD-19, FD-27)*

| Id | Initial | Operations | Expected | Inv. | Ledger | Inventory | Proves |
|---|---|---|---|---|---|---|---|
| AT-HLD-01 | settlement APPROVED, payout PENDING | FINANCE_APPROVER activates the PAYOUT_SEND workflow hold; FINANCE marks the payout SENT | 409 `FINANCIAL_HOLD_ACTIVE`; payout PENDING; blocked attempt audited | 8 | none | none | HLD-01 |
| AT-HLD-02 | workflow hold active | Paymob webhook / proof approval of an arrived transfer / COD collection recording / delivery | all recorded normally (facts are never held) | 3, 5 | normal journals | normal | HLD-03 |
| AT-HLD-03 | payout SEND transaction in flight (race hook after its L0 `FOR SHARE`) | hold activation ∥ | activation waits; the in-flight payout commits SENT; the next send is refused | 8 | one `PAYOUT_SENT` | none | HLD-04 |
| AT-HLD-04 | entity hold on vendor V | payouts for V and for vendor W | V refused, W proceeds | — | W's journal only | none | HLD-02 |
| AT-HLD-05 | hold active | requester tries to lift their own request; second approver lifts with evidence | self-lift refused (CHECK); lift by second person succeeds; NE-50 to FINANCE_APPROVER / PLATFORM_OPERATOR | 8 | none | none | HLD-05 |

## G. Database concurrency (C-tests of `05`)

Every C-test runs on real PostgreSQL with true parallelism (`05` §6). Initial state, concurrent operations and winner/loser are in `05` §3–4; the table states the expected final state, the invariants stressed, and the ledger and inventory effect.

| Tests | Final state | Invariants | Ledger effect | Inventory effect |
|---|---|---|---|---|
| C-A | one group per available unit; losers 400 | 1, 2, 9 | none | reserved = units sold, never above stock |
| C-B | one SUCCEEDED attempt | 3, 5 | one `PAYMENT_RECEIVED` | reservations CONFIRMED once |
| C-C | one winner per transition; loser 409 | 7 | none | none |
| C-D1, C-10 | one effective cancel | 1, 2, 3 | none | one RELEASE per item |
| C-E1–C-E3 | one group per intent | 4 | none | one reservation set |
| C-F1, C-F2, C-15 | paid in grace, or exception after cap | 3 | `PAYMENT_RECEIVED` or `LATE_PAYMENT` journal, once | confirmed or already released |
| C-G1, C-G2, C-16 | no phantom stock | 1, 2 | none | one movement per applied change |
| C-H1, C-H2 | no CANCELLED group with `paidAt` | 3, 7 | late-payment journal only in H1 | released once (H1) / confirmed (H2) |
| C-1, C-2, C-3, C-4, C-FR1 | one terminal proof state; one claim per reference | 4, 8 | at most one `PAYMENT_RECEIVED` | confirm or re-reserve once |
| C-5, C-6, C-7, C-8 | one live settlement per payable; Σ allocations ≤ received; one live payout | 5, 6 | one journal per operation | none |
| C-9, C-21 | one DELIVERED; cancel refused after handover | 5, 7 | one `DELIVERED` journal | none beyond handover |
| C-11, C-12, C-S1 | one provider effect per refund | 5, 15 | one `REFUND_PAID` | none |
| C-13, C-14, C-DL1 | balances serialize; no deadlock | 1, 2, 9 | none | `on_hand ≥ reserved` always |
| C-M1 | shadow = authority | 2, 14 | none | zero discrepancies |
| C-L1, C-L2, C-L3 | one journal per source; unbalanced/edited rejected | 5 | as stated | none |
| C-X1 | released at cap; late success → exception | 3 | late-payment journal | released once |
| C-O1 – C-O4 | every delivery processed once | 13 | none (outbox carries no money) | none |
| C-P1 | rolled back on projection failure | 7 | none from the failed attempt | none |
| C-MC1 | identical web / mobile end state | all | identical | identical |
| C-PR1, C-PR2, C-DZ1 | one consistent price / rate snapshot per order | 10 | snapshots used at delivery | reservation only if checkout succeeded |
| C-IN1 – C-IN3 | one response; one correction set | 2 | none | correction movements once |
| C-ST1, C-ST2 | one statement per period; each entry in one period | 11 | read-only | none |
| C-PO1 – C-PO3 | separate Riven / vendor records; one resolution | 12 | at most one resolution journal | none |
| C-VP1, C-VP2 | isolation; consistent snapshots | — | none | none |
