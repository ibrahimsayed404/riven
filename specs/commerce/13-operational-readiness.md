# 13 — Operational Readiness: recovery, backups, maintenance, ownership

> Status: **DRAFT for review** · 2026-10-25 (gap-closure pass). Requirements OPS-01 – OPS-04 (`08` §8). **No operational commitment is made here**: every value marked TBD needs approval (technical values: Youssef; business acceptance: Ibrahim), and every owner (OD-01 – OD-08) is **unassigned**. Production context today: Supabase PostgreSQL, Redis Cloud, Meilisearch, S3-compatible object storage; API hosting not yet decided (TQ-09, TQ-16).

## 1. Failure runbooks (OPS-02)

Common rules: every write is a guarded, idempotent transaction, so retrying after an outage is safe; no runbook step edits financial rows by hand (`07` §13); every manual action is taken through an audited endpoint or command; after any incident that touched money or stock, run the reconciliation checks of `12` §2 and the inventory reconciliation before declaring recovery.

### 1.1 PostgreSQL unavailable
- **Detection:** `/health` DB check fails; API returns 503 `TRY_AGAIN`; alert to OD-08.
- **Immediate:** nothing to do inside the app — transactions are atomic, so no half-written order, payment or posting exists. Keep the API up (it fails fast) or put checkout in maintenance (`CHECKOUT_PAUSED`).
- **Recovery:** when the database returns: confirm migrations status; run expire-overdue (lazy expiry also catches up), outbox drain, inventory reconcile, ledger verify. If the outage required a restore, follow §2.4 and treat as §1.10.
- **Owner:** OD-08 (incident), OD-01 (post-recovery maintenance).

### 1.2 API unavailable (crash, bad deploy, host down)
- **Detection:** health check / uptime monitor; client errors.
- **Immediate:** roll back to the previous release (expand-only migrations keep old code working, `06` §1).
- **Safe because:** clients retry with the same `Idempotency-Key`; outbox rows are durable; the **boot sweep** of the restarted instance reclaims due and stale deliveries (`01` §7.5); reservations expire by stored timestamps (lazy expiry on next touch, maintenance command).
- **Recovery:** after restart run the daily maintenance set (§3.1) once.

### 1.2a Reservation-expiration worker down or delayed (TD-18 proposal)
- **Detection:** the PostgreSQL-based alerts of §5 (no successful `MaintenanceRun` for 25 min, backlog) — they fire even if Redis and the worker are down.
- **Tell the cause apart first** (`21` §8.6): A9 = worker down with Redis up; A11 = Redis down; A13 = PostgreSQL down; A8 / A14 = schedule missing; A6 = backlog; A2 / A3 / A15 = processing failures; A5 / A7 = stock not released / released wrongly.
- **Immediate:** restart the worker through the host (the supervisor should already have done so, `21` §8.8 — no supervisor exists in the current deployment configuration, TQ-16 / TQ-28); if it cannot run, OD-01 runs `POST /admin/maintenance/expire-overdue` until it is back. On a crash loop (A10) roll back the release that started it.
- **Safe because:** eligibility is re-checked from the database per group; releases are idempotent; the first run after recovery catches up on everything overdue in bounded batches without extending any deadline (`21` §8.1).

### 1.3 Redis unavailable
- **Affects:** existing in-process BullMQ jobs (order expiry job, search sync, bazaar auto-complete — TQ-15), the proposed reservation-expiration worker's schedule (TD-18 — paused while Redis is down; expiry stays correct because eligibility lives in PostgreSQL and the first run afterwards catches up, §1.2a) and, if moved there later, throttler storage. **Does not affect** the outbox (database-based) or any money/stock state.
- **Immediate:** nothing financial at risk; search may go stale; expiry is still applied lazily and by the maintenance command.
- **Recovery:** when Redis returns, run `POST /admin/search/reindex` (existing) and expire-overdue. The reservation-expiration worker re-registers its BullMQ job scheduler on boot (MNT-08), so a flushed Redis recreates the 10-minute schedule (the schedule reconciler of `21` §8.2 also recreates it within 60 s if it disappears while the worker keeps running); missed ticks are not replayed — the next run's database query processes everything overdue. Persistence / eviction of Redis Cloud (possible job loss) is TQ-27. To investigate failed maintenance, read the `MaintenanceRun` rows (status, `error`, counts) in PostgreSQL first; BullMQ's failed-job records are a secondary aid, kept only within the proposed retention limits (`21` §8.3.1) and possibly lost with Redis. Removing or losing BullMQ jobs never removes `MaintenanceRun` rows (MNT-15). Release delays during the outage are longer than the ≈ 14-minute normal-conditions estimate; that estimate is not a guarantee (`21` §8.1).

### 1.4 Object storage unavailable (S3-compatible; the brief's "Cloudinary" — C23, TQ-22)
- **Affects:** proof upload URLs, proof viewing by reviewers, payout-proof upload/viewing, product images.
- **Immediate:** proof submission returns 503 `TRY_AGAIN` and claims nothing (the file check precedes the transaction); reviewers pause approvals that need the image (no approval without seeing the proof); payouts are not marked SENT without a stored proof.
- **Recovery:** resume the queues; no data repair needed.

### 1.5 Paymob unavailable
- **Production:** PAYMOB is disabled (R-D2) — no impact.
- **Non-production / later:** checkout returns `paymentSetupFailed`; attempts `INITIATION_FAILED`; stock is released at the cap; late successes become `LATE_PAYMENT` exceptions. Enabling Paymob in production requires TD-13 to be revisited (R-D4).

### 1.6 Courier service unavailable
- No courier API integration in the MVP (BD-22 deferred); everything is entered by OPS.
- **Immediate:** shipments stay READY_FOR_PICKUP (no handover without a manifest, COU-02); shoppers informed through SUPPORT; COD collections stay as recorded.
- **Prolonged:** OPS may hand over to an alternative courier (new manifest); remittances and reconciliation continue per courier.

### 1.7 Outbox backlog (`01` §7.7 alerts)
1. Check `/admin/outbox` grouped by consumer and `lastError`.
2. If a consumer's dependency is down (push provider), leave deliveries PENDING — they retry on schedule; nothing financial waits on them (`01` §7.8).
3. If deliveries are stuck PROCESSING with expired leases, run `POST /admin/outbox/drain` (reclaims them).
4. Fix poison events at their source (deploy), then requeue DEAD deliveries one by one with a reason.
5. Record the incident if anything was DEAD > 24 h.

### 1.8 Failed scheduled maintenance run
- **Detection:** missing entry in the maintenance log (§3.3) or rising "overdue reservations" / "oldest pending" metrics.
- **Action:** run the missed commands manually — all are idempotent and bounded; repeat until the metric clears; record why the schedule failed (TD-18 / TQ-28).

### 1.9 Failed database migration
- Stop the deploy; the previous application version still runs against an expanded schema (`06` §1).
- Prisma has no down-migrations: forward-fix, or restore from the pre-migration backup (`06` §8, §2.4 below). Re-run `hand-sql-objects.spec.ts` against the database to confirm no trigger / partial index was dropped.
- Never retry a half-applied migration by editing `_prisma_migrations` without a written plan reviewed by Youssef.

### 1.10 Corrupted or inconsistent financial data
1. **Hold outbound money:** activate the workflow holds of `07` §14 for payout send/confirm, refund approval/execution, settlement approval, statement issue and manual adjustments (TD-19, FD-27 — pending). Incoming facts (payments, collections, deliveries) keep being recorded — a global freeze of every money write is **not** used (`07` §14.1). *(v6: replaces the earlier single `FINANCE_FREEZE` proposal.)*
2. Take a database snapshot (evidence).
3. Run every check of `12` §2 and the ledger verification; list the discrepancies.
4. Incident team: OD-06 + Youssef + Ibrahim. Correct only by new journals / documented workflows (maker-checker); never by editing posted rows.
5. Lift the holds (two people, `07` §14.3) after the checks are clean; write a post-incident report (cause, entries posted, vendors/customers affected).

### 1.11 Reservation-maintenance incidents (TD-18 proposal; alerts `21` §8.6, delivery `22` §4)

Rules for every procedure:
- **Safe actions only:** restart the worker through the host; run `POST /admin/maintenance/expire-overdue` (the same code path as the scheduled run, safe alongside it — C-MNT1); pause a single non-expiry queue; roll back a release.
- **Never:** `FLUSHALL` or `obliterate` in production; delete jobs to "unstick" a queue; edit stock, reservations or order statuses by SQL; mark reservations released by hand.
- **No automatic destructive recovery exists or may be added.**
- **Duplicate release is prevented in every case** by per-group `SKIP LOCKED`, guarded `ACTIVE → RELEASED` (Phase 0: guarded `PENDING → CANCELLED`) and the unique movement key (`21` §8.10). Running the manual command while a run is active therefore cannot release anything twice.

| Scenario | Detection (alert → notified) | Investigate | Safe recovery | Verify recovery |
|---|---|---|---|---|
| Worker unavailable | A1 / A9 via the expiry heartbeat (M1) → OD-01, escalate OD-08 | host events and logs for the worker service; M4 green (Redis and PostgreSQL up) | restart the worker; run the manual command meanwhile | a new `MaintenanceRun` SUCCEEDED, heartbeat received, A5 clear |
| Worker crash loop | A10 + host notification → OD-01 (P1) | the crash cause in logs; did a deploy start it? | roll back the release; manual command until fixed | 60 min without a crash; runs SUCCEEDED |
| Redis unavailable | A11 (M4) → OD-01 | provider status page; connection count vs limit (TQ-27) | wait for reconnection; manual command (works without Redis, MNT-13) | M4 green; the reconciler confirms the schedule; the next run catches up |
| PostgreSQL unavailable | A13 (M4 / M5 fail; M1 silent) → OD-01, OD-08 | provider status (Supabase); §1.1 | §1.1; nothing to do on the worker (it reconnects) | M4 green; next run SUCCEEDED and catches up |
| Missing recurring schedule | A8 (recreated) / A14 (reconciler failing); A1 as backstop → OD-01 | scheduler entry via read-only BullMQ inspection; Redis eviction policy and persistence (TQ-27) | let the reconciler recreate it; if the reconciler is failing, restart the worker (startup reconciliation) | scheduler present with `*/10 * * * *`; next tick runs |
| Queue backlog | A6 → OD-01 | throughput vs backlog (`21` §8.9); failures (A15)? | let catch-up continue; extra manual command runs are safe | backlog shrinking each run, then below 500 |
| Repeated order-processing failures | A15 (P1 when the same group fails 3 runs) → OD-01 | the per-group error in logs / error tracking; the group's data | fix the cause (data correction only through documented workflows); then the next run or the manual command releases it | the group released once (one `RELEASE` movement per reservation); A15 clear |
| Stock-release failure | A5 (not released in time) or A7 (released wrongly) → OD-01, OD-08 (A7 = incident, §1.10) | A5: as worker / backlog; A7: invariant query output | A5: manual command; A7: stop and investigate, correct only through documented workflows | invariants 1, 2, 16 hold; A5 / A7 closed |
| Failed recovery (manual command fails too) | the command's error; A1 persists | PostgreSQL health, the failing group (A15), locks (`pg_locks`) | escalate to OD-08; no SQL workaround | as above |
| Excessive processing time | A4 → OD-01 | a stuck transaction (`pg_stat_activity`, lock waits); is the budget check working? | let `lock_timeout` / `statement_timeout` end the transaction; if the process is hung, restart the worker (the open transaction rolls back) | runs finish < 5 min |

## 2. Backups and restore (OPS-01)

**A backup is not considered verified until a restore from it has been tested.** Values below are **TBD** until approved; Supabase plan capabilities are TQ-07 / TQ-26.

| Item | Requirement | Value |
|---|---|---|
| Frequency | full backup + point-in-time recovery if the plan allows | TBD (TQ-26) |
| Retention | long enough to cover financial-record obligations (SD-05) and a late-discovered corruption | TBD |
| Ownership | person who checks backups exist daily and runs restore tests | OD-07 (unassigned) |
| Encryption | at rest by the provider; any exported dump encrypted and stored outside the main account | TBD (provider capability, TQ-26) |
| Access | only named people (SD-08); dumps contain personal data (`06` §7) | TBD |
| RPO (max data loss) | proposal for discussion only: ≤ 1 h if PITR exists | **TBD — Youssef / Ibrahim** |
| RTO (max downtime) | proposal for discussion only: ≤ 4 h | **TBD — Youssef / Ibrahim** |
| Restore testing | before the first production migration of each phase, and periodically after launch | cadence TBD (proposal: monthly) |

### 2.4 Restore procedure (and test)
1. Restore the chosen backup / point in time into a **new** database (never over production): a new Supabase project or a local `riven_snapshot_test`.
2. Record the wall time (compare with RTO) and the restored point in time (compare with RPO).
3. `prisma migrate status`; `hand-sql-objects.spec.ts`; invariant queries (`05` §5); ledger verify; `12` §2 checks on the restored data.
4. Compare row counts of key tables with production at the restore point.
5. Record the result (date, backup id, timings, findings) — this record is criterion 51's evidence. Delete the copy afterwards (personal data).

## 3. Maintenance runbook (OPS-04; while TD-13 postpones workers)

### 3.1 Daily (OD-01), unless the scheduler of TD-18 runs it
| Command | Purpose | Expected result |
|---|---|---|
| `POST /admin/maintenance/expire-overdue` | release overdue reservations — **must run on a schedule every 10 min in production** (MNT-01; proposed executor: BullMQ scheduler + dedicated worker, TD-18, `21` §8.1); this manual command is the fallback when the worker is down; daily, OD-01 only **verifies** the schedule (last `MaintenanceRun` SUCCEEDED within 25 min, no backlog); the manual command works without Redis (MNT-13) | count released; overdue metric → 0; `MaintenanceRun` row |
| `POST /admin/outbox/drain` | deliver anything left (`01` §7.5 path 5) | pending oldest age below threshold; DEAD reviewed |
| `POST /admin/inventory/reconcile` | counters vs movements vs reservations | zero new discrepancies, or each assigned to OD-04 |
| `POST /admin/ledger/verify` | journal balance, trial balance | zero findings |
| `POST /admin/reconciliation/run` for the daily checks of `12` §2 | financial consistency | discrepancies assigned to OD-03 / OD-06 |
| proof queue check (twice per business day) | review SLA (BD-19) | no overdue proofs, or escalated |
| backup presence check | §2 | today's backup exists |

### 3.2 Outbox recovery procedure (OD-02)
Steps of §1.7. Requeue only after the cause is fixed; never delete or edit an event.

### 3.3 Maintenance log
Every maintenance endpoint writes an audit row (actor, command, counts, duration) in its transaction; `GET /admin/audit-log?source=maintenance` is the log. A day without the expected rows is a failed run (§1.8).

## 4. Operational ownership (OPS-03)

| OD | Responsibility | Gate | Approver | Assigned |
|---|---|---|---|---|
| OD-01 | Daily maintenance (§3.1) | Phase 0 go-live | Youssef | **unassigned** |
| OD-02 | Outbox recovery, DEAD review, outbox alerts | Phase 0 go-live | Youssef | **unassigned** |
| OD-03 | Failed / late / mismatched payment investigation; payment exceptions; refunds follow-up | Phase 3 | Ibrahim | **unassigned** |
| OD-04 | Inventory discrepancy investigation; stocktakes; intake and withdrawal handover discrepancies and disputes (v7, `19`); weekly review of flagged self-approvals (SD-11) | Phase 1 | Ibrahim | **unassigned** |
| OD-05 | COD reconciliation with couriers; courier disputes | Phase 5 | Ibrahim | **unassigned** |
| OD-06 | Financial reconciliation (`12`), statements issue check, discrepancy resolution | Phase 3 | Ibrahim | **unassigned** |
| OD-07 | Backup monitoring and restore tests | Phase 0 go-live | Youssef | **unassigned** |
| OD-08 | Production incident response: on-call, escalation, communication with shoppers / vendors | production launch | Youssef + Ibrahim | **unassigned** |

One person may hold several roles, but the maker-checker pairs of `07` §12 still need two different people.

### 4.1 Detail per responsibility (v6) — **no owner has accepted any responsibility yet**

"Ibrahim to name" / "Youssef to name" mark the person who must name the owner; nothing here assigns anyone. Response times are proposals and stay **TBD until approved**.

| OD | Business owner | Technical owner | Backup owner | Frequency | Required access | Escalation | Evidence / logs retained | Max response time |
|---|---|---|---|---|---|---|---|---|
| OD-01 Daily maintenance | — (technical duty) | Youssef to name | Youssef to name (must differ) | daily; proof queue twice per business day | ADMIN + PLATFORM_OPERATOR (maintenance endpoints); read-only DB metrics | missed run → OD-08 the same day | maintenance audit rows (`13` §3.3), health snapshots | TBD (proposal: same business day) |
| OD-02 Outbox recovery | — | Youssef to name | Youssef to name | on alert; review DEAD daily | PLATFORM_OPERATOR | DEAD > 24 h or backlog alert unresolved 4 h → OD-08 | outbox admin audit rows, DEAD list with `lastError` | TBD (proposal: 4 business hours) |
| OD-03 Failed / late / mismatched payments, refunds follow-up | Ibrahim to name | Youssef to name (data access support) | Ibrahim to name | daily (REC-CHK-01–03, 10, 15, 18) | FINANCE (FINANCE_APPROVER for resolutions) | exception older than 3 business days → Ibrahim | exception rows, reconciliation runs, bank statement extracts | TBD |
| OD-04 Inventory discrepancies, stocktakes | Ibrahim to name | Youssef to name | Ibrahim to name | daily reconcile; stocktake cadence TBD | INVENTORY (+ FINANCE_APPROVER checker) | discrepancy older than 2 business days or affecting sold stock → Ibrahim | discrepancy rows, stocktake records, movements | TBD |
| OD-05 COD reconciliation with couriers | Ibrahim to name | Youssef to name | Ibrahim to name | per remittance; weekly ageing | FINANCE | unremitted cash > 14 days or short remittance → Ibrahim + courier account manager | remittance records, courier statements, bank receipts | TBD |
| OD-06 Financial reconciliation, statements | Ibrahim to name | Youssef to name | Ibrahim to name | daily / monthly per `12` §2 | FINANCE, FINANCE_APPROVER | any unbalanced journal or ledger-verify finding → OD-08 immediately; other discrepancies > 3 business days → Ibrahim | reconciliation runs, discrepancy rows, issued statements | TBD |
| OD-07 Backup monitoring, restore tests | — | Youssef to name | Youssef to name | daily backup check; restore test per agreed cadence | Supabase dashboard (backups); a separate restore environment | missing backup → OD-08 same day | restore records (criterion 51), backup check log | TBD |
| OD-08 Incident response | Ibrahim to name (customer / vendor communication) | Youssef to name (technical lead) | both to name | on incident | broad, time-limited (break-glass per SD-08) | severity matrix TBD | incident reports, timeline, actions, post-incident review | TBD |

**Responsibilities with no confirmed owner: all eight (OD-01 – OD-08).**

## 5. Monitoring (thresholds TBD with the owners)

| Metric | Source | Proposed starting alert | Owner |
|---|---|---|---|
| Outbox pending count / oldest pending age | `01` §7.7 | oldest > 15 min | OD-02 |
| Outbox PROCESSING with expired lease | `01` §7.7 | any > 5 min | OD-02 |
| Outbox DEAD count | `01` §7.7 | any | OD-02 |
| Overdue reservations | `01` §13.1 R-D7 | any overdue by more than 30 min (MNT-06) | OD-01 |
| Expire-overdue schedule health (computed from PostgreSQL, not Redis — MNT-10) | `MaintenanceRun` | full catalogue A1 – A15 with severity, operator action, recovery, auto-clear and deduplication in `21` §8.6: no successful run for **25 min** (A1); a run FAILED (A2); 3 consecutive FAILED / PARTIAL runs (A3); a run longer than **5 min** — 4-min budget + 1-min margin (A4); worker unavailable / crash loop (A9, A10); PARTIAL runs (A15) | OD-01 → OD-08 |
| Schedule recreated (informational) | `MaintenanceRun` (`SCHEDULE_RECONCILE`) | reconciler had to recreate the BullMQ scheduler (Redis data loss signal) | OD-01 |
| Redis health | Redis / BullMQ | unreachable; memory near limit; evictions > 0 (must stay 0 under `noeviction`) | OD-01 |
| Maintenance backlog | reservations | overdue ACTIVE reservations > 0 for more than 30 min, or more than 500 overdue groups at the start of a run | OD-01 |
| Worker / queue health | BullMQ (informational) | worker not connected; stalled jobs; failed jobs in the `orders` queue; completed / failed job counts above the retention limits of `21` §8.3.1 (cleanup not working); per-queue health when queues share one process (TD-23, `21` §8.5) | OD-01 |
| Open inventory discrepancies | inventory reconciliation | any new | OD-04 |
| Overdue proofs | proof queue | any past `reviewDueAt` | OD-03 |
| Open financial discrepancies (by age) | `12` §6 | any older than 3 business days | OD-06 |
| COD collected but not remitted (age buckets) | `fulfilment-module-spec.md` §4.3 | any > 14 days | OD-05 |
| Payouts SENT not CONFIRMED | `12` REC-CHK-14 | any > 3 business days | OD-06 |
| Last successful backup / last restore test | §2 | backup missing; restore older than the agreed cadence | OD-07 |
| DB / Redis / storage health | `/health` (today static `{ status: 'ok' }` — no dependency checks yet, `21` §8.6) | any failure; PostgreSQL unreachable or alert evaluation failing (A13); Redis unreachable (A11) | OD-08 |
