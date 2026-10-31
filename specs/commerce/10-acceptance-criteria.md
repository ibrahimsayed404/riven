# 10 — Acceptance Criteria and Phase Reports

> Status: **DRAFT for review** · 2026-10-24, updated 2026-10-25 (criteria 41–52, phase exit criteria §5, production readiness gate §6; v6: criteria 53–55, Phase 3b exit and PRG-09/10/12 extended). Test ids (C-…) refer to `05-race-matrix.md`; scenario ids (AT-…) to `14-acceptance-test-scenarios.md`.

## 1. Final acceptance (production readiness)

The system is not production-ready until **every applicable line** below is proven by a test or a recorded check, with output attached to the phase report.

| # | Criterion | Proven by |
|---|---|---|
| 1 | No negative inventory | CHECK constraints; invariant §5.1 after every concurrency test; C-A, C-14, C-16 |
| 2 | No duplicate inventory reservation | `stock_reservations.orderItemId @unique`; C-E1/E2 |
| 3 | No duplicate stock restoration | guarded release + `sourceEventKey @unique`; C-10, C-D1 |
| 4 | No duplicate payment processing | inbox unique key; C-B, C-1 |
| 5 | No duplicate transfer reference acceptance | claim unique key; C-4, C-FR1 |
| 6 | No duplicate settlement allocation | partial unique on settlement lines; C-5 |
| 7 | No duplicate vendor payout | guarded payout + partial unique; C-8 |
| 8 | No duplicate refund execution | guarded refund + provider idempotency key; C-11, C-12, C-S1 |
| 9 | No silent late-payment loss | LATE_PAYMENT exception + admin list; C-F2, C-H1, C-X1 |
| 10 | No invalid state transitions | table-driven unit tests per machine (`03`); guarded updates; 409 not 500 |
| 11 | No journal imbalance | deferred trigger; C-L2; nightly verification |
| 12 | No untraceable financial movement | every journal has a source key; every bank/clearing balance explained by journals (reconciliation report) |
| 13 | No unverified stock available for sale (subject to BD-08) | `warehouses.sellable`; intake tests |
| 14 | No mandatory audit record missing | per-test audit row counts; `recordInTx` |
| 15 | Authorization on every sensitive operation | permission-matrix test (one test per row of `07` §2) |
| 16 | Critical concurrency tests pass on real PostgreSQL | `test:concurrency` green in CI |
| 17 | Every migration has a verified recovery strategy | rehearsal report per phase (`06` §7) |
| 18 | All business decisions documented and approved | `08-decision-register.md` BLOCKING items for the phase marked APPROVED with approver and date |

## 2. Additional criteria from the 2026-10-24 review

| # | Criterion | Proven by |
|---|---|---|
| 19 | No inconsistent inventory state during migration | C-M1; cutover rehearsal (`06` §3.4) |
| 20 | No deadlock from inconsistent lock acquisition | C-DL1, C-14 (deadlock counter delta = 0) |
| 21 | No fraudulent reference reuse | C-FR1 |
| 22 | No duplicate journal posting | C-L1 |
| 23 | No unbalanced posted journal | C-L2; trigger existence test |
| 24 | No indefinite reservation due to pending payments | C-X1; cap tests for each method |
| 25 | No lost outbox event | C-O1, C-O2 |
| 26 | No duplicate external side effect after a worker retry | C-S1 (fake provider records idempotency keys) |
| 27 | No divergence between `PaymentTransaction` and legacy fields | C-P1; invariant query after every test |
| 28 | Identical business behaviour across web and mobile | C-MC1 parity suite |

## 2a. Vendor portal, pricing, delivery fees, statements and payouts (added 2026-10-25)

| # | Criterion | Proven by |
|---|---|---|
| 29 | Vendors can only access their own products, orders, inventory, movements, intakes, statements, settlements, payouts and payout accounts | C-VP1; generated route-enumeration test (`07` §9); 404 for foreign ids |
| 30 | Vendor inventory and order statuses reflect persisted backend changes | C-VP2; e2e: transition → next vendor poll shows the new vendor status (`03` §14) and its `FulfilmentEvent` timestamp; balances equal the inventory tables |
| 31 | Vendors can acknowledge or dispute intake quantities, without changing Riven's inspection record | C-IN1, C-IN2, C-IN3; trigger test: UPDATE of inspected columns after RECEIVED fails; dispute → correction rows + movements |
| 32 | The markup is correct and configurable | unit tests for `RIVEN_PROFIT_PERCENTAGE` = 6 → 500.00 → 30.00 / 530.00; rounding cases (333.33 → 20.00 / 353.33); invalid values (−1, 101, "abc", 6.123) stop the API at boot; no literal 6 or 0.06 in business code (grep test) |
| 33 | Changing the percentage does not change historical orders | C-PR2; order items keep their bps and amounts; statements and refunds use snapshots |
| 34 | Delivery fees follow the configured zone | unit + e2e: address → (governorate, city) → zone → rate in force; unmapped area → 400 `DELIVERY_AREA_NOT_SERVED`; fee never marked up |
| 35 | Historical orders keep their original delivery fee | C-DZ1; group references the rate row; rate rows append-only (trigger test) |
| 36 | Vendor statements reconcile with eligible order items and ledger entries | invariant 11 (`05` §5); e2e: 30 × 500.00 → 15,000.00 net payable; every line drills down to its order item and ledger entry; issue refused when closing ≠ ledger |
| 37 | Every payout is linked to its statement and transfer proof | DB: `vendor_payouts.statementId` NOT NULL, `proofKey` required to move to SENT; e2e |
| 38 | Partial payout confirmation creates a traceable discrepancy | e2e: sent 30,000.00, vendor confirms 28,000.00 → discrepancy 2,000.00 OPEN, payout row unchanged (trigger test), C-PO2 |
| 39 | Vendor disputes and admin resolutions are fully auditable | audit rows for every vendor response, dispute, proposal and approval, with actor, before/after state, correlation id; maker ≠ checker enforced by CHECK |
| 40 | Refunds, returns and cancellations never create incorrect vendor payables or Riven margin | e2e per case: cancel before delivery → no `VENDOR_PAYABLE` / `RIVEN_PRODUCT_MARGIN` entries; return after delivery → exactly the item's vendor rate reversed, plus its margin only under the FD-19 option Ibrahim approves (`04` §7.10; FD-19 pending); C-L1 for duplicate postings |

## 2b. Gap-closure criteria (added 2026-10-25)

Scenario ids (AT-…) are specified in `14-acceptance-test-scenarios.md`; requirement ids in `08` §8.

| # | Criterion | Proven by |
|---|---|---|
| 41 | No outbox event is lost after a crash, a deploy or a failed inline attempt; stale leases are recovered; no delivery is processed twice concurrently | AT-OB-01–AT-OB-09, C-O1–C-O4 |
| 42 | No outbox consumer changes money, ledger, payment state or stock | AT-OB-10 (registry vs allow-list) |
| 43 | Nothing is purchasable unless Riven received, inspected and verified it; damaged, missing, disputed and quarantined units are never reservable; no API path bypasses this | AT-INV-01–AT-INV-12; invariant 14 (`05` §5) |
| 44 | Existing vendor-declared stock never becomes sellable through migration | AT-INV-10–AT-INV-12; `06` §3.5 |
| 45 | Every financial area reconciles; every discrepancy is detected, recorded and resolved by new entries only | AT-FIN-11; `12` §2 checks run on the rehearsal snapshot |
| 46 | Returns: request, physical return, inspection, refund approval and execution are separate; no refund executes automatically; production restriction holds while BD-04 / FD-19 are pending | AT-RET-01–AT-RET-07 |
| 47 | Negative vendor balances after payout are carried forward or recovered by approved new journals; posted entries untouched | AT-FIN-07, AT-FIN-09, AT-FIN-14 |
| 48 | Courier accountability: every handover has a manifest; every COD amount is traceable from expected → collected → remitted → reconciled; discrepancies have owners | AT-COU-01–AT-COU-09 |
| 49 | Vendor restrictions never remove liabilities, history or (subject to BD-32) financial access | AT-VP-09, AT-VP-10 |
| 50 | Security: no unauthorized admin action, no cross-vendor access, no privilege escalation, payout-account changes controlled, replays harmless, no sensitive data exposed, audit log integrity | AT-SEC-01–AT-SEC-08 |
| 51 | A production backup has been restored successfully and the restore timed against the RTO | restore record (`13` §2) |
| 52 | Every OD owner is named and every runbook has been walked through once | `13` §4 sign-off |
| 53 | Refunds are paid only to verified destinations approved together with the amount; destinations cannot be substituted after approval; returned transfers are re-owed, never lost (v6) | AT-RFD-01–AT-RFD-08 |
| 54 | Notifications reflect committed events only, are idempotent, never alter business state, respect privacy rules, and security notices reach every reachable contact (v6) | AT-NTF-01–AT-NTF-06 |
| 55 | Financial holds stop outbound money actions immediately and deterministically, never block recording of facts, and are lifted only by a second person (v6) | AT-HLD-01–AT-HLD-05 |
| 56 | Intake MVP: only accepted quantities of admin-approved lines become sellable, exactly once; partial approval; single atomic admin approval; disputed accepted units frozen, others sellable; corrections only by adjustments; evidence and internal notes protected (v7) | AT-INV-14–AT-INV-33, C-IN4 |
| 57 | Handover discrepancies: acknowledgment only on mismatch; both parties' numbers preserved; withdrawals respect notice and availability; no courier step and no financial consequence (v7) | AT-HND-01–AT-HND-08, C-HND1 |
| 58 | Cart and order pricing: cart prices current; changes acknowledged per item and per version; checkout refuses unreviewed changes; immutable snapshot; payments use the snapshot; delivery fee separate (v7) | AT-CPR-01–AT-CPR-15, C-PR3 |
| 59 | Reservations: none at add-to-cart; atomic with the order and snapshot at checkout; per-method lifetimes; proof deadline judged under the group lock; timely proofs keep stock reserved (pending BD-18); release exactly once; late Paymob success never lost; missed maintenance never releases wrongly (v7 Part Four) | AT-RSV-01–AT-RSV-14, C-RSV1, C-RSV2 |
| 60 | Scheduled reservation maintenance releases every overdue reservation (incl. abandoned orders never opened again) exactly once, catches up after missed runs, records each run and alerts on failure or delay (2026-10-27); with the proposed BullMQ worker (TD-18, every 10 min) it survives worker crashes, transaction rollbacks, partial batch failures and overlapping workers, never trusting job payloads; run records in PostgreSQL survive BullMQ job cleanup | AT-MNT-01–AT-MNT-10, AT-MNT-14, AT-MNT-15, AT-MNT-17, C-MNT1, C-MNT2 |
| 61 | Units handed to the courier are never available; they return to stock only through receipt, quarantine and authorized inspection; the courier never inspects (2026-10-27) | AT-DSP-01–AT-DSP-03; invariant 16 |
| 62 | PAYMOB is unreachable in production until the PAYMOB activation exit is met; when activated it satisfies PMA-01 – PMA-08 (2026-10-27) | AT-PMA-01; PAYMOB activation exit |
| 63 | Schedule recovery: after a Redis outage, data loss or FLUSHALL — or a scheduler that disappears while the worker runs — exactly one 10-minute schedule is re-established automatically by idempotent reconciliation; the manual command works without Redis; PostgreSQL remains the only authority and no deadline is extended; if the queues share one process (TD-23), a failing reconciler or reconciliation run never starves the outbox drain (2026-10-27, TD-18 / TD-23 proposals) | AT-MNT-06, AT-MNT-11–AT-MNT-13, AT-MNT-16, C-MNT3 |
| 64 | Worker lifecycle: the reservation worker starts on deploy, is restarted automatically after a crash, shuts down gracefully between groups, survives Redis and PostgreSQL outages without crashing, raises crash-loop and unavailability alerts, and never releases stock twice across restarts — shown on the **chosen host** (2026-10-27, TD-18 proposal; blocked by TQ-16 / TQ-28) | AT-MNT-06, AT-MNT-11, AT-MNT-18 – AT-MNT-20 |
| 65 | Throughput validated: the measurements of `21` §8.9 are recorded for 500, 1,000, 5,000 and 10,000 overdue groups under concurrent API traffic (and shared-process load), including restart mid-run and catch-up after a 6-hour outage, against pass criteria P1 – P8 of `22` §7; the batch size, budget and interval are confirmed or revised through TD-18 (2026-10-27) | AT-MNT-21 |
| 66 | Transaction-safety implementation acceptance: every item marked IAC in `21` §8.10 is shown by its test or a recorded code review before TD-18's implementation is accepted — atomic release, no double release, `SKIP LOCKED`, crash before / after commit, idempotent retries, single code path for manual and scheduled runs, courier-handover and quarantine protection, no deadline written, no head-of-line blocking by a failing group (2026-10-27; `22` §5) | AT-MNT-02, AT-MNT-03, AT-MNT-05, AT-MNT-08, AT-MNT-09, AT-MNT-14, AT-MNT-15, AT-MNT-22, AT-MNT-23, C-MNT1, C-MNT2, AT-DSP-02, AT-DSP-03 |
## 3. Per-phase report template (deliverable 19)

Each phase ends with a report in `specs/commerce/reports/phase-N.md` containing:

1. Scope delivered vs planned; decisions relied on (ids + approval dates).
2. Files changed (`git diff --stat` output).
3. Models changed; migrations created (names) and hand-SQL objects added.
4. APIs added/changed (method, path, auth, error codes); OpenAPI diff.
5. Tests added (names) and executed: raw output of `lint`, `typecheck`, `test:unit`, e2e, `test:concurrency`, `smoke`.
6. Migration rehearsal output (timings, invariant query results).
7. Known limitations; remaining risks (register ids still open).
8. Contract check: existing Paymob specs unmodified and green; mobile legacy shape tests green.

Nothing is reported as done without the raw output (CLAUDE.md "Show real evidence"). Commits and pushes remain the maintainer's action.

## 4. Final acceptance report (deliverable 20)

Produced after Phase 7: the table of §1–2b with, for each line, the test name, the CI run link or raw output, and the date; plus the decision register with every BLOCKING item approved; plus open DEFERRED items.

## 5. Phase exit criteria (added 2026-10-25)

A phase is **exited** only when every line for it holds, with evidence in its phase report (§3). Working endpoints are not an exit criterion by themselves. "Approved" always means approved by the authorized approver in `08`.

| Phase | Exit criteria |
|---|---|
| **0 Safety** | TD-04, TD-06, TD-07, TD-08, TD-12, FD-01 approved; C-A…C-D1 baseline recorded against today's code; criteria 1–3, 10, 14, 16, 20, 22, 25, 26, 41, 42, 60 proven (*2026-10-27: the Paymob parts of criteria 4, 9, 11 and 27 moved to the PAYMOB activation exit, TD-21*); PAYMOB still unreachable in production (AT-PMA-01); scheduled expire-overdue running with alerts (MNT-01 – MNT-06, R-D8) before production go-live; outbox recovery paths 3–6 of `01` §7.5 in place (TD-18 approved, OD-01/OD-02 named) before production go-live; R-D1–R-D7 met; backup restore tested (criterion 51) before the first production migration |
| **1 Inventory** | BD-01, BD-03, TD-09 approved; 1a backfill rehearsal with zero discrepancies (C-M1); 1b cutover rehearsal; invariant 14 holds; AT-INV-07, AT-INV-10, AT-INV-11 green; OD-04 named |
| **2 Intake** | BD-08, FD-07, BD-41, BD-42, SD-11 approved (BD-24, BD-25, BD-36 – BD-40 approved 2026-10-27); criteria 56, 57 green; AT-INV-01–AT-INV-05, AT-INV-12, AT-VP-03, AT-VP-04 green; C-IN1–C-IN3 green; RIVEN warehouse made sellable by a recorded change |
| **3a Pricing + zones** | FD-17, FD-20, FD-23, TD-14, TD-15 approved (FD-02, FD-21, FD-29 approved 2026-10-27; FD-04 / BD-30 needed only when zones replace the flat fee; FD-28 needed before any dynamic markup source); criteria 32–35, 58 green; FD-17 migration rehearsed (`06` §5.3.1) |
| **3b Transfers + ledger** | BD-15, FD-05, FD-24, FD-26, FD-27, SD-01, SD-10, TD-19, BD-06, BD-07, BD-11, BD-19, BD-35 approved (TD-20 at least for the in-app channel); criteria 5, 8 (manual path), 11, 12, 21, 23, 24, 45, 53, 54 (in-app parts), 55, 59 green; ledger triggers existence test; minimal manual refund path (exception refunds) end to end with destination verification; OD-03, OD-06 named |
| **4 Fulfilment** | BD-02, FD-08, FD-18, FD-25, BD-09, BD-13, BD-20, BD-26, BD-27 approved; AT-COU-01–AT-COU-04, AT-COU-07, AT-COU-08 green; criteria 29, 30, 40 (delivery parts) green; COD still disabled in production (COU-01); **COD must not be enabled for checkout in any deployed environment** until its expiry eligibility is separated from prepaid-payment expiry (the generic TTL never selects a COD group) and AT-RSV-09, AT-RSV-10 and AT-DSP-02 pass (`23` §11.1a) |
| **5 COD reconciliation** | FD-06, FD-10, TQ-04 resolved; AT-COU-05, AT-COU-06, AT-COU-09, AT-FIN-12, AT-FIN-13 green; one full reconciliation of a real or rehearsal courier statement; OD-05 named. **Only now may COD be enabled in production** (COU-01), and only together with the PRG gate |
| **6 Statements + payouts** | FD-03, FD-11, FD-22, BD-10, BD-28, BD-29, BD-32, FD-09, SD-06, SD-07, SD-09 approved; criteria 36–39, 47, 49 green; AT-VP-06–AT-VP-09 green; AT-SEC-04 green |
| **PAYMOB activation (deferred)** | BD-17 and BD-43 approved; TQ-01, TQ-02 resolved; PMA-01 – PMA-08 met; criteria 4, 9, 11, 27 (Paymob parts) and 62 green in the target deployment (C-B, C-F1, C-F2, C-H1, C-H2, C-X1, C-P1); reconciliation executor running (R-D4) |
| **7 Returns + refunds** | BD-04, FD-14, FD-19 approved; AT-RET-01–AT-RET-07, AT-INV-09, AT-FIN-05–AT-FIN-07, AT-FIN-14 green; only then may returns be enabled in production (RET-02) |

## 6. Production readiness gate (PRG; required by Youssef's 2026-10-25 brief)

Real customer orders in production are allowed only when **every** line below is met and signed off by Youssef (technical lines) and Ibrahim (business lines). **Any unresolved critical item blocks launch**; there is no partial launch unless Ibrahim and Youssef record an explicit, scoped exception in `08` (none exists).

| Id | Area | Gate |
|---|---|---|
| PRG-01 | Inventory custody and enforcement | Phases 1–2 exited; criteria 1, 2, 3, 13, 19, 43, 44 proven; no purchasable product without verified stock |
| PRG-02 | Payment correctness | TRANSFER review flow (Phase 3b) exited; criteria 5, 21, 24, 59 proven; PAYMOB disabled in production (criterion 62) unless the PAYMOB activation exit is met (then criteria 4, 9 as well) |
| PRG-03 | Outbox recovery and scheduled maintenance | criteria 25, 41, 42, 60, 63 – 66; scheduled expire-overdue every 10 min (TD-18 mechanism, with schedule reconciliation) and the outbox drain (TD-23) running on a host that supervises the worker (TQ-16, TQ-28); Redis settings verified (TQ-27); throughput measured (MNT-18); alerts A1 – A15 evaluated outside the worker and delivered by the chosen external tool (TQ-33; heartbeats + health monitors, `22` §4), still alerting when PostgreSQL is down, to OD-01 / OD-02 |
| PRG-04 | Ledger integrity | criteria 11, 12, 22, 23; ledger verification run daily with zero findings for 14 days on the production-like rehearsal |
| PRG-05 | Financial reconciliation | criterion 45; every `12` §2 check run at least once with all discrepancies resolved; OD-06 named |
| PRG-06 | Courier accountability | Phase 4 exited; criterion 48; signed courier contract (TQ-04) |
| PRG-07 | COD reconciliation | Phase 5 exited; COD enabled only if PRG-07 holds (COU-01); otherwise launch without COD requires Ibrahim's recorded scope decision (BD-33) |
| PRG-08 | Vendor settlement and payout | Phase 6 exited; criteria 36–39, 47 |
| PRG-09 | Returns and refunds | Phase 7 exited; criteria 46, 53; BD-04 legal review done; FD-26 / TQ-30 legal answer on refund destinations |
| PRG-10 | Security and authorization | criteria 15, 29, 50, 55; TD-17 and SD-08 implemented (posted history not alterable by the runtime role); SD-01 people assigned |
| PRG-11 | Backup restoration | criterion 51 within the last 30 days; RPO/RTO approved (`13` §2) |
| PRG-12 | Monitoring and operational ownership | criteria 52, 54; health metrics of `01` §7.7 and §13.1 R-D7 alerting to named owners; security notices (NE-26, NE-39, NE-52) reach users through an approved channel or a documented manual contact procedure (BD-35, TD-20) |
| PRG-13 | Critical acceptance tests | every C- and AT- test of the phases above green in CI on real PostgreSQL in the release candidate (no mocked-database result counts) |
| PRG-14 | Business approvals | every BLOCKING decision for Phases 0–7 APPROVED in `08` with approver and date; BD-33 approved |
