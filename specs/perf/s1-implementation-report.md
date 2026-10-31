# S1 implementation report — count + page without interactive transactions

> Plan: `specs/architecture-and-query-performance-plan.md` §2.2 (A1), stage S1 · Date: 2026-10-31 · Revision 2 (after Youssef's corrections) · Status: **implemented and verified; acceptance NEEDS REVIEW — P2024 remains open (§6)** · Nothing committed.

## 1. Executive summary

- **In scope now:** the 10 interactive count-plus-page transactions are converted to batch transactions through one helper, `infra/prisma/paginate.ts`. The 2 raw bazaar reads that revision 1 had merged are **reverted to their exact S0 code** (they regressed and never had the P2028 problem). The helper's raw variant was removed with them (no caller left). Line endings of the 3 CRLF files are restored; the diff against S0 now contains only the approved changes (§3).
- **Behaviour unchanged:** 1,399 / 1,399 tests, smoke snapshot **0 differences**, 145 / 145 routes; typecheck, lint (0 errors, 218 warnings unchanged) and schema drift clean.
- **P2028 eliminated:** 1,701 failures in S0 → 0 in S1 under 50 concurrent clients (controlled same-session comparison, §5).
- **P2024 open:** 14 of 1,800 product-list requests timed out waiting for a pool connection (one round). Investigation (§6): the effective pool on this machine is **5 connections with a 10 s timeout in both tested configurations**; the database is **100 % CPU-bound** running each product-list request's COUNT + sort over every live product (~170 ms of CPU per request), so 50 clients queue ~4 s on average and the tail crosses 10 s. **Recommended fix:** cut that per-request CPU with the index work already planned for S2–S3; neither a bigger pool nor a longer timeout fixes it on this evidence.

## 2. Changes (final)

| # | File | Method | S0 | S1 |
|---|---|---|---|---|
| 1 | `modules/audit/audit.repository.ts` | `findManyPaginated` | interactive tx | `paginate` (batch) |
| 2 | `modules/products/products.repository.ts` | `findManyPaginated` (public list) | interactive tx | `paginate` |
| 3 | same | `findManyForAdmin` | interactive tx | `paginate` |
| 4 | `modules/vendors/vendors.repository.ts` | `findManyForAdmin` | interactive tx | `paginate` |
| 5 | same | `findProductsPaginated` (vendor's own) | interactive tx | `paginate` |
| 6 | `modules/bazaars/organizers.repository.ts` | `findManyForAdmin` | interactive tx | `paginate` |
| 7 | `modules/bazaars/bazaars.repository.ts` | `findVendorApplicationsPaginated` | interactive tx | `paginate` |
| 8 | same | `findBazaarApplicationsPaginated` | interactive tx | `paginate` |
| 9 | same | `findManyForAdmin` | interactive tx | `paginate` |
| 10 | same | `findApplicationsForAdmin` | interactive tx | `paginate` |
| — | same | `findByOrganizerIdPaginated`, `findPublicPaginated` | 2 sequential `$queryRaw` | **unchanged (reverted to S0, byte-identical)** |

- **Helper** `src/infra/prisma/paginate.ts`: `paginate(prisma, where, { count, page })` — the same `where` object is passed to both callbacks; both run in one `$transaction([count, page])` (batch). **Test** `src/infra/prisma/paginate.spec.ts` (2 tests): same `where` object to both; exactly one `$transaction` call with an array of the two queries and no options; a failure rejects the whole call.
- **Transaction boundaries:** S0 acquired the connection under `maxWait` 2 s and held it through `BEGIN; COUNT; ⟲Node; SELECT; ⟲Node; COMMIT`. S1 acquires it under the pool timeout (10 s) and holds it for `BEGIN; COUNT; SELECT; COMMIT` sent back to back by the engine. Everything else in each method — `where`, select/include, `orderBy`, `skip`/`take`, location merging, return shape, READ COMMITTED — is unchanged.

## 3. Clean diff against S0 (approved changes only)

Generated from the pre-S1 snapshot to the working tree, byte-exact (CRLF preserved), split per CLAUDE.md; applying the patches to the snapshot reproduces the tree exactly (reproduction check OK).

| Patch | File | + / − | Hunks |
|---|---|---|---|
| 1 repository/service | `src/infra/prisma/paginate.ts` (new) | +32 / 0 | 1 |
| | `src/modules/audit/audit.repository.ts` | +11 / −10 | 2 (import, 1 method) |
| | `src/modules/bazaars/bazaars.repository.ts` | +53 / −52 | 5 (import, 4 methods — no raw-query line touched) |
| | `src/modules/bazaars/organizers.repository.ts` | +11 / −10 | 2 |
| | `src/modules/products/products.repository.ts` | +21 / −22 | 3 |
| | `src/modules/vendors/vendors.repository.ts` | +20 / −19 | 3 |
| 2 controllers/DTOs | — | — | — |
| 3 tests | `src/infra/prisma/paginate.spec.ts` (new) | +39 / 0 | 1 |
| 4 schema/config/docs | `specs/perf/bench-2026-10-31-S1.md`, this report | new | — |

- **Line endings:** `audit.repository.ts` (73 lines), `bazaars.repository.ts` (690), `organizers.repository.ts` (132) are CRLF throughout again, as before S1; `products.repository.ts` and `vendors.repository.ts` were and remain LF. The 3 files were rebuilt from the exact pre-S1 snapshot with only the approved replacements re-applied.
- **Not changed:** no schema, migration, index, pool or environment setting; no controller, DTO or module file; no `Promise.all` introduced (the only one in these files is the pre-existing, byte-identical call in `bazaars.repository.ts findByIdForAdmin`).
- Patches (scratchpad): `stages/S1-1-repository-service.patch`, `S1-3-tests.patch`, `S1-4-schema-config-docs.patch`. The S0 patches are unchanged (7 files, rebuilt as S0-before → S1-before after a tooling slip briefly overwrote them; see §8).

## 4. Verification after the corrections

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | 0 errors |
| Lint | 0 errors, 218 warnings — unchanged from S0 |
| Schema drift (`check:drift`) | no drift |
| Full test suite (`jest --runInBand --forceExit`, `riven_test`, env-guard passed) | **102 / 102 files, 1,399 / 1,399 tests passed, 0 failed, 0 skipped** (1,400 − the removed `paginateRaw` test). One logged warning, identical to S0: `[OrdersJobsService] Expiry schedule reconcile failed (1 in a row): timed out after 5000 ms` (timing warning inside a passing test) |
| Smoke + behaviour snapshot vs the approved S0 baseline | **0 differences**; 290 requests, 69 checks, 0 failed; **145 / 145 routes** |

## 5. Performance — controlled S0 vs S1 comparison

Same session, same `riven_bench_test` data (row counts identical before and after; the run only reads), the S0 build reconstructed from the pre-S1 snapshot and verified byte-exact (`<scratchpad>/build_s0dist.cjs`, `verify_builds.cjs`), ABBA order, 6 rounds per variant; 50 clients × 6 calls = 300 requests per round; 20 warm-up + 200 timed calls per single-request round. Caches warm, not reset between variants (identical for both). Full method and raw data: `<scratchpad>/compare_s0_s1.cjs`, `compare-both.json`.

> This comparison was measured with revision 1, in which the 2 raw bazaar reads were merged. Those 2 methods are now byte-identical to S0, so their S0 rows apply to the current code; the rows for the 10 converted methods are unaffected by the revert.

> **Important (found in §6):** on this machine Prisma's *default* pool is also **5 connections** (2 physical cores × 2 + 1), so the "default" and "pool of 5" columns below are the same effective configuration measured twice — not two different pool sizes.

### 5.1 Concurrency (50 clients, 1,800 requests per variant per configuration)

| Configuration | Query | Build | ok / failed | P2028 | P2024 | req/s (succ.) | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---:|---:|---|---|---|---|
| default (=5) | products public list | S0 | 711 / 1,089 | 1,089 | 0 | 8.6 [4.1–11.7] | 2,363 | 2,839 | 3,118 |
| | | S1 | 1,800 / 0 | **0** | 0 | 9.9 [8.6–11.4] | 5,039 | 5,498 | 5,624 |
| | vendors admin list | S0 | 1,774 / 26 | 26 | 0 | 80.2 [31.1–105.7] | 568 | 1,084 | 1,146 |
| | | S1 | 1,800 / 0 | **0** | 0 | 139.9 [74.9–149.8] | 350 | 615 | 653 |
| | CONTROL vendor orders | S0 | 1,800 / 0 | 0 | 0 | 81.0 [50.6–111.7] | 634 | 953 | 1,155 |
| | | S1 | 1,800 / 0 | 0 | 0 | 78.1 [49.6–108.7] | 602 | 1,006 | 1,070 |
| `connection_limit=5` | products public list | S0 | 1,245 / 555 | 555 | 0 | 17.7 [4.5–29.3] | 2,160 | 2,363 | 2,443 |
| | | S1 | 1,786 / 14 | **0** | **14** | 13.9 [6.2–26.7] | 3,306 | 5,380 | 6,045 |
| | vendors admin list | S0 | 1,769 / 31 | 31 | 0 | 126.8 [32.1–218.5] | 365 | 522 | 548 |
| | | S1 | 1,800 / 0 | **0** | 0 | 126.2 [76.8–264.3] | 369 | 639 | 702 |
| | CONTROL vendor orders | S0 | 1,800 / 0 | 0 | 0 | 125.6 [62.3–208.3] | 377 | 489 | 522 |
| | | S1 | 1,800 / 0 | 0 | 0 | 121.5 [89.2–195.6] | 413 | 561 | 593 |

Medians across rounds [min–max]; latency over successful calls. The bazaar public list (now S0 code again) had 0 errors in both builds.

**Latency, not hidden:** for the product list, S0's figures cover only the requests that succeeded (about half failed after ~2 s). S1 completes every request, so its concurrent latency is higher: **p50 2.4 s → 5.0 s, p95 2.8 s → 5.5 s, p99 3.1 s → 5.6 s** (default configuration). The work the database completes per second is about the same (~10 product-list requests/s) — see §6.

### 5.2 Single request (1,200 samples per variant)

| Query | S0 p50 / p95 / p99 ms | S1 p50 / p95 / p99 ms | Δ p50 | Δ p95 |
|---|---|---|---:|---:|
| products public list | 70.5 / 95.2 / 120.9 | 69.4 / 96.0 / 114.8 | −2 % | +1 % |
| products admin list | 53.8 / 75.5 / 95.5 | 49.7 / 73.5 / 95.9 | −8 % | −3 % |
| vendors admin list | 7.5 / 18.2 / 23.1 | 6.5 / 13.8 / 18.8 | −13 % | −24 % |
| vendor own products | 11.8 / 29.6 / 37.0 | 11.3 / 27.4 / 35.1 | −4 % | −7 % |
| organizers admin list | 6.7 / 17.0 / 25.7 | 5.8 / 12.7 / 17.4 | −13 % | −25 % |
| audit log list | 4.6 / 12.4 / 18.5 | 3.7 / 8.8 / 13.7 | −20 % | −29 % |
| vendor applications | 4.7 / 12.9 / 20.0 | 3.8 / 8.8 / 13.1 | −19 % | −32 % |
| bazaar applications | 4.7 / 12.4 / 16.5 | 4.2 / 9.1 / 13.6 | −11 % | −27 % |
| bazaars admin list | 11.6 / 29.0 / 38.0 | 10.6 / 28.6 / 37.4 | −9 % | −1 % |
| applications admin list | 4.8 / 13.1 / 19.4 | 3.8 / 8.4 / 12.2 | −21 % | −36 % |
| bazaars public / organizer list (raw) | — | **S0 code (reverted)** | 0 | 0 |
| CONTROL vendor orders (unchanged) | 8.5 / 20.1 / 33.2 | 8.4 / 20.9 / 34.6 | −1 % | +4 % |

All 10 converted reads are equal or faster. (Revision 1's merged raw reads measured +15 % / +32 % p50 — the reason for the revert.)

### 5.3 Confidence

6 rounds per variant. Single-request differences ≥ 10 % with non-overlapping round ranges are robust; concurrency throughput ranges overlap heavily (the unchanged control alone ranged 50–112 req/s across rounds of one build), so throughput medians are indicative only. Error counts (P2028 1,701 → 0; P2024 0 → 14) are counts, not estimates. The bench data has no booth listings or audit rows: those lists measure empty results (the transaction mechanism is still exercised).

## 6. P2024 investigation

All probes ran against `riven_bench_test` (env-guard passed), read-only; no pool, timeout or other configuration was changed. Evidence: `<scratchpad>/pool-probe.txt`, `load-monitor.txt`.

### 6.1 Effective pool settings (measured, not assumed)

| Fact | Evidence |
|---|---|
| **Pool timeout = 10 s** | Prisma's own P2024 message under forced exhaustion: `Timed out fetching a new connection from the connection pool … (Current connection pool timeout: 10, connection limit: 5)` |
| **Default connection limit = 5 on this machine** | the same message with **no** `connection_limit` in the URL reports `connection limit: 5`; PostgreSQL showed exactly 5 server connections for one client while 40 calls were queued. Host: 4 logical CPUs = 2 physical cores → Prisma default 2 × 2 + 1 = 5 |
| Consequence | the benchmark's "default pool" and "pool of 5" were the **same configuration**; the 14 P2024 are not specific to an artificially small pool |
| PostgreSQL limits (local) | `max_connections` 100, 8 connections open at rest; `statement_timeout` 0; parallel workers allowed (2 per gather) but none used |

### 6.2 Connection usage during the failing load (S1 product list, 50 clients × 6, sampled every 100 ms, 2 runs)

| Measure | Run 1 | Run 2 |
|---|---|---|
| Result | 300 ok, 0 errors, 11.7 req/s, p50 4,164 / p95 4,857 / p99 5,013 ms | 300 ok, 0 errors, 12.4 req/s, p50 3,997 / p95 4,494 / p99 4,582 ms |
| Server connections in use | avg **4.97**, max 5 | avg **4.96**, max 5 |
| Running a statement / between the two statements of a batch | 4.33 / 0.49 | 4.33 / 0.49 |
| Wait state of active connections | **CPU 743 of 744 samples** (no lock, I/O or client waits) | CPU 714 of 715 |
| Parallel workers | 0 | 0 |
| In-flight COUNT duration under load | median 76 ms, p90 166 ms | median 79 ms, p90 150 ms |

Plans of the two statements of one product-list request (single, unloaded): the **COUNT** is a sequential scan of all products (42,513 live rows kept, 8,733 removed) hash-joined to verified vendors — **93 ms**, 1,705 buffers all in memory; the **page** query is the same scan + join followed by a top-N heapsort on `createdAt` over 39,170 rows — **77 ms**, plus ~12 ms planning. ≈ **170–180 ms of pure CPU per request**.

### 6.3 Root cause

The pool is saturated by CPU-bound work, not by slow acquisition or leaked connections: 5 connections each run ~170 ms of CPU on 2 physical cores (shared with the Node process), so under load each request holds its connection ~400 ms. With 50 concurrent clients, a request waits for ≈ (50 / 5) × 0.4 s ≈ 4 s on average — exactly the measured p50 — and when the machine is momentarily slower (the failing round: p95 10.7 s, p99 11.3 s) the tail exceeds the 10 s `pool_timeout` → P2024. In S0 the same requests failed earlier, at the 2 s `maxWait`, as P2028; S1 changed *which* timeout is hit, and only for the tail.

### 6.4 Production (read from `.env.production.local`, no production service contacted)

- `DATABASE_URL` → Supabase **transaction pooler** (`…pooler.supabase.com:6543`, `pgbouncer=true`); **no `connection_limit` or `pool_timeout`** → Prisma will use 2 × (physical cores of the app host) + 1 and 10 s.
- `DIRECT_URL` → port 5432 is present in the env file but **not used** by `schema.prisma` (no `directUrl`), so migrations would go through the transaction pooler (already an open item in plan A6).
- The Supabase pooler's client-connection limit and the database's direct-connection limit depend on the project's compute size and are **not verified** here — to be read from the Supabase dashboard (Database → Settings → Connection pooling) by Youssef.

### 6.5 Recommendation (evidence-based; nothing applied)

1. **Fix the cause — reduce per-request CPU of the product list (S2–S3, already planned).** Both statements scan and join every live product; an index that serves `ORDER BY "createdAt"` under the live-product filter turns the page query into a short index scan, and a COUNT-support index makes the COUNT an index-only scan. With per-request service time in the tens of milliseconds, the same 50-client load would wait ≈ 10 × ~0.05 s ≈ 0.5 s, far below 10 s. **Acceptance for the fix:** the same 300-request benchmark with 0 P2024 and 0 P2028 in all rounds, measured on this 5-connection machine. This is the next stage and needs your approval.
2. **Do not raise `connection_limit` as the fix.** The database is CPU-bound (99.9 % CPU wait state, 2 physical cores); more concurrent statements would add contention, not throughput, here. On production the right value depends on the app host's cores and Supabase's limits (unknown) — size it from those numbers, not from this laptop.
3. **Do not raise `pool_timeout` as the fix.** It would turn the tail failures into 10 s+ responses.
4. **Production configuration (proposal for Youssef, after 1):** set `connection_limit` and `pool_timeout` explicitly in the production `DATABASE_URL` once Supabase's pooler limit and the host's cores are known, and add `directUrl` for migrations.

## 7. Acceptance criteria (revision 2)

| Criterion | Status | Evidence |
|---|---|---|
| Zero P2028 | **PASS** | 0 in 14,400 S1 requests; S0 1,701 |
| Zero P2024 | **FAIL (open)** | 14 / 1,800 (one round); root cause §6.3; fix proposed §6.5 (S2–S3) |
| Throughput no lower than S0 | **NEEDS REVIEW** | the reverted bazaar reads are S0 code again; product list: default 8.6 → 9.9, `connection_limit=5` 17.7 → 13.9 req/s of *successful* requests with heavily overlapping ranges (S0's number excludes ~50 % failed requests); vendors admin 80 → 140 / 127 → 126 |
| Single-request p50/p95 within S0 noise | **PASS** | 10 converted reads equal or faster; the 2 regressed raw reads reverted to S0 |
| Concurrent p50/p95 reported incl. wait-instead-of-fail increase | **PASS** | §5.1 |
| All tests pass | **PASS** | 1,399 / 1,399 |
| Smoke snapshot: zero unexpected differences | **PASS** | 0 differences, 145 / 145 routes |
| Scope / clean diff | **PASS** | §3 |
| Typecheck / lint / drift | **PASS** | §4 |

**Overall: NEEDS REVIEW** — S1's own goal (no P2028, no behaviour change) is met and the diff is clean; P2024 remains open and its fix belongs to the next stage.

## 8. Deviations and process notes

- **Revision 1 (superseded):** merged the 2 raw bazaar reads (measured slower: +15 % / +32 % p50; throughput 93 → 80 and 164 → 110 req/s) and rewrote 3 CRLF files as LF. Both corrected in revision 2 on Youssef's instruction.
- **Tooling slips (scratchpad only, no project impact):** (a) the first S0/S1 comparison attempt crashed loading the S0 build (`Cannot find module '@nestjs/common'`) and produced no data — discarded; (b) the stage tool first wrote patches in text mode (stripping CRs) and its reproduction check failed for the 3 CRLF files — fixed to write bytes; (c) re-running the S0 patch step against the current tree briefly overwrote the S0 patches with S0+S1 changes — rebuilt as S0-before → S1-before (7 files, reproduction OK).
- **Databases:** `riven_test` (tests, smoke, as usual), `riven_bench_test` (bench and probes; only reads during the comparison and probes), `riven_shadow_test` (drift). `riven` and all production services untouched. Original S0 artifacts (`specs/perf/bench-2026-10-31-S0-baseline.md`, the S0 snapshot baseline, S0 stage snapshot) preserved.
