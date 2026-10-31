# 23 — Implementation Roadmap: Commerce Reliability (Reservation Expiry, Worker, Redis, Outbox, Operations)

> Status: **DRAFT for review** · 2026-10-27. Planning only — no code, schema, migration, package, configuration or provider has been changed.
> - Builds on `21` §8 (design), `22` (infrastructure readiness, verified facts, decision package), `08` (decisions and requirements), `14` (tests) and `10` (criteria).
> - **Every pending decision stays pending:** TD-18, TD-22, TD-23, TD-24, TQ-16, TQ-27, TQ-28, TQ-33 and the six Phase 0 start blockers of `08` §2.1.
> - Gates in §5 name the approval each step needs; none is assumed.
>
> **Naming.** The phases here are **R0 – R4** (reliability roadmap). They are not the commerce roadmap phases 0 – 7 of `README.md`. R0 – R3 are slices of the commerce **Phase 0** (safety) scope, and R4 is part of Phase 0 go-live readiness (PRG-03).

## 1. Executive summary

- **Order:** build the correct expiry engine first (R0), then the process and lifecycle around it (R1), then BullMQ / Redis hardening (R2), then the outbox drain (R3). External operational configuration (R4) comes last, while its requirements and acceptance criteria are fixed now.
- **R0 is technically ready to start and does not depend on TD-18, TD-22 or any provider.** It hardens the expiry logic that already runs today (in-process, `*/5`):
  - per-group failure isolation (fixes head-of-line blocking);
  - group lock first with `SKIP LOCKED`;
  - bounded retries and transaction timeouts;
  - batch looping within a time budget;
  - `MaintenanceRun` records;
  - the Redis-independent manual command.

  It needs **one explicit authorization (gate G-R0, §5)**: Youssef must confirm that this slice may start before the six Phase 0 start blockers of `08` §2.1 are decided. As scoped below it touches none of them.
- **R1 and R2 need TD-18** (the BullMQ mechanism, the `*/10` interval, schedule reconciliation). **The dedicated worker process needs TD-22.** **R3 needs TD-06 and TD-23.** **R4 needs** TQ-16, TQ-27, TQ-28, TQ-33, OD-08 and Ibrahim's cost approval.
- Nothing is sacrificed for speed: every postponed item (§9) is configuration or verification, never correctness. Production go-live remains blocked until R4 evidence exists (§10).

## 2. Verified baseline (read-only, HEAD `76921ed`)

| Area | Current code | Notes |
|---|---|---|
| Schedule | `orders/jobs/orders-jobs.service.ts`: `onModuleInit` **awaits** `upsertJobScheduler('expire-pending-checkouts-scheduler', { pattern: '*/5 * * * *' }, { name: 'expire-pending-checkouts', data: {} })` | no job options; runs in the API process |
| Processor | `orders/jobs/orders-expiry.processor.ts` → `OrdersService.expireStalePendingGroups(CHECKOUT_PENDING_TTL_MINUTES ?? 60)` | logs and rethrows errors |
| Candidates | `OrdersRepository.findStalePendingGroupIds(olderThan, 100)`: `createdAt < now − TTL` (application clock), `paymobTransactionId IS NULL`, all orders PENDING, oldest first | one batch of 100, once per run |
| Release | `OrdersRepository.cancelPendingGroup(groupId)`: one **Serializable** `$transaction`; per order a guarded `updateMany` `PENDING → CANCELLED`; `stockQuantity` incremented only when exactly one row moved | **no group-row lock**; also used by shopper cancel (`orders.service.ts` ~l.76) and admin cancel (~l.217) |
| Run loop | `expireStalePendingGroups` loops without per-group error handling | **the first failing group aborts the run; candidates are oldest first, so a group that always fails blocks every later expiry** |
| Payment webhook | `CheckoutRepository.recordPayment`: default isolation (READ COMMITTED); first a guarded `UPDATE` on the `order_groups` row (`paymobTransactionId IS NULL`), then guarded `PENDING → PAID` on the group's orders | locks the group row **first** — consistent with the L1 → L2 order of `01` §4 |
| Retry helper | none (`withRetryableTx` not present) | — |
| Run record | no `MaintenanceRun` model | `02` defines it (MNT-05) |
| Manual command | no `/admin/maintenance/*` route | MNT-13 |
| Outbox | none (domain events are in-process `DomainEvents`, after commit) | TD-06 pending |
| Health | static `/health` | — |
| Shutdown | `app.enableShutdownHooks()`; `@nestjs/bullmq` closes workers | — |
| Admin permissions | all admin routes use `@Roles(Role.ADMIN)`; no staff permissions (SD-01 pending) | — |
| Tests | `orders.service.spec.ts` (unit); e2e specs run against the configured database; `scripts/smoke-live.mjs` covers every route | `test` wipes the configured database (CLAUDE.md) |

## 3. Phases, objectives, files, tests

### R0 — Reservation-expiry reliability (Phase 0 slice; gate G-R0)

**Objective:** the existing in-process expiry job becomes safe and observable, with no change to business rules:
- same eligibility (TTL from `createdAt`, default 60 min; no Paymob transaction; all orders PENDING);
- same effect (orders CANCELLED, stock incremented once);
- same interval (`*/5`, unchanged until TD-18);
- same shopper / admin cancel behaviour.

**Changes (implementation requirements):**

| # | Change | Requirement | Design |
|---|---|---|---|
| R0.1 | **Group lock first** in `cancelPendingGroup`, using the lock sequence of §11.2: `SELECT id FROM order_groups WHERE id = $1 FOR UPDATE` — scheduled and manual expiry use `FOR UPDATE SKIP LOCKED` and report "skipped" when the row is locked; shopper and admin cancels wait, bounded by `lock_timeout`. Re-validate eligibility inside the transaction: all orders still PENDING and `paymobTransactionId IS NULL` (age needs no re-check: `createdAt` never changes, and the run's cutoff is fixed at run start — §11.7). Isolation stays **Serializable** (R0.2). Guarded order updates in ascending order id. One stock increment per variant, in ascending variant id. | MNT-02, MNT-03, `01` §4 (L1 → L2 → L6) | `21` §8.10, `22` §5.3, §11.2 |
| R0.2 | **Isolation — Serializable is kept in R0** (Youssef, 2026-10-28). R0 ships the group lock, retries and timeouts on top of Serializable. A later switch to READ COMMITTED is **not part of R0**: it needs the suite of §11.3 to pass at both isolation levels with identical safety results (E1 – E7), and it is then a separate reviewed change under TD-01's condition. Safety is never traded for performance | TD-01 condition | §11.3 |
| R0.3 | **Bounded retry** of transient failures per group: deadlock / serialization / write conflict (Prisma `P2034`; raw-query errors carrying SQLSTATE `40001` / `40P01` — mapping to verify on Prisma 6.x) and dropped connections, e.g. 3 attempts with jittered backoff; then the group counts as *failed* for this run | MNT-03, MNT-05 | `22` §5.2 |
| R0.4 | **Transaction timeouts**: `SET LOCAL lock_timeout` and `statement_timeout` inside each group transaction (values set at implementation, a few seconds) | `22` §4.5 (A4 premise) | — |
| R0.5 | **Run loop**: batches of ≤ N groups (configurable default 500, MNT-04), **keyset continuation** `(createdAt, id) > last attempted` (ordering `createdAt, id`; the cursor advances past every attempted candidate — released, skipped, not eligible or failed — and lives only in memory for that run, §11.7), so a run never re-selects a group it already tried, a **time budget** (configurable default 4 min) checked between groups, and a **stop flag** checked between groups (used for shutdown in R1) | MNT-04, `21` §8.10 item 12 | `22` §5.1 |
| R0.6 | **Per-group failure isolation**: catch per group; the group's transaction rolled back; structured log line (group id, error class); `failed += 1`; continue. A failed group stays eligible and is retried next run | MNT-05 | `22` §5.2 |
| R0.7 | **`MaintenanceRun`**: the model of `02` exactly, with no extra fields. One row per execution: RUNNING at start (with `backlogAtStart`, `oldestOverdueAtStart`), then SUCCEEDED / PARTIAL / FAILED with counts and the last error. A stale RUNNING row is closed as FAILED by a later run through one guarded update with a fixed staleness threshold (§11.7) | MNT-05 | `21` §8.6, §11.7 |
| R0.8 | **Manual command** `POST /admin/maintenance/expire-overdue` with body `{ reason }` (required, 1 – 1,000 characters, as in the existing reject DTOs): **Access:** `@Roles(Role.ADMIN)` (staff-permission scoping waits for SD-01); throttled. **Same rules as the scheduled run:** it calls the **same** run method (same eligibility, locks and transactions) with `triggeredBy = <admin id>` and a shorter time budget suited to an HTTP request (configurable, proposed ~25 s; checked against the actual timeouts in §11.9); the operator repeats it if a backlog remains. It returns the run's counts. **Audit:** one audit write is **attempted** per invocation through the existing `auditService.record({ actorId, action, targetType, targetId: runId, reason })`, after the run. Persistence is **not guaranteed**, because `record()` is best-effort (C-d, §11.4); one new `AdminAction` value and one new `AdminTargetType` value (enum-only migration). **No Redis:** no BullMQ call on this path. | MNT-13, CLAUDE.md audit rule | §11.4 |
| R0.9 | **Smoke step** for the new route | CLAUDE.md (smoke fails on an untested route) | — |
| R0.10 | *(included — Youssef's direction 2026-10-28; subject to G-R0)* **Checkout stock decrement in ascending variant id** (`CheckoutRepository.createOrderGroup` decrements in cart order today). This gives checkout and cancel the same L6 order. Together with the stock-writer inventory of §11.8 (the only multi-row stock writers are checkout and cancel; vendor writes are single-row), it removes stock-row deadlock cycles **among the paths that exist today**. It is a one-loop ordering change: behaviour, isolation (Serializable) and the out-of-stock rule are unchanged | `01` §4.2 | §11.2 |

**Not in R0 (kept for later gates):**
- interval `*/10`, reconciler, job retention and attempts (TD-18 → R1 / R2);
- per-group audit rows by a system actor (TD-04);
- outbox events (TD-06);
- reservation tables and per-reservation deadlines (commerce Phase 1);
- any change to the TTL / deadline rules (BD-07 pending);
- the dedicated worker (TD-22).

**Files expected to change:**

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` + one migration | `MaintenanceRun` model (as in `02`); enum values for the manual-command audit. Check the migration for stray `DROP INDEX` on the GIST indexes (CLAUDE.md) |
| `apps/api/src/modules/orders/orders.repository.ts` | candidate query = today's Prisma filter + keyset + `id` tie-break, cutoff from the application clock as today (§11.7); `cancelPendingGroup` with lock mode (`wait` for shopper / admin, `skipLocked` for expiry; the only raw SQL is the id-only lock statement), **Serializable kept**, timeouts, sorted increments, outcome `released / skipped / notEligible`; `MaintenanceRun` create / guarded update / guarded stale-close |
| `apps/api/src/infra/prisma/` (new helper, e.g. `retryable-tx.ts`) | bounded retry around a transaction callback (lives in `infra/` because it calls `PrismaService`, per the lint rule) |
| `apps/api/src/modules/orders/orders.service.ts` (or a new `reservation-expiry.service.ts` in the orders module) | the run loop of R0.5 – R0.7; shopper / admin cancel keep their behaviour and use the `wait` lock mode |
| `apps/api/src/modules/orders/jobs/orders-expiry.processor.ts` | calls the run with `triggeredBy = 'schedule'` and the BullMQ job id |
| `apps/api/src/modules/orders/admin-maintenance.controller.ts` (new) + `orders.module.ts` | the manual command |
| `apps/api/src/modules/audit/` (enum use only) | `auditService.record()` call for the manual command |
| `apps/api/scripts/smoke-live.mjs` | step for the new route |
| tests (§7) | unit and e2e specs |

`orders-jobs.service.ts` is **unchanged** in R0. Optional configuration of batch size and budget is constants with defaults; any new env key is optional and added to `env.validation.ts` / `.env.example` only when the implementation review agrees.

### R1 — Background worker process and lifecycle (gates G-R1a: TD-18; G-R1b: TD-22)

**Objective:** maintenance runs in a process with its own lifecycle; schedule ownership is single and reconciled; deploys hand over safely (`22` §3, §5.4).

| # | Change | Gate |
|---|---|---|
| R1.1 | Worker entry point `apps/api/src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`) and `worker.module.ts` importing config, Prisma, queue and the orders expiry processor only; `package.json` script `start:worker` | TD-22 |
| R1.2 | Split the processor registration out of the API (an `OrdersJobsModule` imported by the worker; the API stops registering the processor and the scheduler upsert in the **same release** — stage 2 of `22` §5.4) | TD-22 |
| R1.3 | Graceful shutdown: on `SIGTERM` set the R0.5 stop flag, finish the current group, close the run PARTIAL `shutdown`, then `worker.close()`; must finish within the host's `maxShutdownDelaySeconds` (Render default 30 s) | TD-18 (in-process variant needs no TD-22) |
| R1.4 | Schedule reconciler (owner only): boot check + every 60 s, single-flight, timeout, non-blocking startup; fixed id; healthy only if pattern = `*/10 * * * *` and the next run time is not overdue (`21` §8.2.1) | TD-18 |
| R1.5 | Interval `*/5` → `*/10` in the owner, in one place | TD-18 |
| R1.6 | Error listeners on every BullMQ object; unhandled rejections logged, not fatal; Redis / PostgreSQL reconnection without restart | TD-18 |
| R1.7 | Queue-specific concurrency: one BullMQ worker per queue, concurrency 1 (`21` §8.5) | TD-18 (TD-23 for other queues) |
| R1.8 | Optional heartbeat ping after each successful run, to a URL from optional configuration (inactive until R4 provides the URL) | TD-18; delivery TQ-33 |

**Without TD-22**, R1 is limited to the in-process variant (Option B of `22` §2): R1.3 – R1.8 inside the API, with the API as owner (stage 1 of `22` §5.4).

**Files:** `src/worker.ts`, `src/worker.module.ts` (new); `modules/orders/jobs/*` (ownership, reconciler); `modules/orders/orders.module.ts`; `infra/queue/*` (error listeners, connection options); `package.json` (script). `main.ts` stays the API entry point. The Dockerfile can stay unchanged if the host overrides the start command (deployment decision, R4).

### R2 — BullMQ and Redis reliability (gate G-R2: TD-18)

| # | Implementation requirement (code) | Infrastructure setting (later, R4 / TQ-27) |
|---|---|---|
| R2.1 | Job template `opts` on the scheduler: `attempts: 1`, `removeOnComplete: { count: 100, age: 86400 }`, `removeOnFail: { count: 1000, age: 604800 }` (`21` §8.3.1, verified against BullMQ 6.3.0) | — |
| R2.2 | Connections: worker connections `maxRetriesPerRequest: null` with the offline queue kept; producer (`Queue`) connections fail fast (offline queue off) — per BullMQ "going to production"; verify how `redisConnectionFromUrl` options are applied | — |
| R2.3 | Reconciler detects a missing scheduler **and** a scheduler without its next job (AT-MNT-12 b) | — |
| R2.4 | Monitoring hooks: queue counts (waiting / active / delayed / failed) readable for the health endpoint (R4) | — |
| R2.5 | No business state in Redis: empty payload; eligibility from PostgreSQL (already true; keep it under test, AT-MNT-09) | — |
| — | — | `maxmemory-policy = noeviction` (Redis Cloud default is `volatile-lru`) |
| — | — | persistence AOF every second (not available on the free plan) |
| — | — | memory, connection and throughput limits vs measured usage |
| — | — | restart / failover test |

**Recovery split** (unchanged, `21` §8.2.1): a schedule is recovered by the reconciler; a job by BullMQ stall detection, if Redis still holds it; business operations by the next run reading PostgreSQL.

### R3 — Outbox drain (gates G-R3a: TD-06; G-R3b: TD-23)

The design is `01` §7 (TD-06, pending): outbox rows written in the business transaction; per-consumer deliveries with lease, `SKIP LOCKED` claim, retry schedule, DEAD; `processed_events` for idempotent consumers; recovery by boot sweep, piggy-back drain, admin drain and a scheduled drain (proposed every 5 min, independent of expiry). **Nothing of this exists in code.**

| Question | Answer from the specs | Status |
|---|---|---|
| Share the worker process? | allowed as separate queue `outbox` in the same process under the conditions of `21` §8.5 | **TD-23 pending** — not decided here |
| Queue / schedule | own queue, own scheduler (fixed id), every 5 min (proposed), concurrency 1, job `attempts: 1` | proposal |
| Retry / recovery | per-delivery backoff 1 s → 10 min, max 10 → DEAD; requeue by admin (OBX-09) | `01` §7.3 – §7.9 |
| Duplicate prevention | lease + guarded completion + `processed_events` unique per (consumer, event) | `01` §7.4, §7.6 |
| Transactional consistency | events inserted in the same transaction as the business change; consumers never change money or stock (`01` §7.8) | TD-06 |
| Monitoring | pending / oldest / expired-lease / DEAD metrics; `MaintenanceRun` `OUTBOX_DRAIN`; heartbeat M2 (`22` §4.3) | proposal |

**Files** (once approved): the `02` §3.9 models + migration, a new `modules/outbox/` (repository, drain service, admin controller), producers in the modules that emit events. Admin drain permissions depend on SD-01 (PLATFORM_OPERATOR); until then `@Roles(ADMIN)` like every admin route.

### R4 — Operational readiness (postponed configuration; requirements fixed now)

| Item | Requirement and acceptance criterion | Source |
|---|---|---|
| Hosting | always-on API + worker (Option A recommended); evidence 1–6 of `22` §2 recorded | TQ-16, TQ-28 |
| Redis | the six `21` §8.3 evidence items on a plan with persistence and `noeviction`, or a recorded acceptance of the free-plan limits | TQ-27 |
| Alert delivery | Better Stack (proposed) monitors M1 – M5; health endpoints `/health/dependencies`, `/health/maintenance` (code, can be built in R1 / R2); one test incident per severity received; incident raised with PostgreSQL stopped | TQ-33, AT-MNT-04 |
| Error tracking | optional Sentry (free) | `22` §4.2 |
| Paging | paid responder licence or recorded acceptance of e-mail + Slack | OD-08 |
| Dashboards | deferred (queries on demand) | — |
| Rehearsals | AT-MNT-11, AT-MNT-12, AT-MNT-16 – AT-MNT-20 on the chosen host; AT-MNT-21 L1 – L7 against P1 – P8 | criteria 63 – 65 |

## 4. Dependencies between phases

```
R0 ──► R1 ──► R2 ──► R4 (go-live evidence)
        │            ▲
        └──► R3 ─────┘     (R3 needs TD-06 + TD-23; may run in parallel with R2 after R1)
```

- R1 builds on R0's stop flag, run loop and `MaintenanceRun`.
- R2's retention and reconciler checks extend R1's ownership.
- R3 reuses R1's process and lifecycle if TD-23 chooses a shared process.
- R4 rehearsals need R1 – R3 deployed on the chosen host.

## 5. Approval gates

| Gate | Needed for | Exact approval required | Owner | Blocks now? |
|---|---|---|---|---|
| **G-R0** | starting R0 | authorize the reservation-expiry slice to be coded before the six Phase 0 start blockers (`08` §2.1) are decided — it needs none of them (no `AdminAuditLog` shape change, TD-04; no outbox, TD-06; no checkout contract change, TD-07; no vendor stock route, TD-08; no money columns, FD-01; real parallel connections and a test-only trigger instead of application race hooks, TD-12); **and** explicitly authorize the database changes of §11.6. Youssef's positions of 2026-10-28 are recorded in §11.5; open items there | Youssef | **yes — R0 cannot start without it** |
| G-R1a | R1.3 – R1.8, R2 | **TD-18** approved (BullMQ mechanism, `*/10`, reconciler) | Youssef | yes for R1 / R2 |
| G-R1b | R1.1, R1.2 | **TD-22** approved (dedicated worker); otherwise R1 stays in-process | Youssef | yes for the worker process only |
| G-R3a / G-R3b | R3 | **TD-06** (outbox design) and **TD-23** (where it runs) | Youssef | yes for R3 |
| G-R4 | go-live | TQ-16, TQ-27, TQ-28, TQ-33 closed with evidence; OD-08 paging; hosting cost approved by **Ibrahim** | Youssef, Ibrahim | no for implementation; yes for production |
| — | — | **TD-24** (`MaintenanceRun` retention): not a blocker — nothing deletes rows until it is decided | Youssef | no |

No business decision is needed for R0 – R3. They change no price, window, policy or customer-visible rule. BD-07 (windows) and the commerce Phase 1 reservation model stay outside this roadmap.

## 6. Acceptance criteria per phase

| Phase | Done when | Tests / criteria |
|---|---|---|
| R0 | every R0 change merged after staged review; a skipped group is released by a later run once its lock is gone (AT-MNT-22); the eligibility of the new candidate query equals the old one on fixtures; one failing group never blocks others; no double restock under any tested interleaving; `MaintenanceRun` written for every run, including failures; manual command audited and safe alongside a scheduled run; existing e2e, smoke, lint and typecheck green | AT-MNT-01, 02, 03, 05 (Phase 0 statuses), 08, 09, 14, 15, 22, 23; C-MNT1; C-D1 / C-10 (cancel races); criterion 60 (R0 part), 66 (R0 items) |
| R1 | the worker starts, shuts down between groups within the grace period, survives Redis / PostgreSQL outages, owns the schedule alone, and deploy overlap releases nothing twice | AT-MNT-06, 11, 13, 18 – 20; C-MNT2, C-MNT3; criterion 63, 64 |
| R2 | retention bounded, the reconciler restores both missing-scheduler cases, connections configured per BullMQ guidance | AT-MNT-10, 12, 17; criterion 60, 63 |
| R3 | outbox scenarios pass | AT-OB-01 – AT-OB-10, C-O1 – C-O4, AT-MNT-16 if shared; criteria 25, 41, 42 |
| R4 | `22` §9 "before production go-live" list complete | AT-MNT-04 (delivery), AT-MNT-21; criteria 63 – 66; PRG-03 |

## 7. Tests

All database tests run on **real PostgreSQL** (`riven_test`), never mocks (TD-01 condition); `test` wipes the configured database (CLAUDE.md).

| Kind | R0 tests |
|---|---|
| Unit (`orders.service.spec.ts` or the new service spec) | the loop stops at the budget and at the stop flag; keyset never re-selects; a thrown group increments `failed` and the loop continues; retry classification (which errors retry, how many times); run status rules (SUCCEEDED / PARTIAL / FAILED); stale RUNNING close |
| Integration (e2e on real PostgreSQL) | candidate parity for the **same cutoff instant**: old filter vs new query on fixtures (groups 1 ms either side of the cutoff, equal `createdAt` ties, Paymob transaction present, mixed order statuses, SHIPPED / PAID / FULFILLED groups excluded), also run with a non-UTC database session `TimeZone` to prove the comparison does not depend on it; production-path creation and query-log assertion of §11.12; manual retry while running (AT-MNT-23); keyset and `SKIP LOCKED` (AT-MNT-22): a group locked by a test connection is skipped and not retried in the same run (`skipped = 1`); after the lock is released the next run releases it exactly once (one restock, `released = 1`); while the lock is held across two runs, both skip it and neither releases it; stale close: two runs closing the same stale row concurrently close it once, and a live run's row is never closed; release: orders CANCELLED and stock +qty once; `MaintenanceRun` row contents; manual command (200, counts, audit row, works with Redis stopped) |
| Concurrency (parallel connections) | two runs at once (each group once, the other skipped — C-MNT1); manual command during a scheduled run; shopper cancel vs expiry on the same group (one effect); **webhook `recordPayment` vs expiry** (never PAID and CANCELLED in one group; no restock of a paid order); a test holding the group lock in another connection → run skips it, user cancel waits then sees the result |
| Failure recovery | test-only trigger raising inside one group's transaction → that group rolled back, others released (AT-MNT-14); the same group failing every run → newer groups still released, failure counted each run (AT-MNT-15); connection drop mid-group → rolled back, retried next run (AT-MNT-03); deadlock forced on variant rows → bounded retry |

R1 – R3 tests are those in the §6 table (`14`, `05`).

## 8. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Changing `cancelPendingGroup` (shared with shopper / admin cancel) alters concurrency behaviour | group lock first, as the webhook already does; guarded updates kept; **Serializable kept in R0**; any move to READ COMMITTED is a separate reviewed change after R0 (§11.3) | **revert the code only.** Keep `maintenance_runs` and the new enum values: old code ignores them, and operational history is never dropped automatically (§11.6) |
| The new candidate query selects a different set than today | R0 keeps today's Prisma filter and application-clock cutoff (§11.7); parity test at the same cutoff instant, including ties and a non-UTC session time zone. The only intended differences: more groups per run (looping) and an `id` tie-break in the order | revert the code only (tables and enum values retained) |
| Longer runs (looping) increase database load | budget, batch size and transaction timeouts configurable; `*/5` interval with a 4-min budget, and overlap is safe | lower the budget / batch size by configuration |
| Enum value migrations cannot easily be removed | additive only; reviewed with the schema stage | leave unused values |
| A raw SQL lock statement outside repositories | all raw SQL stays in `*.repository.ts` (architecture rule; lint) | — |
| R1 ownership transfer during a deploy | the same release removes the API's upsert and processor; overlap is safe (`22` §5.4) | stop / suspend the worker; the API's boot upsert restores ownership |
| R2 retention removes failed jobs needed for inspection | `MaintenanceRun` is the record; failed set kept 7 days / 1,000 | widen the limits |
| R3 outbox consumers with side effects | consumers limited to notifications (`01` §7.8) | disable the drain; rows stay in PostgreSQL |

## 9. Safely postponed until production preparation (R4)

These are postponed because they are configuration or verification, not correctness:
- Better Stack monitors and Sentry; e-mail / Slack destinations; the paging decision; dashboards.
- Production hosting configuration (`render.yaml` worker service, `maxShutdownDelaySeconds`, plan purchase).
- Redis Cloud plan and settings, and their verification.
- Recovery rehearsals on the chosen host; AT-MNT-21 load tests on the rehearsal snapshot.
- TD-24 retention period.

**Not postponable:** the R0 – R2 code properties — failure isolation, locking, retries, timeouts, the budget, `MaintenanceRun`, the manual command, graceful shutdown, single schedule ownership, retention options. Without them correctness itself is at risk, not only operations.

## 10. Implementation complete vs production ready

| | Implementation complete (per phase) | Production ready |
|---|---|---|
| Meaning | the phase's code is merged after staged review (repository / service → controllers / DTOs → tests), tests of §6 / §7 pass in CI on real PostgreSQL, docs updated, no pending decision assumed | the system is shown to work **on the chosen production infrastructure**, with operators reachable |
| Evidence | green CI (lint, typecheck, unit, e2e), smoke run, diff reviewed | `22` §9 go-live list; TQ-16 / TQ-27 / TQ-28 / TQ-33 closed with recorded evidence; AT-MNT-21 against P1 – P8; PRG-03 |
| Who decides | Youssef (technical) per stage | Youssef + Ibrahim (cost, paging, launch) |

Implementation complete never implies production ready. Production launch also requires every commerce phase exit and the PRG gate (`README.md`, `10` §6).

## 11. G-R0 clarifications (verified read-only, 2026-10-27; G-R0 **not** approved)

### 11.1 Reservation TTL

| Source | What it says | Status |
|---|---|---|
| Code | `CHECKOUT_PENDING_TTL_MINUTES`, Zod default **60** (`infra/config/env.validation.ts`); processor fallback 60; `.env.example` shows it commented out (`# …=60`); `render.yaml` does not set it. It applies to **every** unpaid group (all orders PENDING, no Paymob transaction), measured from `OrderGroup.createdAt` | implemented. **Production value: not verifiable — see §11.1b** |
| `08` BD-07 "Payment and reservation windows" | earlier recommendation: Paymob 60 min + 15 min grace, cap 90 min; transfer 2 h to submit, 24 h to resubmit, cap 72 h; COD confirmation 24 h. v7 Part Four: Youssef proposes **30 minutes** for InstaPay / wallet **proof submission** | **PENDING IBRAHIM** — no window is approved |
| `21` §3 | TRANSFER (InstaPay / wallet) `expiresAt = createdAt + 30 min` (**proposed**); PAYMOB 60 + 15 min, cap 90 | proposal; TRANSFER is not implemented in code |
| `payments-module-spec.md` (pass 1) | a pending Paymob payment session older than 30 min is marked FAILED | superseded by the commerce specs |
| Earlier briefs and several sentences of `21` / `22` | "30-minute customer reservation window" | **documentation conflict**: they generalize a TRANSFER-only proposal into a general window |

**Verified rule for R0: no reservation window is approved.** The only implemented rule is today's 60-minute TTL (configurable) for all unpaid groups, and **R0 keeps it unchanged**. The 30 minutes is Youssef's unapproved proposal for one payment method that does not exist in code yet. The generalized wording in `21` / `22` has been corrected (2026-10-27) to "the proposed 30-minute TRANSFER proof window (BD-07 pending)".

**Youssef's positions (2026-10-28; G-R0 still pending):** C-a — R0 keeps the 60-minute TTL. C-b — the actual production value must be verified and documented, not assumed from the Zod default (§11.1b). BD-07 stays Ibrahim's decision and is **not** needed for R0.

### 11.1a Payment methods under the generic TTL — COD (verified read-only, 2026-10-28)

| Question | Finding (code at HEAD `76921ed`) |
|---|---|
| Which payment methods exist? | **Only Paymob.** There is no payment-method field, enum or table (`OrderGroup` has only `paymobIntentId`, `paymobOrderId`, `paymobTransactionId`, `paidAmountCents`, `paidAt`); no COD, InstaPay or wallet code exists. `CheckoutService.executeCheckout` always creates the group with PENDING orders and **reserves stock first**, then tries `PaymobService.createIntention`; when Paymob is not configured or fails it returns `paymentSetupFailed: true`, and the orders stay PENDING with stock reserved |
| Which methods use the generic TTL? | every checkout, i.e. every Paymob checkout: groups whose intention failed (`paymentSetupFailed`), groups with an intention but no webhook yet, and groups with any PENDING-only orders and no recorded transaction. Groups with a recorded Paymob transaction, or with any order not PENDING, are excluded. The TTL counts from `OrderGroup.createdAt`, not from payment initiation |
| Are COD orders included today? | **No COD order can exist today**, so none is expired. **But the eligibility rule is not method-aware:** "all orders PENDING, no Paymob transaction, older than the TTL" would match a future COD group (COD has no Paymob transaction and stays unpaid until delivery) |
| Could a COD order be cancelled and its stock released after 60 min? | **Not today** (no COD). **Yes in the future** if COD is added with PENDING orders and this rule unchanged. That contradicts the design: `21` §3 says COD has **no prepaid payment deadline** and only a confirmation-call window (24 h proposed, BD-13 pending); dispatched stock is never released (DSP-01). **Recorded as a latent conflict** |
| Current behaviour vs future policy | current: one 60-min TTL (configurable) for all unpaid Paymob checkouts. Future, all pending Ibrahim: PAYMOB 60 + 15 min grace, cap 90 (BD-07); TRANSFER 30-min proof window (Youssef's proposal, BD-07); COD confirmation window (BD-13). None of these is implemented or approved |

**Safe correction (proposed; R0 does not change behaviour):**
1. **R0 isolates the rule in one place.** The eligibility rule becomes a single, named repository predicate ("Paymob-era unpaid checkout"), used by both the candidate query and the in-lock re-validation. A unit / e2e test pins its scope: a group with a recorded transaction, or any non-PENDING order, is never selected. This is a structural change only. For the same cutoff instant the eligible set equals today's (same Prisma filter and clock, §11.7). Proven by the parity test, not assumed. Per run, more groups are processed, by design (looping instead of one batch of 100).
2. **COD release gate.** When payment methods are introduced (commerce Phase 0 `PaymentTransaction` / Phase 4 COD, `payments-module-spec2.md`), the same change must make expiry eligibility **method-scoped**: the generic TTL applies to PAYMOB only, TRANSFER to its own deadline, and COD only to its confirmation window. **COD must not be enabled** — for checkout in any deployed environment, not only in production (which COU-01 already blocks) — until **(a)** its expiry eligibility is separated from prepaid-payment expiry (the generic TTL applies to PAYMOB only, shown by a regression test that never selects a COD group), and **(b)** AT-RSV-09, AT-RSV-10 and AT-DSP-02 pass. Recorded in the Phase 4 exit row of `10` §5 and in `21` §3. It needs no new decision: the COD windows themselves stay pending under BD-13, and COU-01 / PRG-07 still govern production.
3. **No silent behaviour change:** R0 changes no eligibility, and no method is added.

### 11.1b Production value of `CHECKOUT_PENDING_TTL_MINUTES` (C-b; verified 2026-10-28)

| Source | Result |
|---|---|
| `render.yaml` (tracked) | key **not set** |
| `.env.example` | commented out (`# CHECKOUT_PENDING_TTL_MINUTES=60`) |
| `.env` on this machine (git-ignored) | key **not set** (only the key name was searched; no values were read or printed) |
| `.env.production.local` on this machine (git-ignored) | key **not set** (same method) |
| Hosting dashboard of any deployed environment | **not accessible** from this session; whether a production deployment exists is not recorded in the repo (API hosting status: TQ-09, `22` §1.1) |

**Status: not verified.** Every configuration source available here leaves the key unset, so any environment built from them inherits the Zod default of **60**. Whether a live host overrides it can only be confirmed in that host's environment settings. **C-b stays open:** Youssef (or the host owner) records the value shown in the host's environment settings, or confirms no production deployment exists, before R0 is deployed anywhere. It does not block coding R0, which keeps the configurable TTL unchanged.

### 11.2 Lock ordering across the paths that write an order group

**Sequence for every path (after R0):** L1 → L2 → L6 of `01` §4.
1. **L1 — the `order_groups` row.** Expiry: `FOR UPDATE SKIP LOCKED`. Shopper / admin cancel: `FOR UPDATE`, bounded by `lock_timeout`. Webhook: its existing guarded `UPDATE order_groups … WHERE paymobTransactionId IS NULL`, which takes the same row lock.
2. **L2 — the group's `orders` rows**, by guarded `UPDATE … WHERE status = 'PENDING'`, in ascending id where updated one by one.
3. **L6 — `product_variants.stockQuantity`**, one atomic increment or decrement per variant, in **ascending variant id**.
4. **`MaintenanceRun` writes** happen **outside** the group transactions (their own short statements), so they never take part in the group lock order.

| Path | Code today | L1 | L2 | L6 | Change in R0 |
|---|---|---|---|---|---|
| Reservation expiry | `cancelPendingGroup` via `expireStalePendingGroups` | **none** | guarded per order | increments in item order | L1 `SKIP LOCKED`; re-validate; sorted L6 |
| Shopper cancel | `cancelOrder` → `cancelPendingGroup` | **none** | as above | as above | L1 wait; sorted L6 |
| Admin cancel | `cancelOrderForAdmin` → `cancelPendingGroup`, then one audit row per cancelled order | **none** | as above | as above | L1 wait; sorted L6; audit unchanged |
| Paymob webhook | `recordPayment`: default isolation; guarded group `UPDATE`, then guarded `PENDING → PAID` | **yes** (via `UPDATE`) | guarded set update | none | **none** — already L1 first |
| Checkout (creates a new group) | `createOrderGroup`, Serializable: creates the group and orders, decrements variants in **cart order** | own new row | own new rows | decrements, **unsorted** | R0.10: sort decrements |
| Vendor status updates | `transitionOrderStatus(from, to)` on PAID → … → SHIPPED (PENDING is refused) | none | guarded single order | none | none — never touches PENDING orders |

**Expected behaviour when two operations hit the same group:**

| A ∥ B | If A locks first | If B locks first | Guarantee |
|---|---|---|---|
| Expiry ∥ expiry (overlap or manual + scheduled) | B skips the group (`SKIP LOCKED`), counted as skipped | symmetric | released once |
| Expiry ∥ shopper or admin cancel | the cancel waits, then its guarded updates move 0 rows → today's `ORDER_STATE_CHANGED` 409 (unchanged; the order is cancelled either way) | expiry skips; the next run finds nothing eligible | stock restored once |
| Expiry or cancel ∥ webhook | webhook waits; then it claims the group (still no transaction id), records the payment, moves 0 orders to PAID → its existing "recorded for manual refund, nothing marked paid" branch (unchanged behaviour) | the cancel / expiry waits (expiry skips); afterwards the group has a transaction id and PAID orders → expiry not eligible; cancel moves 0 rows → 409 | never PAID and CANCELLED in one group; no restock of a paid order; money recorded, never lost |
| Shopper cancel ∥ admin cancel | the second sees no PENDING order → 409 | symmetric | one cancel; audit rows only for orders actually cancelled |
| Cancel / expiry ∥ checkout of another group on shared variants | no L1 conflict; L6 increments and decrements are atomic. With R0.10 both run in ascending variant id → no deadlock cycle between them (§11.8). Serializable can still abort one side with 40001 → cancel / expiry retries (R0.3); checkout returns today's error | — | no lost update **between checkout and cancel**. The vendor's absolute stock write can still overwrite either (§11.8, TD-08) |

### 11.3 Isolation decision and the tests behind it

**Decision rule (unchanged proposal, TD-01 condition):** R0 ships the L1 lock, bounded retries and `lock_timeout` / `statement_timeout` with **Serializable kept**. READ COMMITTED is **not part of R0**: it can replace Serializable in `cancelPendingGroup` only in a **separate, reviewed change after R0**, and only if the suite below passes for both isolation levels with identical safety results. Any failure or doubt keeps Serializable. The decision and its test output are recorded in the R0 review (`08` when Youssef accepts it).

**Suite** (real PostgreSQL `riven_test`; every race uses **independent connections**, not one Prisma client sharing a transaction; each scenario repeated ≥ 200 times with randomized start offsets, plus deterministic variants where a test connection holds the group or variant lock while the other side starts):
1. expiry ∥ expiry;
2. manual ∥ scheduled;
3. expiry ∥ shopper cancel;
4. expiry ∥ admin cancel;
5. shopper ∥ admin cancel;
6. expiry ∥ webhook (paid and unpaid outcomes);
7. cancel ∥ webhook;
8. cancel / expiry ∥ checkout on shared variants (2–5 common variants in opposite cart order);
9. a group locked by a test connection → expiry skips, cancel waits until `lock_timeout`;
10. a fault injected by a test-only trigger in one group → rollback, others released;
11. a connection killed mid-transaction.

**Equivalence properties (each checked with SQL after every iteration):**

| # | Property |
|---|---|
| E1 | no group has both PAID and CANCELLED orders |
| E2 | stock increments = exactly the quantities of orders that became CANCELLED (final `stockQuantity` = initial − active PENDING / PAID quantities) |
| E3 | no PAID order was restocked |
| E4 | a payment for a cancelled group is recorded and never applied |
| E5 | no lost update on `stockQuantity` under concurrent checkouts and cancels |
| E6 | every order changes status at most once per race |
| E7 | every deadlock or serialization failure is either retried to success or surfaced as the path's defined error — never a partial write |

Serialization-failure, deadlock and retry counts are reported per isolation level. A higher retry rate is acceptable; any violation of E1 – E7 is not.

### 11.4 `MaintenanceRun` and manual-command guarantees

| Guarantee | How |
|---|---|
| Every execution creates a run record | the run row (RUNNING) is inserted **before** candidate selection; if the insert fails (e.g. database down) the run stops and processes nothing, so no group is ever processed without a record |
| Failed and partial runs are accurate | SUCCEEDED = no group failed; PARTIAL = ≥ 1 group failed, or stopped by shutdown (`error = 'shutdown'`); FAILED = run-level error (candidate query fails), or a stale RUNNING row closed by the next run (`error = 'stale'`, when `startedAt` is older than budget + margin). Counts `candidates`, `processed`, `released`, `skipped`, `failed`, `batches` are written at the end; a budget-limited run with backlog left is SUCCEEDED (or PARTIAL) and the backlog shows as the next run's `backlogAtStart` |
| Manual works without Redis | the controller calls the service directly; no queue, scheduler or job is involved; `jobId` is null |
| Manual uses exactly the scheduled rules | one run method for both triggers; only `triggeredBy` and the time budget differ; same candidate query, lock (`SKIP LOCKED`), re-validation, guarded updates, retries and timeouts |
| Repeated manual runs cannot release twice | concurrent: `SKIP LOCKED` + guarded updates (C-MNT1); sequential: a released group is no longer eligible. The endpoint is throttled |
| Manual retry while the previous run is still RUNNING | see §11.10; proven by AT-MNT-23 |
| Who and why | **who** is guaranteed: `MaintenanceRun.triggeredBy = <admin id>` is written **before** processing, and the run does not start without it. **Why** is attempted, not guaranteed: one `AdminAuditLog` write is **attempted** per invocation through the existing `auditService.record()` (`actorId` from `@CurrentUser()`, `targetType` = the new maintenance-run value, `targetId` = run id, `reason` = the required reason), after the run. `record()` is best-effort — it logs its own failure and never fails the request (CLAUDE.md) — so the row can be missing after a crash or insert failure (C-d; TD-04 pending) |

**Audit convention points (no redesign):**
- **C-c (Youssef, 2026-10-28): an audit write is attempted for every manual invocation, even when it releases zero reservations**, with the admin id (`actorId` from `@CurrentUser()`) and the required reason. Persistence of that row is best-effort (C-d).
- **Per-order audit rows by a system actor are not added.** That needs TD-04's nullable actor.
- **C-d (Youssef, 2026-10-28): R0 keeps the existing audit-after-commit behaviour. This does NOT satisfy TD-03** (approved: audit inside the transaction for sensitive inventory operations). TD-04 remains the required follow-up.
  - **Today:** no expiry or shopper-cancel path writes audit at all, and the admin cancel writes best-effort after commit.
  - **Risk:** audit is written after the run, and `record()` only logs its own failure (CLAUDE.md). So if the process dies, or the audit insert fails, after groups were released, the release stands but **the audit row is missing**.
  - **Partial mitigation:** the `MaintenanceRun` row, written **before** processing with `triggeredBy = <admin id>`, still shows who started the run and what it released. The **reason** exists only in the audit row and would be lost in that case.
  - **Not adopted:** writing the audit row before the run. That would change the existing convention, so it waits for TD-04.

### 11.5 What remains before G-R0 can be approved

**G-R0 decision table (updated 2026-10-28; G-R0 is NOT approved):**

| # | Item | Youssef's position (2026-10-28) | Verified finding | Status |
|---|---|---|---|---|
| C-a | TTL in R0 | keep 60 min; do not change | the implemented TTL is 60 min (configurable) for every unpaid Paymob checkout; no window approved (BD-07 pending Ibrahim) | position recorded |
| C-b | production TTL value | verify and document; do not assume the default | not set in any configuration source available here; any live host must be checked in its own settings (§11.1b) | **open** — record before R0 is deployed; does not block coding |
| C-e | production DB session `TimeZone` | — (new, 2026-10-28) | **corrected 2026-10-29 by test:** Prisma 6 sends `createdAt` itself (application clock, UTC); the database default is not used, and a non-UTC session does not shift it (§11.12) | **no longer needed for `createdAt`**; keep as a low-priority check for raw-SQL defaults |
| C-c | manual audit | every invocation audited, even with zero releases; admin id + required reason | an audit write is **attempted** for every invocation via the existing `auditService.record()` (`reason` field exists); persistence is best-effort (C-d) | position recorded |
| C-d | audit timing | keep after-commit in R0; document the risk; TD-04 remains the follow-up; not TD-03 compliance | risk documented (§11.4) | position recorded |
| R0.10 | sorted checkout decrement | include | one-loop ordering change in `createOrderGroup` | included in R0 scope |
| Isolation | Serializable vs READ COMMITTED | keep Serializable in R0; switch only after the suite passes at both levels with identical safety results | suite and properties E1 – E7 defined (§11.3) | position recorded; switch outside R0 |
| COD | generic TTL vs COD | COD must not expire as an online payment | no COD in code today; latent conflict; correction §11.1a | documented; Phase 4 entry criterion |
| DB | migration scope | keep in G-R0 scope, listed as database changes requiring explicit authorization | §11.6 | **requires explicit authorization** |

**Remaining risks:**
1. Audit-after-commit can lose the audit row on a crash; the reason is then lost (C-d, until TD-04).
2. The production TTL is unverified (C-b).
3. The latent COD conflict, until method-scoped eligibility exists (§11.1a).
4. Keeping Serializable leaves serialization failures under contention, now retried by R0.3 instead of aborting the run.
5. Checkout behaviour changes only in decrement order (R0.10); covered by suite item 8.

**Blockers to approving G-R0:** none technical. Approval itself is pending: Youssef's explicit G-R0 decision, including the database changes of §11.6. C-b must be closed before any deployment, not before coding.

### 11.6 Database changes in R0 (require explicit implementation authorization)

| # | Change | Kind | Reversibility |
|---|---|---|---|
| DB-1 | new table `maintenance_runs` (model `MaintenanceRun` exactly as in `02`; one index `(command, startedAt)`) | additive migration | **retained on rollback.** A code revert leaves the table in place (old code ignores it). Dropping it would destroy operational history and is never automatic: only a separate, explicit decision may drop it (retention policy TD-24, pending) |
| DB-2 | one new `AdminAction` enum value for the manual expire command | `ALTER TYPE "public"."AdminAction" ADD VALUE …` (enum-only, hand-written per CLAUDE.md) | values cannot be dropped easily; an unused value is harmless |
| DB-3 | one new `AdminTargetType` enum value for a maintenance run | same | same |

No other schema change is in R0: no column on existing tables, no change to indexes, constraints or GIST indexes (the migration is checked for stray `DROP INDEX`, CLAUDE.md). Exact enum value names are fixed in the schema review stage.

Rollback rule for DB-1 – DB-3: **revert the code, keep the schema.** Tables and enum values added by R0 stay; nothing is dropped automatically.

### 11.7 Clock, keyset and stale-run semantics (review 2026-10-28)

**Clock — R0 keeps today's semantics exactly.**
- **Today:** `olderThan = new Date(Date.now() − TTL)` is computed in the application, once per run, and passed to a Prisma filter on `OrderGroup.createdAt`.
- **Column facts (verified):** `order_groups."createdAt"` is `TIMESTAMP(3)` **without time zone**, `DEFAULT CURRENT_TIMESTAMP` (migration `20260823150614`). Whether Prisma sends the value itself or leaves it to the database default is **unverified** from the code.
- **Why a database-clock comparison is risky:** `now()` is `timestamptz`, so comparing it with this time-zone-less column depends on the session `TimeZone`. If application and database clocks differ, the boundary moves by the skew. Exact parity could therefore not be claimed.
- **R0 decision:** the cutoff is computed **once per run, from the application clock, as today**. Candidate selection stays a **Prisma** query with today's filter, plus keyset and an `id` tie-break. The only raw SQL is the id-only lock statement (`SELECT id FROM order_groups WHERE id = $1 FOR UPDATE [SKIP LOCKED]`), which compares no timestamps.
- **Parity:** for the same cutoff instant the eligible set is identical, shown by the parity test (§7: 1-ms boundary fixtures, ties, non-UTC session `TimeZone`). **Not claimed:** identical runs. Per run, more groups are processed, by design.
- **Moving to the database clock** (as `21` §8 MNT-02 describes for the target design) is an **intentional boundary change**, outside R0. It needs its own reviewed change with tests for clock skew and the time-zone handling of `TIMESTAMP` without time zone.

**Keyset and `SKIP LOCKED`.**
- Each run fixes its cutoff, then reads candidates in batches ordered by `(createdAt, id)`, starting after an in-memory cursor `(lastCreatedAt, lastId)`.
- The cursor advances past **every attempted candidate**, whatever the outcome: released, skipped because `FOR UPDATE SKIP LOCKED` returned no row, not eligible on re-validation, or failed after retries. So a run attempts each candidate at most once.
- The cursor is **never persisted**. The next run starts from the beginning.
- A skipped or failed group remains PENDING in the database and still matches the filter, so **the next run reconsiders it**. Eligibility comes only from database state, never from the cursor.
- **Lock timeouts alone do not guarantee eventual processing.**
  - R0's timeouts bound only the transactions R0 changes (cancel and expiry). The webhook's `recordPayment`, checkout and any manual database session have none, and nothing stops a group from happening to be locked at the moment of every attempt.
  - What R0 guarantees is **reconsideration**, not processing: a skipped group stays PENDING and eligible in the database, every later run selects it again from database state, and it is released by the **first** run whose attempt finds it unlocked.
  - Normal locks last milliseconds to seconds and runs repeat every 5 minutes, so a repeat collision is unlikely — but that is likelihood, not a guarantee.
  - **Detection covers the rest:** each run's `skipped` count, alert A5 (any reservation overdue by more than 30 min) and A15-style per-group logging, plus the manual command.
  - **Proven by AT-MNT-22:** a group skipped while another connection holds its lock is released by a later run once the lock is gone, exactly once.

**Stale RUNNING rows under concurrent executions.** Concurrent runs (scheduled and manual) are allowed, so "another run is RUNNING" never means "stale". Only age does.
- **Closing** is one guarded statement: `UPDATE maintenance_runs SET status = 'FAILED', error = 'stale', "finishedAt" = … WHERE status = 'RUNNING' AND "startedAt" < cutoffStale`, through Prisma `updateMany`. The cutoff comes from the same application clock that wrote `startedAt`.
- **Concurrent closers:** two runs closing the same row close it once. The second waits for the row lock, re-checks `status = 'RUNNING'` and matches nothing.
- **Threshold:** `staleAfter` must exceed the longest possible legitimate run: the 4-min scheduled budget, plus one group transaction at its worst (statement timeout × retry attempts), plus finalization. Proposed: **15 min** (configurable, fixed at implementation from the chosen timeouts). It also absorbs small clock skew between instances.
- **Owner's final update** is guarded too (`WHERE id = $own AND status = 'RUNNING'`). If it matches nothing (closed as stale in a pathological case), it logs and does not overwrite. The committed group changes stand, and the row stays FAILED / stale with unknown counts. That is an accurate "outcome unknown" record, not a false success.
- A run killed mid-way leaves its row RUNNING until a later run closes it as stale. Its committed groups are already released, and the rest are picked up by the next run.

### 11.8 Every writer of `product_variants.stockQuantity` (verified read-only, 2026-10-28)

Search: every `stockQuantity` / `stock_quantity` occurrence and every `productVariant.create|update|updateMany|upsert|createMany` call in `apps/api/src`, plus raw SQL (`$queryRaw` / `$executeRaw` are used only in `bazaars.repository.ts` and never touch stock), `prisma/seed.ts` (no stock writes) and `scripts/` (`smoke-live.mjs` writes stock only through the API).

| # | Path | Code | Transaction boundary | Rows locked, in order |
|---|---|---|---|---|
| W1 | Checkout | `CheckoutRepository.createOrderGroup` | one **Serializable** interactive transaction | inserts the new group and orders (own new rows) → `productVariant.update` **decrement** per cart item, in **cart order** (R0.10: ascending variant id) → `cartItem.deleteMany` for the shopper's cart |
| W2 | Cancel / expiry | `OrdersRepository.cancelPendingGroup` (shopper cancel, admin cancel, expiry) | one **Serializable** interactive transaction | today: the group's orders → `productVariant.update` **increment** per item, in item order. R0: group row (L1) → orders by id (L2) → increments aggregated per variant, ascending variant id (L6) |
| W3 | Vendor creates a variant | `VendorsRepository.createProductVariant` (`stockQuantity` from the DTO) | single statement, autocommit | the new row only — no contention |
| W4 | Vendor updates a variant | `VendorsRepository.updateProductVariant(variantId, dto)` — `UpdateProductVariantDto` may carry `stockQuantity` | single statement, autocommit | **one** variant row; the stock value is **set absolutely**, not changed by a delta |
| — | Payment webhook | `recordPayment` | — | does not touch stock |
| — | Admin product edits, product / variant soft delete | `deleteProductVariant` sets `deletedAt` only; admin edits are text and images | — | do not touch stock |

**Is sorting checkout and cancel sufficient for the deadlock claim?** For the stock rows, **yes, for the code as it exists**:
- A deadlock cycle needs at least two transactions that each hold one lock while waiting for another.
- The only transactions holding several stock-row locks are W1 and W2. With both in ascending variant id, they cannot form a cycle among stock rows.
- W3 and W4 lock a single row in a single statement and hold nothing else while waiting, so they cannot be part of a cycle.
- Other locks in W1 / W2 cannot close a cycle either. W1's other locks are its own new rows and the shopper's cart items; no other transaction locks cart items and then variants. W2 takes L1 → L2 before L6, and the webhook takes L1 → L2 and no stock rows.

**What remains:**
- **Serialization failures (40001), not deadlocks**, between W1 and W2 under Serializable. R0.3 retries them for W2; W1 returns today's error.
- **The claim covers today's paths only.** Every future stock writer (inventory module, intake, adjustments, returns) must follow `01` §4.2; this is not assumed.
- **W4 is an integrity risk of a different kind — a lost update, not a deadlock.** An absolute `stockQuantity` set can overwrite a concurrent checkout decrement or cancel increment. This is the existing reason for **TD-08** (vendor stock API becomes delta / compare-and-set, a pending Phase 0 start blocker). R0 does not touch W4 and does not fix this.

### 11.9 The manual command's ~25 s budget vs actual timeouts (re-verified 2026-10-28)

| Layer | Finding | Status |
|---|---|---|
| Node.js HTTP server (Dockerfile `node:22`) | per the Node 22 `http` documentation: `requestTimeout` (default 300,000 ms) limits **receiving the entire request from the client**; `headersTimeout` (default 60,000 ms) limits receiving the headers; `server.timeout` (socket inactivity) defaults to **0 = disabled**; `keepAliveTimeout` (5,000 ms) applies only **after** the last response is written. **None of them limits how long a handler may take to respond.** `main.ts` / `app.setup` change none of them | verified (documentation and local defaults). This shows that Node does not cut the request; it does **not** show the request is safe end to end |
| NestJS / Express | no request or response timeout configured in the app | verified |
| Render proxy / load balancer | no request, response or idle timeout found in Render's documentation; a 100-minute figure appears only in render.com articles | **unverified** |
| Any other intermediary (CDN, proxy) | none configured in the repository | not applicable today |
| Clients | the admin web app does not exist; Postman / curl / browser defaults vary | **unknown** |
| Client disconnect | Node does not abort a running handler when the client disconnects (the request's `close` event fires; the handler continues). Expected, not yet demonstrated in this app | **to verify** (test below) |

**Conclusion: the ~25 s budget is not guaranteed to fit every timeout on the path.** It is compatible with every limit that could be verified (Node imposes none), but the hosting proxy's limit is unverified and client timeouts are unknown. The design therefore does **not** depend on the HTTP response:
- **The work's outcome is recorded server-side.** The run row is written before processing and finalized at the end, whether or not the response reaches the client.
- **A dropped connection is not a failure.** An operator who sees a timeout must not assume the run failed. They re-run the command, which is safe because it is idempotent: already-released groups are not eligible, and concurrent runs skip each other. They can also check `maintenance_runs` through read-only database access, since R0 adds no read endpoint.
- **The budget is configurable.** It can be lowered once the hosting limit is known (R4, TQ-16 / TQ-28 evidence).
- **R0 test:** the client disconnects ~5 s into a manual run, and the run still completes and finalizes its `MaintenanceRun` row (status, counts). The audit write is attempted (C-d).

### 11.10 Manual retry while the previous run is still RUNNING (verified against the design; the code does not exist yet)

**Scenario:** admin request A starts a run, and its response is slow or times out. The admin sends request B while A's run is still RUNNING. Today there is no manual command, so this is verified against the R0 design and the existing primitives (the guarded order updates and the Serializable transaction of `cancelPendingGroup`).

| Aspect | Behaviour |
|---|---|
| Admission | B is not refused because A is running: concurrent runs are allowed, and "another run is RUNNING" is never treated as stale or as a lock. The only limit is the endpoint's throttle, which returns a coded 429 (CLAUDE.md: no silent 429s) |
| `MaintenanceRun` rows | A and B each insert **their own** row (RUNNING) before selecting candidates. Each run updates only its own row (`WHERE id = $own AND status = 'RUNNING'`). Neither closes the other: stale-closing is by age only (15 min), and B starts seconds after A |
| Candidate overlap | both select from the same eligible set, so their candidate lists overlap |
| Group A holds | B's `SELECT … FOR UPDATE SKIP LOCKED` returns no row → B skips the group (`skipped += 1`) and moves on; no waiting |
| Group A already committed | B's transaction starts after A's commit. Its first statement (the lock) takes the snapshot, so B sees the orders CANCELLED → re-validation fails → B skips it (`skipped += 1`), no restock |
| Group B reaches first | symmetric: A skips it |
| Group neither has reached | whichever locks first releases it; the other skips it |
| Snapshot subtlety (Serializable) | `SKIP LOCKED` never waits, so a run cannot carry an old snapshot past another run's commit on the same group. A **waiting** caller (shopper / admin cancel, `FOR UPDATE` without `SKIP LOCKED`) can: its snapshot predates the other side's commit, so its guarded order update raises **40001**. R0.3 retries it in a new transaction, which sees CANCELLED and moves 0 rows → today's 409. Never a second restock |
| Stock | each order changes from PENDING at most once (guarded update), and a restock happens only in the transaction that moved it, so every group is released **exactly once** across A and B |
| Final statuses | A: SUCCEEDED (or PARTIAL if groups failed), `released = n_A`. B: SUCCEEDED, `released = n_B`, `skipped` = the groups it found locked or already released. Since A and B release disjoint groups, `n_A + n_B` = groups released overall. B is **not** PARTIAL merely because it skipped |
| Audit | two audit writes attempted, one per invocation (C-c), each with its own run id and reason; persistence best-effort (C-d) |

**Status: verified by design, to be proven by AT-MNT-23** (new, `14`).

### 11.11 `skipped` and alert A5 (definitions)

**`skipped` is per run.** It is stored in that run's `MaintenanceRun` row and never accumulated across runs.
- **What it counts:** candidates the run attempted but did not release, for two reasons:
  - the group was locked (`SKIP LOCKED` returned no row);
  - the group was not eligible on re-validation (already released, paid, a payment recorded, or any order not PENDING).

  Failures are counted in `failed`, not `skipped`. So `processed = released + skipped + failed`.
- **The reason is not stored per group:** `MaintenanceRun` has no field for it, and R0 adds none. Each skip is logged with its group id and reason (`locked` / `not_eligible`).
- **Cumulative views are queries**, never stored counters. For example: Σ `skipped` over the last 24 h, or the same group id appearing in skip logs across runs.

**A5 "reservation overdue" — exact rule.**
- **Phase 0 (today's model, no reservation table):** a group is overdue when it matches the expiry eligibility rule (all orders PENDING, no Paymob transaction) **and** `createdAt < cutoffA5`, where `cutoffA5 = now_app − TTL − 30 min`.
  - The clock is the **application clock**, the same one the candidate cutoff uses (§11.7).
  - With the 60-min TTL, A5 fires for a still-eligible group more than **90 min** old.
  - Phase 1 (reservation table): an ACTIVE reservation with `expires_at < now − 30 min`, as in `21` §8.6.
- **Normal release time:** with the `*/5` interval and a 4-min budget, a group is normally released within about 9 min after its deadline — an estimate, not a guarantee (`21` §8.1). The 30-min margin therefore means repeated misses, repeated skips or a backlog.
- **Evaluation:** by the API health evaluator (`/health/maintenance`, proposed, `22` §4.3), polled by the external monitor (proposed every minute). It never runs inside the expiry run.
- **Signal:** the condition is true while **at least one** group matches. The output carries the count and the oldest overdue age, not one alert per group.

**A5 deduplication and throttling (proposal; configured in R4):**
1. **One open alert per condition**, key `mnt-a5` (`22` §4.4). New groups becoming overdue while it is open do not create new alerts; they only change the count.
2. **Re-notification** at most every **60 min** while open (`21` §8.6).
3. **Auto-clear** at the first evaluation that finds no overdue group. A new alert can open only after a clear.
4. **Flapping guard (proposed):** clear only after 2 consecutive clean evaluations, so a group released and another becoming overdue a minute later does not page twice.

Provider-side deduplication and recovery notices are **unverified** (`22` §4.2). The health endpoint returns one stable condition code, so the provider sees one failing check, not many. A5 is implemented with the health endpoint (R1 / R4), not in R0. R0 supplies the data: run rows, skip logs, and the eligibility predicate the evaluator reuses.

### 11.12 Where `createdAt` comes from (verified 2026-10-28)

| Point | Finding | Status |
|---|---|---|
| Production creation path | the only code that creates an `OrderGroup` is `CheckoutRepository.createOrderGroup`: `tx.orderGroup.create({ data: { userId } })` — **no `createdAt` passed** | verified (code) |
| Column | `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` (migration `20260823150614`) — no time zone | verified |
| Who writes the value | Prisma schema reference: `now()` on relational databases is "Implemented on the database-level, meaning that it manifests in the database schema" (`CURRENT_TIMESTAMP`); Prisma generates the value only on MongoDB | verified (official docs) |
| Whether Prisma 6.x omits the column from the `INSERT` | not observed: no query log was run, because no database operation is performed in this review | **unverified** — to be proven by an R0 test with query logging |
| Time-zone effect | `CURRENT_TIMESTAMP` is `timestamptz`. Stored into a `timestamp` column, it is converted with the **database session `TimeZone`**, and Prisma reads `timestamp` values as UTC. If the production session time zone is not UTC, every `createdAt` is shifted by the offset, and the TTL boundary moves by that offset. This is **existing behaviour**, unchanged by R0 | production `TimeZone` **unverified** (needs a read-only `SHOW TimeZone` on the production database) |
| Existing tests | e2e specs create groups with `prisma.orderGroup.create({ data: { userId } })` (`admin-management.e2e.spec.ts`), i.e. through the same database default; no test sets `createdAt`; expiry is covered only by a mocked unit test (`orders.service.spec.ts`) | verified |

**Change to the R0 test plan (requiring a change; no code or schema change):**
1. **Parity on identical rows.** Old and new selection run on the **same stored rows**, so parity does not depend on how `createdAt` was written.
2. **Boundary fixtures:** written with explicit `createdAt` values (1 ms either side of the cutoff, ties), because ages cannot be produced through the default.
3. **Production-path fixtures:** at least one group is created through `CheckoutRepository.createOrderGroup` (the database default), with Prisma query logging on. The test asserts the `INSERT` omits `createdAt` and that the stored value equals the database `now()` at insert within 1 s, read back by Prisma as UTC.
4. **The production-path test is repeated with a non-UTC session `TimeZone`.** It records the resulting offset, which documents the existing hazard; R0 does not fix it.

**New open item C-e:** confirm the production database session `TimeZone` (expected UTC; unverified). It does not block coding R0, but it must be recorded before deployment, alongside C-b.

**Correction (2026-10-29, measured during R0 implementation):** the Prisma query log shows `INSERT INTO "public"."order_groups" ("id","userId","createdAt") VALUES ($1,$2,$3)`, so Prisma 6 sends `createdAt` itself, from the application clock, in UTC. The database default is **not** used, despite the schema-reference wording. A non-UTC session `TimeZone` produced no shift. The "time-zone hazard" above therefore does not apply to Prisma-created rows, and C-e is no longer needed for them. The tests in `reservation-expiry.e2e.spec.ts` assert the observed behaviour.

Implementation does not start until Youssef approves G-R0 explicitly.

## 12. Implementation status (2026-10-29)

**Approval:** on 2026-10-29 Youssef answered the G-R0 question with "approve all and don't stop until you finish implementation for all plan with all phases" — approving G-R0 and DB-1 – DB-3 and instructing implementation of R0 – R4 and the barcode registry. Recorded in `08` (G-R0 note). Ibrahim's decisions were **not** made on his behalf; items that need them stay blocked (below).

| Phase | Status | What exists now (`apps/api`) | Evidence |
|---|---|---|---|
| **R0** | **implemented** | migration `20261028000000_maintenance_runs`; `orders.repository.ts` (group lock first, `SKIP LOCKED` for expiry, Serializable kept, `lock_timeout` / `statement_timeout`, sorted restock, keyset candidate query, backlog); `infra/prisma/retryable-tx.ts` (bounded retry, 5 attempts for cancels); `orders/expiry/reservation-expiry.service.ts` (run loop, budget, stop flag, per-group isolation, `MaintenanceRun`); `orders/maintenance-runs.repository.ts`; `POST /admin/maintenance/expire-overdue`; R0.10 sorted checkout decrement; smoke steps | unit: `reservation-expiry.service.spec.ts`; real PostgreSQL: `reservation-expiry.e2e.spec.ts` (13 tests incl. parity, C-MNT1, AT-MNT-14/15/22/23, webhook / cancel / checkout races, stale close, createdAt) passed at **RACE_ITERATIONS=200**; `admin-maintenance.e2e.spec.ts` |
| **R1** | **implemented** | `PROCESS_ROLE` (`all` / `api` / `worker`); `orders/jobs/orders-jobs.service.ts` (single schedule owner, `*/10`, non-blocking reconciler every 60 s, single-flight, timeout, recreation recorded as `SCHEDULE_RECONCILE`); processor started only by the owner (`autorun: false`), error listeners; graceful stop between groups; `src/worker.ts` + `worker.module.ts` + `start:worker` (TD-22); optional heartbeat `EXPIRY_HEARTBEAT_URL` | `orders-jobs.service.spec.ts` |
| **R2** | **implemented** | job template `attempts: 1`, `removeOnComplete {100, 24 h}`, `removeOnFail {1000, 7 d}`; reconciler detects a lost next job; queue counts; worker `maxRetriesPerRequest: null` — **verified to be forced by BullMQ 6.3.0 itself** for worker connections. Producer fail-fast connections were **not** changed (one shared connection config; low value) | unit tests above |
| **R3** | **infrastructure implemented** | migration `20261029000000_transactional_outbox` (append-only triggers, lease CHECK); `infra/outbox` writer + static registry (empty); `modules/outbox` (lease claim with `SKIP LOCKED`, `processed_events`, retry → DEAD, boot sweep, scheduled drain on its own `outbox` queue every 5 min, admin list / metrics / drain / requeue); shared worker process (TD-23) | `outbox.e2e.spec.ts` (15 tests: OBX-01, AT-OB-01/02/03/08/09/10, C-O1, C-O3/C-O4, DEAD after max, append-only, CHECK) |
| **R4 (code part)** | **implemented** | `/health/dependencies` and `/health/maintenance` (A1 – A6, A8 – A10, A14, A15 + outbox conditions; 503 coded body when P1 / P2 is open; `HEALTH_CHECK_TOKEN`, timing-safe) | `admin-maintenance.e2e.spec.ts` |
| **B1 barcode registry** | **implemented** | migration `20261029010000_barcode_registry` (partial uniques, namespace / conversion CHECKs, mapping-immutability and append-only triggers); `modules/barcodes` (normalizer, RVN generator with Luhn mod 32, proposals, admin create / register / approve / reject / activate / deactivate / conversion, resolver, lookup) | `barcode-normalizer.spec.ts`, `barcodes.e2e.spec.ts` (21 tests) |

**Not done, and why (no code can close these):**

| Item | Blocked by |
|---|---|
| R3 producers and consumers | no consumer exists: every documented consumer is the notifications module, which is not built. The registry is empty on purpose (01 §7.8) |
| R4 configuration | hosting purchase and setup (Option A, `render.yaml` worker service, `maxShutdownDelaySeconds`, `PROCESS_ROLE=api` on the web service), Redis Cloud plan and `noeviction` / persistence, Better Stack monitors and paging, load tests on the rehearsal snapshot, rehearsals on the chosen host — TQ-16, TQ-27, TQ-28, TQ-33, OD-08, Ibrahim's cost approval |
| B2 scan capture, B3 posting | the `19` intake / withdrawal models and the commerce Phase 1 inventory foundation do not exist; BD-01 / BD-08 (custody, Ibrahim) pending; ~~TD-08 pending~~ TD-08 approved and implemented 2026-10-31 (`25` §9 S3) |
| B4 clients | P-5 (which client) undecided; no admin or vendor client exists |
| A7 (release integrity alert) | ~~needs the inventory movement ledger (Phase 1)~~ **done 2026-10-31** as `LEDGER-DRIFT` on `/health/maintenance`, on the single-counter ledger of `25` §9 S3 (the multi-warehouse Phase 1 ledger is still future) |
| READ COMMITTED switch | separate reviewed change after R0 (§11.3) |

**Decisions implemented with a default, for confirmation:** P-1 internal format = `RVN` + 9 Crockford base-32 + Luhn mod 32 check; P-2 no GTIN equivalence (Youssef's items, covered by his instruction). **P-4** (reuse of a deactivated vendor value) is **Ibrahim's** — implemented with the strictest default (never reusable; an INACTIVE value still blocks the vendor's value), which can be relaxed later by changing one partial index.
