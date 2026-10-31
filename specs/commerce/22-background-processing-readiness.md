# 22 — Background Processing: Infrastructure and Implementation Readiness

> Status: **DRAFT for review** · 2026-10-27. Investigation and documentation only — nothing here is implemented, configured, purchased or approved. It complements the design in `21` §8 (reservation maintenance) with:
> - verified hosting facts (§1), compared deployment options and a recommendation (§2);
> - the worker lifecycle (§3);
> - the alerting design (§4);
> - the gaps between today's code and the design (§5);
> - Redis readiness (§6) and performance readiness (§7);
> - the decision package for TD-18, TD-22, TD-23 and TD-24 (§8);
> - the readiness assessment (§9).
>
> **TD-18, TD-22, TD-23 and TD-24 stay PENDING YOUSSEF. TQ-16, TQ-27, TQ-28 and TQ-33 stay OPEN.** Provider facts are quoted from official documentation fetched on **2026-10-27** (§10); anything that could not be confirmed there is marked **unverified**. Prices change — re-check them before any purchase.

## 1. Verified facts

### 1.1 Repository (read-only, HEAD `76921ed`)

| Item | Fact |
|---|---|
| `render.yaml` | one service: `type: web`, `runtime: docker`, `plan: free`, region `frankfurt`, `healthCheckPath: /health`, `branch: main`; no worker, no `maxShutdownDelaySeconds`. Whether it is deployed cannot be told from the repo (API hosting status: TQ-09) |
| `apps/api/Dockerfile` | one process: `CMD ["node", "dist/main.js"]`; no process manager; no worker entry point |
| `/health` | static `{ status: 'ok' }` (`app.module.ts`); checks neither PostgreSQL nor Redis |
| Shutdown | `main.ts` calls `app.enableShutdownHooks()`; `@nestjs/bullmq` 11.0.5 calls `worker.close()` on application shutdown; BullMQ 6.3.0 `close()` waits for active jobs unless forced |
| Expiry job | `OrdersJobsService.onModuleInit` **awaits** `upsertJobScheduler('expire-pending-checkouts-scheduler', { pattern: '*/5 * * * *' }, { name: 'expire-pending-checkouts', data: {} })` — no job options (no `attempts`, no retention); processor `OrdersExpiryProcessor` runs inside the API |
| Expiry logic | `OrdersService.expireStalePendingGroups(ttl, batchSize = 100)`: one candidate query (`findStalePendingGroupIds`: groups older than `CHECKOUT_PENDING_TTL_MINUTES`, no Paymob transaction, all orders PENDING, oldest first, `take` 100), then a loop calling `cancelPendingGroup(groupId)` **without** per-group error handling |
| Per-group transaction | `cancelPendingGroup`: one `$transaction` at **Serializable** isolation; guarded `updateMany` `PENDING → CANCELLED` per order; stock incremented only when exactly one row moved |
| Batch size origin | `batchSize = 100` arrived in commit `e8150f6` (2026-09-19, "checkout expiry job", fix `PAY-03` of `report/2026-09-19T11-31-46Z_fix-sweep.md`); no rationale recorded in code, commit or report |
| Redis connection | `redisConnectionFromUrl(REDIS_URL)` returns an options object (host, port, db, TLS for `rediss://`); no `maxRetriesPerRequest` / `enableOfflineQueue` set explicitly |
| Packages | `bullmq` 6.3.0, `@nestjs/bullmq` 11.0.5, `ioredis` 6.0.0 (resolved from `apps/api`) |

### 1.2 Render (official documentation, 2026-10-27)

| Question | Answer | Source |
|---|---|---|
| Can the current Free web service run the worker reliably? | **No.** "Render spins down a Free web service that goes 15 minutes without receiving any inbound traffic"; "Render might restart a Free web service at any time"; "Do not use them for production applications." 750 free instance hours per workspace per month | [Free](https://render.com/docs/free) |
| Free background workers? | **No.** Free instances exist for web services, Postgres and Key Value; "Other service types don't support Free instances." The Blueprint plan table for workers starts at `0.5c-512mb` (default when omitted) | [Free](https://render.com/docs/free), [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Is a Background Worker service available? | **Yes** — "services that run continuously", no incoming network traffic, typically polling a task queue | [Background workers](https://render.com/docs/background-workers), [Service types](https://render.com/docs/service-types) |
| Same repository, same image, different command? | **Yes (by the spec):** a Blueprint's `services` list takes several services; `type: worker` is supported; `startCommand` / `dockerCommand` are per service; omitting `repo` uses the Blueprint's repository | [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Shared environment configuration? | **Partly:** `envVarGroups` can be shared, but a group cannot use `sync: false`, so secrets kept out of git are set per service or in the dashboard | [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Automatic restart after a crash? | **Unverified for workers.** Docs: an unexpected exit is logged as an `Instance Failed` event and "Render automatically manages the instance lifecycle"; automatic restart is stated explicitly only after repeated **health-check** failures, and health checks apply to web and private services. A notification exists for "Service suspended after repeatedly failing to start and become healthy over 24 hours" | [Troubleshooting deploys](https://render.com/docs/troubleshooting-deploys), [Notifications](https://render.com/docs/notifications) |
| Deploy behaviour | zero-downtime deploys apply to web services, private services, background workers and cron jobs (disabled by a persistent disk); the new instance starts, then **after 60 seconds** the original instance receives `SIGTERM` → **old and new workers overlap** during every deploy | [Deploys](https://render.com/docs/deploys) |
| Shutdown grace period | `SIGTERM`, then `SIGKILL` after `maxShutdownDelaySeconds`: **default 30 s, maximum 300 s**, applicable to web, private and worker services (not with a persistent disk) | [Deploys](https://render.com/docs/deploys), [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Maintenance restarts | stateless services can be replaced by spinning up a new instance before the old one is removed; `SIGTERM` is sent; long-running services must handle graceful shutdown | [Platform maintenance](https://render.com/docs/platform-maintenance) |
| Logs, events, notifications | per-service Events timeline (deploy failures, instance restarts); notifications by **email and Slack** for build / deploy failures, "running service becomes unhealthy", suspension after repeated start failures; the page does not state worker coverage explicitly | [Troubleshooting deploys](https://render.com/docs/troubleshooting-deploys), [Notifications](https://render.com/docs/notifications) |
| Monthly cost | **unverified from an official page** (render.com/pricing did not render for the fetch tool). Third-party guides consistently quote **≈ $7 / month per 0.5 CPU / 512 MB "Starter" instance**, web or worker, prorated per second, plus the workspace plan (Hobby quoted at $0) | third-party only — confirm on render.com/pricing |

**Consequence:** the current configuration cannot host production at all. Render says free web services are not for production, and a free service that sleeps also stops the API and today's in-process expiry job. Any production option needs a **paid, always-on** API instance. A dedicated worker needs a paid worker instance.

## 2. Deployment options

| Criterion | **A — Render web service + Render background worker** (same repo and image) | **B — In-process worker in a paid Render web service** | **C — API on Render, worker on another host** |
|---|---|---|---|
| Continuous availability | worker runs continuously (worker service type); API independent | as long as the web instance runs; paid instances do not spin down (the 15-min spin-down is stated for Free) | depends on the other host (unverified) |
| Automatic restart | platform-managed; crash restart for workers **unverified** → must be shown (AT-MNT-18) | web health checks restart a hung API, which takes the in-process worker with it; a crash restarts both | depends on the other host |
| Resource isolation | separate instance: CPU, memory, event loop, connection pool | none: maintenance shares CPU, memory, event loop and Prisma pool with HTTP traffic | separate |
| Failure isolation | an API crash does not stop maintenance, and the reverse | an API crash or out-of-memory event stops maintenance | separate, but across two providers |
| Scheduling | the worker owns the schedule (§5.4) | the API owns it; every API replica runs a processor (safe with `SKIP LOCKED`, §5.3) | the worker owns it |
| Deployment complexity | one Blueprint, two services, one image, two start commands; both deploy from `main` together | lowest: one service | highest: two pipelines, two secret stores, two log systems |
| Redis / PostgreSQL connectivity | same as today (public TLS endpoints: Supabase, Redis Cloud); Redis connections grow by the worker's (§6) | same as today | same endpoints from another network; allow-lists / egress to configure |
| Monitoring | worker liveness by external heartbeat (§4); Render events / notifications | one heartbeat covers both; API health check | the other host's tooling plus Render's |
| Cost (unverified, §1.2) | ≈ 2 × $7 / month compute | ≈ 1 × $7 / month compute | ≈ $7 (Render) + the other host |
| Operational maintenance | low; one platform | lowest | highest |
| Decisions needed | TD-18 + TD-22 (dedicated worker = amendment to TD-13) + TQ-16 / TQ-28 | TD-18 only (no TD-22); but MNT-17's independent-health and isolation goals are only partly met | TD-18 + TD-22 + a second platform decision |

**Recommendation for the MVP: Option A** (proposal; TQ-16 / TQ-28 stay open until approved and verified):
- **Cost:** it is only one more small instance than Option B. Both need a paid API instance anyway, because Render's free tier is not for production.
- **Isolation:** it gives maintenance its own restart, deploy and resource lifecycle, so an API overload or crash cannot hold stock indefinitely. That isolation is the reason TD-18 / TD-22 were proposed.
- **Simplicity:** it stays on one platform, one image and one Blueprint. Option C adds a second provider with no benefit at this scale.
- **Fallback:** if TD-22 is rejected, Option B on a paid always-on web instance is the acceptable alternative, with the limitations in the table. Free hosting is acceptable for neither.

**Evidence needed to close TQ-16 and TQ-28** (recorded in `11` with date and who checked):
1. The approved option and the plan and instance type, with the official price on the purchase date (Ibrahim approves cost).
2. Proof the API instance does not spin down: no gap in `MaintenanceRun` over 7 days, including a quiet period.
3. A killed worker restarted automatically by the platform, with the restart time recorded, and a crash-on-start loop surfacing as a Render event / notification and as A10 (AT-MNT-18).
4. The configured `maxShutdownDelaySeconds` and a measured graceful stop within it (AT-MNT-19).
5. A deploy observed with old and new workers overlapping, with no double release and one schedule afterwards (AT-MNT-19).
6. Logs and events visible for the worker service.

## 3. Worker lifecycle (Option A; applies to Option B where marked)

| # | Stage | Behaviour | Ref |
|---|---|---|---|
| 1 | Startup | the platform starts the worker command from the same image as the API; it opens PostgreSQL (Prisma) and Redis (BullMQ) connections; it never waits indefinitely for either before starting its loops | `21` §8.5, §8.8 |
| 2 | Connections | worker connections use `maxRetriesPerRequest: null` (BullMQ requirement for workers) and keep the offline queue; queue (producer) connections fail fast; every BullMQ object has an `error` listener; unhandled rejections are logged, never fatal (BullMQ [going to production](https://docs.bullmq.io/guide/going-to-production)) | §6 |
| 3 | Schedule ownership and reconciliation | the worker is the only owner of `expire-pending-checkouts-scheduler` (Option B: the API); boot check + every 60 s; fixed id; `*/10 * * * *` | §5.4, `21` §8.2 |
| 4 | Health monitoring | external heartbeat after every successful run (A1 / A9 independent of the worker and of PostgreSQL); A9 / A10 from PostgreSQL via the API health endpoint; Render events | §4 |
| 5 | Graceful shutdown | `SIGTERM` → stop starting groups; finish the current group transaction; close the run as PARTIAL `shutdown`; `worker.close()` returns; exit before `maxShutdownDelaySeconds` (default 30 s — the 4-min budget can never fit, so the stop is between groups, never "finish the run") | `21` §8.8 |
| 6 | Unexpected termination | the open transaction is rolled back by PostgreSQL; the job's lock expires → re-delivered once (`maxStalledCount` 1) or the next tick runs; the stale RUNNING row is closed as FAILED by the next run | `21` §8.10 |
| 7 | Automatic restart | platform-managed — **unverified for workers**; must be demonstrated (TQ-16 evidence 3) | §1.2 |
| 8 | Redis reconnection | ioredis retries forever with exponential backoff (BullMQ docs: 1 s minimum, 20 s maximum by default); the worker resumes; no restart needed | AT-MNT-11 |
| 9 | PostgreSQL reconnection | Prisma reconnects on the next query; runs during the outage fail and cannot write `MaintenanceRun` (A13 and the missing heartbeat report it) | AT-MNT-20 |
| 10 | Deploy and rolling restart | Render starts the new worker, then sends `SIGTERM` to the old one after 60 s → both run for at least 60 s; safe because of per-group `SKIP LOCKED` and guarded updates (§5.3); both reconcile the same id and pattern | AT-MNT-19 |
| 11 | Recovery of overdue reservations | downtime never loses work: overdue rows stay ACTIVE in PostgreSQL and the next run (or the manual command) releases them, oldest first | `21` §8.2.1 |

## 4. Alerting and paging

### 4.1 What each layer is for

| Layer | Purpose | Pages a person? | MVP tool (proposal) |
|---|---|---|---|
| Application logs | every run, per-group failure (with group id), reconnects, shutdowns | no | Render logs |
| Error tracking | exceptions with stack traces, grouped | no (email digest only) | optional: Sentry Developer (free) |
| Metrics and dashboards | trends: run duration, backlog, queue counts | no | deferred (PostgreSQL queries on demand) |
| Operational alerts | A1 – A15 conditions turned into incidents | yes, by severity | Better Stack (proposal) |
| Paging and escalation | reaching a person out of hours, escalation if not acknowledged | yes | **not available on free tiers compared** — needs a paid responder licence or an accepted "email + Slack only" MVP (OD-08) |

### 4.2 Providers compared (official pages, 2026-10-27)

| | Better Stack (Uptime) | Sentry | Grafana Cloud | Healthchecks.io |
|---|---|---|---|---|
| Free tier relevant here | 10 monitors **and** heartbeats combined; Slack and e-mail alerts; 1 status page | Developer: 5k errors / month, 1 user, **1 cron monitor, 1 uptime monitor**, alerts by e-mail only (no integrations) | 10k metric series, 50 GB logs, 14-day retention, 3 IRM users, 100k synthetic API tests / month | Hobbyist: 20 checks, 100 log entries per check |
| Dead-man / heartbeat (fires when a run does **not** happen) | yes: expected period + grace period; `/fail` endpoint for explicit failure | yes (Crons: missed and failed check-ins) | via synthetic / alert rules (more setup) | yes (its core purpose) |
| HTTP checks of a health endpoint | yes (status, keyword, API monitors) | 1 uptime monitor free | yes (synthetic) | no |
| Exception tracking | no (separate product) | yes (core) | via logs / traces | no |
| Phone / SMS / on-call escalation | on-call scheduling for paid responders: **$29 / month billed yearly, $34 monthly** | Team plan $29 / month (integrations); paging via integrations | IRM (3 users free) | SMS / phone credits on paid Business plans ($20 / month) |
| Recovery notification, deduplication | **unverified** on the pages read (incident model implies one open incident per monitor) — verify in a trial | issues per monitor (unverified detail) | alert rule states (firing / resolved) | unverified |
| Integration effort | an HTTP GET per successful run + monitors on health URLs | SDK + `withMonitor` / check-ins (SDK detail unverified) | highest | an HTTP GET per run |

**Recommendation (proposal, TQ-33 stays open):**
- **Better Stack Uptime for operational alerts.** Heartbeats and health-endpoint monitors run **outside Riven's infrastructure**, so they still alert when PostgreSQL, Redis, the worker or the API is down. The 10-monitor free tier is enough for the MVP set below, and it delivers to e-mail and Slack.
- **Optionally, Sentry Developer (free) for exception tracking.** It complements the alerts and does not replace them: its free alerts are e-mail only and it has one cron monitor.
- **Paging:** out-of-hours P1 paging needs either a paid Better Stack responder licence (≈ $29–34 / month per responder) or Ibrahim and Youssef accepting e-mail + Slack only for the MVP (OD-08).
- Grafana Cloud is more capable but needs more setup than a two-person team should own now. Healthchecks.io covers heartbeats only.

### 4.3 MVP monitor set (≤ 10 Better Stack monitors)

| Monitor | Type | What it covers | Independent of |
|---|---|---|---|
| M1 Expiry heartbeat | heartbeat, period 10 min, grace 15 min → incident after 25 min without a ping | the worker pings after every successful `EXPIRE_OVERDUE` run, and pings `/fail` on a FAILED run → **A1**, **A2**, and A9 / A13 as causes | PostgreSQL, Redis, worker, API |
| M2 Outbox heartbeat | heartbeat, period 5 min, grace 10 min | outbox drain runs (TD-23) | same |
| M3 API liveness | HTTP status on `/health` | API down | the API's own process |
| M4 Dependencies | API monitor on a proposed `/health/dependencies` (PostgreSQL ping, Redis ping) — non-2xx when either fails | **A11**, **A13** | — (HTTP checked from outside) |
| M5 Maintenance conditions | API / keyword monitor on a proposed `/health/maintenance` that evaluates A3 – A7, A9, A10, A15 from PostgreSQL and returns non-2xx with the open condition codes | P1 / P2 conditions | the worker and Redis; if PostgreSQL is down it fails → still an incident (A13) |
| M6 Redis capacity | Redis Cloud's own alerts (memory, connections — **unverified** feature) or M5 extended with `INFO` | **A12** | — |

The two health endpoints (`/health/dependencies`, `/health/maintenance`) are **proposals**; today only the static `/health` exists. A8 and A14 (schedule recreated, reconciler failing) are P3 / P2 and reported through M5 and logs.

### 4.4 Delivery per alert (proposal)

| Alert | Trigger (`21` §8.6) | Sev. | Detection source | Destination | Dedup key | Recovery notification | Escalation | Operator action |
|---|---|---|---|---|---|---|---|---|
| A1 No successful run | > 25 min | P1 | M1 heartbeat (external) | incident → e-mail + Slack (+ phone if licensed) | `mnt-a1` | on the next ping (verify) | OD-01 → OD-08 after 30 min unacknowledged | `13` §1.11 "worker unavailable" |
| A2 Run failed | FAILED run | P2 | M1 `/fail` ping; M5 | Slack + e-mail | `mnt-a2` (one open) | next successful ping | none | read `MaintenanceRun.error` |
| A3 Repeated failures | 3 consecutive | P1 | M5 | as A1 | `mnt-a3` | condition clears | as A1 | `13` §1.11 |
| A4 Run over budget | RUNNING > 5 min | P2 | M5 | Slack + e-mail | `mnt-a4` | clears | none | `13` §1.11 "excessive processing time" |
| A5 Reservation overdue | > 30 min | P1 | M5 | as A1 | `mnt-a5` | clears | as A1 | manual command; find the cause |
| A6 Backlog | > 500, not shrinking | P3 / P2 | M5 | P2: Slack | `mnt-a6` | clears | none | compare with throughput |
| A7 Release integrity | invariant violation | P1 | M5 (after-run and daily invariant query) | as A1 | `mnt-a7` | operator closes | as A1 | `13` §1.10 incident |
| A8 Schedule recreated | > 3 / 24 h | P3 / P2 | logs; M5 | P2: Slack | `mnt-a8` | after 24 h quiet | none | check TQ-27 settings |
| A9 Worker unavailable | no run started 25 min | P1 | M1 (no ping) + M4 green + Render events | as A1 | shares `mnt-a1` (same incident) | next ping | as A1 | restart the worker in Render |
| A10 Crash loop | ≥ 2 stale runs / 60 min | P1 | M5; Render notifications | as A1 | `mnt-a10` | clears after 60 min | as A1 | roll back the release |
| A11 Redis unavailable | ping fails > 2 / 10 min | P2 / P1 | M4 | Slack / as A1 | `dep-redis` | M4 green | P1 as A1 | provider status; manual command |
| A12 Redis memory / eviction | > 80 % / evictions | P2 / P1 | M6 | Slack / as A1 | `dep-redis-mem` | clears | P1 as A1 | retention, eviction policy |
| A13 PostgreSQL unavailable | ping fails, or M5 cannot evaluate | P1 | M4, M5 (external) and M1 silence | as A1 | `dep-postgres` | M4 green | as A1 | `13` §1.1 |
| A14 Reconciler failing | 5 consecutive | P2 | logs; M5 | Slack | `mnt-a14` | clears | none | Redis and scheduler checks |
| A15 Processing failures | PARTIAL; same group 3 runs | P2 / P1 | M5 | Slack / as A1 | `mnt-a15-<groupId>` | clears | P1 as A1 | `13` §1.11 "repeated order failures" |

**Independence:** when PostgreSQL is down, M1 stops receiving pings (no successful run is possible) and M4 / M5 fail. The incident therefore comes from Better Stack, never from a database row.

### 4.5 A4 threshold review (> 5 min — kept as proposed, not approved)

- **Avoids expected false positives:** the budget check runs **between groups**. A run that hits 4 min finishes only the group in progress, so its overrun is at most one group transaction. This holds only if every maintenance transaction is bounded by `lock_timeout` / `statement_timeout`, a few seconds each (*implementation acceptance criterion*; values set at implementation). With that bound, a 1-minute margin cannot be crossed by a healthy run.
- **Detects stuck runs:** a RUNNING row older than 5 min means the budget check or a transaction is broken, and it is reported while the run is still stuck, not after it ends.
- **Does not hide long failures:** A4 fires at 5 min, A1 at 25 min and A9 / A10 when the worker dies, so a run stuck for longer stays visible through three alerts.
- **Fits shutdown behaviour:** on `SIGTERM` the run stops within seconds and ends PARTIAL, well inside Render's default 30-s grace period, so shutdown never triggers A4.
- **Conclusion:** the threshold is justified **only together with** the per-transaction timeout. Without that, one blocked transaction could hold a run past 5 min, and A4 would correctly fire. It stays a proposal (OD-01).

## 5. Current code vs proposed design

| Area | Today's code (verified) | Proposed design (`21` §8) | Gap / required change (implementation, after TD-18) |
|---|---|---|---|
| Interval | `*/5 * * * *` | `*/10 * * * *` | change with ownership transfer (§5.4) |
| Deadline | `createdAt + CHECKOUT_PENDING_TTL_MINUTES` (default 60) per group | stored per-reservation `expires_at` (Phase 1); Phase 0 group deadline | Phase 0 / 1 work per `21` §3 |
| Batch | one query, `take` 100, once per run | ≤ 500 per batch, loop until none or 4-min budget | loop + budget + keyset (§5.1) |
| Error handling | first throwing group aborts the run | per-group isolation, counted, retried next run | §5.2 |
| Locking | Serializable `$transaction`, no `SKIP LOCKED`, no retry | READ COMMITTED + `FOR UPDATE SKIP LOCKED` on the group + guarded updates + bounded retry of transient errors | §5.3 |
| Retries | none (job default 1 attempt; failure only logged and rethrown) | job `attempts: 1`; next tick is the retry; transient DB errors retried inside the group transaction | §5.3 |
| Retention | none on `orders` queue | `removeOnComplete` / `removeOnFail` (`21` §8.3.1) | template `opts` |
| Run record | none | `MaintenanceRun` per run | new model (`02`), Phase 0 |
| Schedule ownership | API `onModuleInit`, awaited, boot only | single owner + reconciler every 60 s, non-blocking | §5.4 |
| Worker lifecycle | in-process in the API; shutdown hooks wired | dedicated worker (TD-22) with graceful stop between groups | §3 |
| Health / alerts | static `/health` | M1 – M6 (§4) | endpoints + heartbeats |

### 5.1 Batch size and transaction duration

- **Why 100:** not documented (§1.1). It caps how many groups one run handles.
- **Transaction duration does not depend on batch size.** Each group already has its own transaction, so the batch size only sets the candidate query's `LIMIT` and how long a run lasts.
- **Why 500 per batch:** it amortises the candidate query; within a run, the loop over batches matters more than the batch size.
- **500 is not assumed correct.** It is validated by L1 – L3 (§7): candidate-query p95 and memory per batch.
- **Required for multiple batches in one run:**
  - **keyset continuation:** each batch selects groups after the last one attempted (`(deadline, id) > (last)`), so a run never re-selects a group it already tried, including failed ones;
  - the budget check between groups.

### 5.2 Per-group failure isolation

- **Head-of-line blocking (a real defect today):** candidates are selected oldest first, and the first failure aborts the run. A group that fails every time — malformed data, a constraint error — is therefore selected first and aborts **every** run, so newer expirations are never processed.
- **Transaction boundary:** one group = one transaction containing:
  - the lock;
  - re-validation;
  - every order's guarded `PENDING → CANCELLED` (Phase 1: reservation `ACTIVE → RELEASED`);
  - the stock movements;
  - audit and outbox rows.

  Either everything commits or nothing does, so there is never a partial release.
- **On error:** the group's transaction rolls back. The run catches the error, writes a structured log line (group id, error class, message), adds 1 to `failed`, keeps the last error in `MaintenanceRun.error`, and continues with the next group.
- **Deterministic retry:** the failed group stays PENDING / ACTIVE and is a candidate again in the next run, in the same oldest-first order. Keyset continuation prevents a retry inside the same run.
- **Recoverable:** nothing about the group changed. After the cause is fixed, the next run or the manual command releases it.
- **Alerting:** A15 — P2 on a PARTIAL run, P1 when the same group fails in 3 runs. Per-group identity comes from logs and error tracking. **No new table is proposed.** If per-group failure history in PostgreSQL is wanted, that is a schema change for a later decision.
- **Never twice:** guarded updates and (Phase 1) the unique movement key (`21` §8.10).

### 5.3 Serializable vs `SKIP LOCKED`

| | Today: Serializable | Proposed: READ COMMITTED + `SELECT … FOR UPDATE SKIP LOCKED` on the group row |
|---|---|---|
| Duplicate release | prevented by the guarded `updateMany` (and serializability) | prevented by the row lock + guarded update (a concurrent writer's update makes the guard match 0 rows) |
| Concurrent worker or request on the same group | one of the transactions fails with a serialization error (40001) | the second worker **skips** the locked group; a request waits briefly for the lock or uses its own guard |
| Serialization failures | expected under contention; today **not retried** and they abort the run | not produced by this pattern; deadlocks (40P01) remain possible if locks are taken out of order → consistent lock order (`01` §4) + bounded retry |
| Lock contention | predicate / SIRead locks; aborts grow with concurrency | row locks only on the group being processed; no waiting between workers |
| Throughput | aborted work is thrown away | no wasted work; workers spread over different groups |
| Several worker instances | correct but abort-prone | the intended mode (`21` §8.1, C-MNT1, C-MNT2) |

**Recommendation:** use READ COMMITTED with a raw `SELECT … FOR UPDATE SKIP LOCKED` on the group row, in the orders repository. The `order_groups` table exists, so no schema change is needed.
- **Verified (2026-10-27, roadmap review):** the payment webhook (`CheckoutRepository.recordPayment`) runs at the default READ COMMITTED level and already locks the group row first, through its guarded `order_groups` update. `cancelPendingGroup` takes no group lock today. Taking the group lock first in `cancelPendingGroup` makes payment and cancel serialize on that row, in the L1 → L2 → L6 order of `01` §4.
- **Lock mode:** expiry uses `SKIP LOCKED`; shopper and admin cancels **wait** for the lock (bounded by `lock_timeout`).
- **Isolation change:** **R0 keeps Serializable** (Youssef, 2026-10-28). READ COMMITTED is a later, separate reviewed change, made only if the `23` §11.3 suite passes at both isolation levels with identical safety results (TD-01's condition). The recommendation above describes that target, not R0.
- Keep the guarded updates.
- Retry 40001 / 40P01 a bounded number of times inside the group (the Phase 0 `withRetryableTx` item).
- Set `lock_timeout` / `statement_timeout` per transaction.

`SKIP LOCKED` is **not implemented today**.

### 5.4 Schedule ownership and the transition

**Rule:** exactly one component type owns `expire-pending-checkouts-scheduler` at any time, and the pattern is defined in one place in the owner's code. PostgreSQL stays the only authority for deadlines.

| Stage | Owner | What changes in that release | Deploy overlap |
|---|---|---|---|
| 0 — today | API (`onModuleInit`, `*/5`) | — | — |
| 1 — TD-18 approved, in-process (Option B, or before TD-22) | API | pattern `*/10`; non-blocking reconciler every 60 s; per-group isolation; `SKIP LOCKED`; `MaintenanceRun` | old API instances keep `*/5` only until they stop. Their upsert runs at boot only, so a restart of an old instance during the overlap writes `*/5` once, and the new reconciler restores `*/10` within 60 s (one A8 event) |
| 2 — TD-22 approved (Option A) | worker | the worker gets the upsert and reconciler; the **same release removes** the API's upsert and the API's processor registration | for ≥ 60 s old API processors and the new worker both process → safe (`SKIP LOCKED`, guards); both use `*/10` |
| Rollback from 2 to 1 | API | stop / suspend the worker service in the same rollback; the API's boot upsert restores ownership | — |

Missing schedules are restored by the owner's reconciler (fixed id → never duplicates).

## 6. Redis readiness (TQ-27 open)

| Setting | Required (source) | Redis Cloud fact (official) | Riven's production value |
|---|---|---|---|
| `maxmemory-policy` | `noeviction` (BullMQ: "very important") | selectable per database; **default is `volatile-lru`**, not `noeviction` | **unverified** — if left at the default, keys with an expiry (which include BullMQ's lock keys) can be evicted under memory pressure |
| Persistence | AOF, every second is usually enough (BullMQ) | **free Essentials: no persistence at all**; paid Essentials: AOF every second and snapshots | **unverified** (plan unknown) |
| Memory | bounded by `21` §8.3.1 | free plan 30 MB; paid from 250 MB | unverified |
| Connections | API + worker connections measured | **30** concurrent connections on the free plan; 256 on 250 MB | unverified; each BullMQ worker adds blocking connections |
| Throughput / bandwidth | low for maintenance | free: 100 ops/sec, 5 GB / month | unverified |
| Restart / data loss | design tolerates loss (`21` §8.2.1) | without persistence, "data is lost when the database goes down" | unverified |
| Retry / retention | `21` §8.3.1 (verified against BullMQ 6.3.0) | — | not configured today |
| Monitoring | A11, A12 | dashboard metrics; built-in alerts **unverified** | none |

**Recovery is three different things** (`21` §8.2.1):
1. **The recurring schedule.** The reconciler recreates it.
2. **A BullMQ job.** BullMQ recovers stalled jobs only if Redis kept them.
3. **The business operation.** The next run reads overdue rows from PostgreSQL.

Losing Redis data can therefore delay expiry (A1 / A9 fire) but never prevents it.

**Evidence to close TQ-27:** the six items of `21` §8.3, plus the plan name (free vs paid). **On the free plan TQ-27 cannot be closed for production**, because persistence is unavailable. The design survives that, but every Redis restart loses the schedule and all job history, and the 30-connection limit must hold the API plus the worker.

## 7. Performance readiness (MNT-18; nothing measured)

The 20–50 ms per group estimate is **unverified**. AT-MNT-21 covers these runs:

| Run | Scenario |
|---|---|
| L1 | 500 overdue groups |
| L2 | 1,000 overdue groups + API traffic at the expected peak |
| L3 | 5,000 overdue groups + API traffic at 2× peak + lock contention (requests on the same groups) |
| L4 | 10,000 overdue groups + 2× peak |
| L5 | 5,000 overdue groups + shared-process load (outbox drain, later reconciliation) |
| L6 | worker killed mid-run during L3, then restarted |
| L7 | prolonged outage: the schedule stopped for 6 h at L2 traffic, then restored (catch-up) |

Measurements are those of `21` §8.9.

**Acceptance criteria (proposed — to confirm with Youssef):**

| # | Criterion |
|---|---|
| P1 | every run ends ≤ 4 min + one group transaction (A4 never fires) |
| P2 | L1 completes in one run |
| P3 | L4 (10,000) is cleared within 6 runs (≈ 1 h), i.e. ≥ ~1,700 groups per run. This is a target, not a fact |
| P4 | zero double releases, zero deadlocks; invariants 1, 2 and 16 hold |
| P5 | skipped / failed counts equal the fixtures exactly |
| P6 | API p95 during runs ≤ 120 % of the same traffic without runs |
| P7 | L6 and L7 recover with no manual step, and the backlog shrinks on every run |
| P8 | worker memory stays below 70 % of the instance (512 MB if Option A at the smallest size) |

**If the criteria are not met:** the candidate design changes are:
- per-group cost (indexes, fewer statements);
- worker concurrency above 1 (safe with `SKIP LOCKED`);
- an immediate follow-up run when the budget is exhausted;
- a larger instance.

Each change is a revision of TD-18, which stays pending. The 10-minute interval and the proposed 30-minute TRANSFER proof window (BD-07 pending; today's TTL is 60 minutes for all unpaid groups, `23` §11.1) change only with evidence. The expected number of abandoned checkouts per 10 minutes is **unknown** and needs a volume estimate (Ibrahim).

## 8. Decision package (all pending — nothing approved here)

| Decision | Exact question | Options | Advantages / disadvantages | Operational consequence | Recommendation | Depends on | Evidence before approval |
|---|---|---|---|---|---|---|---|
| **TD-18** | Which mechanism runs reservation expiry in production? | (1) BullMQ scheduler + worker (proposed); (2) host cron calling the manual command; (3) in-process only, no reconciler | (1) reuses existing code, retries, observability; needs Redis (2) simple, but Render cron jobs are a separate paid service and this is unverified (3) today's code: no recovery of a lost schedule | (1) needs §3 lifecycle, §4 alerts, §6 Redis | (1), with the §5 code changes | TQ-16, TQ-27, TQ-28, TQ-33; MNT-18 | AT-MNT-18 – AT-MNT-21 on the chosen host; §6 evidence |
| **TD-22** | May one dedicated worker process type run despite TD-13? | (1) yes, the expiry worker only; (2) no — stay in-process (Option B) | (1) isolation, independent restart; one more service (≈ $7 / month, unverified) (2) cheaper; maintenance shares the API's fate | (1) Option A; schedule owner = worker (§5.4) | (1) | TD-18; hosting (TQ-16 / TQ-28); cost approval (Ibrahim) | §2 evidence 1–6 |
| **TD-23** | Where do the outbox drain and reconciliation runs execute? | (1) separate queues in one shared worker process; (2) separate processes; (3) in the API | (1) cheap, simple; process-level failures shared (2) full isolation; more services (3) couples to API load | (1) needs the `21` §8.5 conditions | (1) for the MVP; split when L5 or monitoring shows contention | TD-22 (the process exists), TD-06 (outbox) | L5 results; AT-MNT-16 |
| **TD-24** | How long are `MaintenanceRun` rows kept? | (1) ≥ 12 months then an audited age-based purge; (2) indefinitely; (3) align with the financial-records period (SD-05) | (1) bounded table; needs a purge job later (2) simplest; slow growth (~4,400 expiry rows a month at 10-min intervals, plus other commands) (3) consistent policy, but SD-05 is pending | none until a purge exists | (2) until volumes justify (1); not urgent | — | table growth measured after 3 months |

TD-13 (approved 2026-10-24) and every approved decision are unchanged.

## 9. Readiness assessment

| Class | Item |
|---|---|
| **Critical deployment blocker** | no always-on host: `render.yaml` is a Free web service, which Render itself says is not for production and which spins down after 15 min (TQ-16, TQ-28); worker crash-restart on Render unverified |
| **Critical operational blocker** | no alert delivery (TQ-33): no external heartbeat, no health endpoints with dependency checks, no paging decision (OD-08) |
| **High-priority technical gap** | head-of-line blocking (§5.2); no `SKIP LOCKED` and unretried serialization failures (§5.3); schedule ownership / `*/5` transition (§5.4); startup awaits Redis; no `MaintenanceRun`; no queue retention |
| **Verification required** | Redis Cloud plan, eviction policy (default `volatile-lru`), persistence (none on free), connection limit (TQ-27); Render pricing on the official page; Render worker restart behaviour; Better Stack recovery notifications and deduplication; BullMQ next-job behaviour of schedulers; throughput (MNT-18) |
| **Non-blocking improvement** | TD-24 period; Sentry error tracking; metrics dashboards; Grafana later |

**Before implementation can begin** (per phase gates in `23` §5: the expiry-engine slice R0 needs only authorization G-R0; the items below gate R1 – R4):
1. TD-18 approved; TD-22 approved or rejected (this decides Option A or B and the schedule owner).
2. Hosting option chosen and its cost approved (Ibrahim); paid plan identified (TQ-28 evidence 1).
3. Alerting provider and destinations chosen (TQ-33), and the paging question answered (OD-08).
4. The code changes of §5 accepted as the Phase 0 implementation scope (they are design-consistent, `21` §8.10).

**Before production go-live:**
1. TQ-16 / TQ-28 evidence 2–6 recorded (always-on, restart, grace period, deploy overlap, logs).
2. TQ-27 evidence recorded on a plan with persistence and `noeviction` — or an explicit, recorded acceptance of the free-plan limitations.
3. M1 – M5 delivering, with one test incident per severity received by the named owner (AT-MNT-04).
4. AT-MNT-21 L1 – L7 passed against P1 – P8, or TD-18 revised.
5. AT-MNT-11, AT-MNT-12, AT-MNT-16 – AT-MNT-20 passed on the chosen host; PRG-03 met.

## 10. Sources (fetched 2026-10-27)

- Render: [Free instances](https://render.com/docs/free) · [Background workers](https://render.com/docs/background-workers) · [Service types](https://render.com/docs/service-types) · [Blueprint spec](https://render.com/docs/blueprint-spec) · [Deploys](https://render.com/docs/deploys) · [Troubleshooting deploys](https://render.com/docs/troubleshooting-deploys) · [Platform maintenance](https://render.com/docs/platform-maintenance) · [Notifications](https://render.com/docs/notifications) · [Pricing](https://render.com/pricing) (did not render for the fetch tool; prices above are third-party, unverified)
- BullMQ: [Going to production](https://docs.bullmq.io/guide/going-to-production); installed type definitions of `bullmq@6.3.0`
- Redis Cloud: [Data eviction](https://redis.io/docs/latest/operate/rc/databases/configuration/data-eviction-policies/) · [Data persistence](https://redis.io/docs/latest/operate/rc/databases/configuration/data-persistence/) · [Essentials plans](https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/)
- Monitoring: [Better Stack pricing](https://betterstack.com/pricing) · [Better Stack heartbeats](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/) · [Better Stack monitor types](https://betterstack.com/docs/uptime/monitor-types/) · [Sentry pricing](https://sentry.io/pricing/) · [Sentry Crons](https://docs.sentry.io/product/crons/) · [Grafana Cloud pricing](https://grafana.com/pricing/) · [Healthchecks.io pricing](https://healthchecks.io/pricing/)
