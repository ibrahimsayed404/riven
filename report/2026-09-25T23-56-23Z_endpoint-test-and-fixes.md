# Riven API: every endpoint tested live, bugs fixed

**Generated:** 2026-09-25T23:56:23Z
**Branch:** `fix/endpoint-test-findings`, from `main` @ `d3a721c`. **Uncommitted**; the agent committed and pushed nothing. The branch also carries the earlier doc-only changes from the Postman audit (`report/2026-09-25T22-58-07Z_postman-coverage-audit.md`).
**Databases:** every test ran against the throwaway `riven_test`. Youssef's `riven` database was only **read**, to count backwards-dated bazaars (0 of 5). It was **not migrated**; see §6.

## 1. Outcome

| | Before | After |
|---|---|---|
| Live HTTP run (all 120 routes, real server) | 232 requests, 3 failures, 119/120 routes | **242 requests + 50 checks, 0 failures, 120/120 routes** |
| Full jest (unit + e2e, `--runInBand`) | 43 suites / 660 tests | **44 suites / 693 tests, all green**, exits cleanly in 85 s |
| Typecheck · lint · check:env | ok | ok · **0 errors** (178 warnings, all `no-explicit-any` in test mocks) · ok |

**Five bugs were fixed (§3).** Four were found by the live run and one by investigating a test hang. One more (§4) was a test-cleanup weakness that the live data exposed.

## 2. How it was tested

1. **Baseline:** the full jest suite on `riven_test`. 43/43 suites, 660/660 tests.
2. **Live run.** This is now part of the repo: `pnpm --filter @riven/api smoke`, which runs `apps/api/scripts/smoke-live.mjs`. It builds, starts the API itself, runs every route, stops the API, and exits 0 only when every request and check passed and every controller route was exercised. The last run was 241 requests, 51 checks, 0 failed and 120/120 routes, in about 46 s.
   - It hits the built API (`node dist/main.js`) on port 3100, with `DATABASE_URL` pointing at `riven_test`. It refuses any database whose name doesn't end in `_test`.
   - It uses `NODE_ENV=test`, so search indexes get the `riven_test_*` prefix, and its own Redis database.
   - It walks the whole product in real order, with real tokens:
     1. register the four roles
     2. admin verification
     3. category, product and variant
     4. approval and search
     5. cart, checkout, order status flow and delivery
     6. ratings and moderation
     7. organizer, bazaar, publish, discovery and applications
     8. booth layout and assignment
     9. cancels, the organizer reject/verify visibility flip, reindex, media, dashboard and audit log
     10. the Paymob webhook
   - It checks the status code of every request, plus 50 behaviour checks, for example:
     - stock reserved and restored
     - public ratings expose no `userId`
     - audit rows written, and none written for no-ops
     - deleted and cancelled items gone from search
   - It also sends probes that should be refused.
   - Route coverage is computed against the 120 routes parsed from the controllers.
3. Every failure was reproduced before it was fixed. Then unit and e2e tests were added, the full suite was run, and the live run repeated.

## 3. Bugs fixed

### 3.1 A bazaar could end before it starts
- **Found:** live. `POST /organizers/me/bazaars` with `endDate` earlier than `startDate` returned **201**, and so did a `PATCH` that did the same.
- **Why it matters:** the completion job (bazaars-module-spec2 §35) and discovery's `upcomingOnly` both read `endDate < now` as "over". A bazaar starting in 10 days with an end date 5 days away would be completed, and dropped from discovery, before it opened.
- **Fix:**
  - `BazaarsService` refuses it with 400 **`BAZAAR_END_BEFORE_START`**. On a partial update it checks against the stored date the request leaves unchanged. An equal date is allowed; an omitted `endDate` is still a single-day event.
  - A new migration, `20260926010000_bazaar_end_date_not_before_start`, adds `CHECK ("endDate" IS NULL OR "endDate" >= "startDate")`. That closes the race between two partial PATCHes, one moving `startDate` and one moving `endDate`.
  - Prisma can't model CHECK constraints, so a comment in `schema.prisma` points to it, the same way the GIST index is documented.
- **Tests:**
  - unit: create refuses a backwards range and accepts none / equal / after; update covers three refusals and three allowed cases
  - e2e `3b`: HTTP 400 on create and on patch, and a raw SQL update rejected by `bazaars_end_date_not_before_start`

### 3.2 A vendor's own rename left the old name on their products in search
- **Found:** live. After `PATCH /vendors/me {businessName}`, the vendor's search document had the new name, but every product document kept `vendorName` = the old name. The admin edit (spec3 B2) already handled this; the owner route didn't. This was follow-up #1 in the Part B report.
- **Fix:** `VendorsService.updateMyProfile` enqueues `VENDOR_PRODUCTS` when `businessName` actually changes, as `updateVendorForAdmin` does.
- **Tests:**
  - unit: a rename fans out; another field, or the same name, doesn't; 404 enqueues nothing
  - e2e against real Meilisearch (`search.e2e`): the product document follows the vendor's own rename

### 3.3 An organizer's accept/reject could overwrite an admin decision
- **Found:** code, confirmed by the live flow. `decideApplication` read the application, checked PENDING, then did an **unguarded** `update`. An admin decision landing between the read and the write was silently overwritten, for example REJECTED → ACCEPTED, which breaks the "no reversals" rule of spec3 B5. This was follow-up #2.
- **Fix:** the organizer path uses the same guarded `transitionApplication` as the admin path (`updateMany … where applicationStatus = PENDING`). If 0 rows move, it returns 409 **`APPLICATION_STATE_CHANGED`**. The response is re-read, so its shape is unchanged. The now-unused `BazaarsRepository.updateApplicationStatus` is removed.
- **Tests:** unit (accept path, lost race → 409 with no event, already decided, another bazaar's application), plus the existing e2e accept.

### 3.4 Cancelling an already cancelled bazaar wrote it again
- **Found:** code, confirmed live (`updatedAt` changed on the repeat). This was follow-up #3.
- **Fix:** the organizer cancel returns early for CANCELLED, with nothing written or re-indexed. This is the same no-op as the admin cancel (spec3 B7).
- **Tests:** unit, plus e2e `11` (a repeat cancel returns 200 with the same `updatedAt`).

### 3.5 `REDIS_URL` lost its database number, TLS and encoded passwords
- **Found:** while investigating why search fan-outs "disappeared" in the live run.
  - `QueueModule` built the connection from host, port and raw credentials only.
  - `redis://host:6379/1` silently used database 0. `rediss://` (TLS, what managed Redis hands out) connected without TLS. A password with `@` or `/` wasn't decoded.
  - As a result, the test server and a leftover jest app shared one queue, and the jest app's worker consumed the server's `VENDOR_PRODUCTS` jobs against the dev index prefix.
  - **In production, two environments on one Redis would do the same, and a TLS Redis wouldn't connect at all.**
- **Fix:**
  - A new `infra/queue/redis-connection.ts` (`redisConnectionFromUrl`) honours the database number, `rediss://` → `tls: {}`, and decoded credentials.
  - It rejects an invalid database number and non-Redis schemes.
  - The local `.env` (`redis://localhost:6379`) behaves exactly as before.
- **Tests:** unit, 9 cases. Live: after the fix the server's worker is alone on `db=1`, and every reject / verify / rename fan-out runs and updates both products.

## 4. Test-suite fix

`bazaars.e2e` deleted vendors without first deleting their products and orders.
- Its setup therefore failed whenever other data was present, as happens after the live run or depending on test order.
- Its `afterAll` also threw **before `app.close()`**, so jest printed its summary and then hung forever with live BullMQ workers.
- That hang is what stalled the first post-fix run.

It now uses the same dependency-ordered `wipe()` as `booths.e2e` and `admin-management.e2e`, and closes the app in a `finally`. `booths.e2e` had the same flaw and was fixed during Part B.

## 5. Checked, not bugs, or not decided here

- **Rating a bazaar that hasn't happened yet** is allowed (PUBLISHED or COMPLETED). That was decided in fix sweep SPEC-03, so it was left as is. The DTO comment "once it has run" is looser than the rule.
- **`vendorType` isn't enforced.** A BAZAAR_ONLY vendor can create products, and a MARKETPLACE vendor can apply to bazaars; the live test vendor did both. vendor-module-spec §41 says the type only decides "what section of the app they appear in". **Question for Ibrahim:** should BAZAAR_ONLY block selling, and MARKETPLACE block bazaar applications?
- **Deciding applications on a CANCELLED or COMPLETED bazaar** is allowed on both the organizer and admin paths. spec3 B5 doesn't restrict it. **Question for Ibrahim.**
- Everything else the live run exercised behaved as documented, including:
  - the ownership checks, and the 401/403 role checks
  - idempotent no-ops write no audit row
  - stock is reserved and restored across group cancels
  - public ratings expose `reviewerName` only
  - rejected organizers' bazaars leave detail, layout, list, discovery and search, and come back on re-verify
  - a vendor reject hides the shop and products and blocks the cart
  - the Paymob webhook refuses unsigned calls (401 `WEBHOOK_SIGNATURE_MISSING`)

## 6. For Youssef

- **Apply the migration to `riven`** when you check out this branch: `pnpm --filter @riven/api prisma migrate deploy`. It's safe: your `riven` has 0 backwards-dated bazaars. Without it, the service check still works; only the DB backstop is missing.
- **Docs are updated for the new behaviour:**
  - `specs/postman-endpoints.md`: bazaar create/update errors, organizer cancel no-op, organizer accept/reject 409, vendor rename re-index, and the federated search shape (`{ products: { hits, … } }`, which the doc and Postman had wrong).
  - **Postman:** 7 requests (Organizer → Create Bazaar, Update Bazaar, Cancel Bazaar, Accept Application, Reject Application; Vendor → Update Me; Discovery-Search → Search All).
- **Suggested commits** (or squash them into one, `fix: endpoint test findings`):
  1. `fix(bazaars): refuse endDate before startDate (service + CHECK constraint)`: the migration, `schema.prisma`, `bazaars.service.ts` (helper + create/update), unit and e2e `3b`
  2. `fix(vendors): re-index products when a vendor renames their own shop`: `vendors.service.ts` and its spec, `search.e2e`
  3. `fix(bazaars): guard the organizer application decision; organizer cancel is idempotent`: `bazaars.service.ts`, `bazaars.repository.ts`, unit, e2e `11`
  4. `fix(queue): honour the REDIS_URL database number, TLS and encoded credentials`: the `infra/queue/*` files
  5. `test(bazaars): dependency-ordered wipe and always close the app`: `bazaars.e2e`
  6. `test(api): add the live smoke run over every route`: `scripts/smoke-live.mjs`, the `smoke` script in `package.json`, and CLAUDE.md
  7. `docs: Postman sync and endpoint-test report`: `specs/*`, `report/*`

  `bazaars.service.ts` has changes for commits 1 and 3, so a squash may be easier.
