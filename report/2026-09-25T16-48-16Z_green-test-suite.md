# Riven API — Green test suite report

**Generated:** 2026-09-25T16:48:16Z
**Branch:** `fix/stale-e2e-assertions`, from `main` @ `3df8f03` (the merge of PR #14)
**Working tree:** 7 files, 96 insertions and 13 deletions. **Test code and Jest config only; no application code changed.** Uncommitted; nothing has been pushed by the agent.
**Follows:** `report/2026-09-25T16-10-54Z_admin-pass2-closeout.md` §5, which listed the test debt fixed here.

## 1. Outcome

**The whole suite is green for the first time.** Unit tests and every e2e suite, run together:

```
Test Suites: 41 passed, 41 total
Tests:       536 passed, 536 total
```

That's `jest --runInBand` in `apps/api` against the throwaway `riven_test` database. Lint: 0 errors. Typecheck: exit 0.

Before this branch, e2e on `main` had **6 broken suites**. CI runs e2e, so CI was red on `main` for reasons unrelated to any feature change.

The user's "do it all" request covered four follow-ups. Three are done here. The fourth, the spec2 Part B admin writes, is Ibrahim's decision and was deliberately **not** touched.

## 2. What was broken, and the fix

| # | Suite | Symptom | Root cause | Fix |
|---|---|---|---|---|
| 1 | `bazaars.e2e` "7b" | `body.total` undefined | The list returns `{ data, meta: { total } }` | Assert `body.meta.total` |
| 2 | `checkout.e2e` vendor order list | same | same | same |
| 3–5 | `social.e2e` favorites and follows (3 tests) | 404 instead of 200 | The fixture seeded an **unverified** vendor and a **PENDING** product. Since `6fd94ef` (VULN-04), follow and favorite require a publicly visible target. The API is correct. | Seed `verified: true` and `approvalStatus: 'APPROVED'` (after checking that no test there needs a hidden target) |
| 6 | `users.e2e` (whole suite) | Nest DI error: `SearchIndexQueue`, then `DomainEvents`, unavailable | The suite builds a partial graph (`UsersModule` + `PrismaModule`). `UsersModule` imports `VendorsModule` and `BazaarsModule`, whose own dependencies need the global search infra, domain events and BullMQ, none of which are loaded. `UsersService` is mocked anyway. | `overrideModule(VendorsModule / BazaarsModule)` with empty stubs, the same pattern the suite already used for `AuthModule` |
| 7 | `search.e2e` (9 of 22) | Filtered searches 500 with ``Attribute `scheduleType` is not filterable``; index waits time out | **An ordering bug.** `app.init()` bootstraps the `riven_test_*` indexes **with settings** and flags search `ready`. The suite **then** dropped them. Nothing re-applies settings once `ready` is set, so the first document write auto-created a **bare** index. Also, `deleteIndexIfExists` only *enqueues* the delete, so the drop raced the test's writes too. | A new `resetTestIndexes()`: delete with `waitTask()`, then create and `updateSettings(SEARCH_INDEX_SETTINGS[name])` with `waitTask()`, reusing the app's own settings |
| 8 | `search.e2e` "category=<slug> matches the whole subtree" | Hidden behind #7; appeared once #7 was fixed | It expected `q=dress` to find a product whose text is Arabic only (`فستان`). There are no synonyms, so it can't. | Keep the intent (the subtree filter covers deep and direct children) with two queries: `dress` finds the linen product two levels down, `فستان` finds the product directly under `women` |
| 9 | Flaky `beforeAll` (admin-management, categories) | "Exceeded timeout of 5000 ms for a hook", intermittent | No Jest `testTimeout`. App boot plus bcrypt(12) registrations sit near 5 s. | `"testTimeout": 30000` in `apps/api/package.json`, and the one-off per-hook override from Task 4 removed, so there's one rule in one place |

**How #7 was diagnosed,** because an obvious theory was ruled out first:
- The `search-sync` queue was empty, with no failed jobs, and no other Redis clients were connected, so there was no backlog and no competing worker.
- Meilisearch had only 1 failed task: a stale `index_not_found` from a delete, which was itself evidence of the fire-and-forget drop.
- The app log during the run showed the actual 500s ("not filterable").
- The live `riven_test_bazaars` index was missing after the run, while `riven_development_bazaars` had its filterable attributes, so the settings **had** been applied and then lost.
- Before the fix, the failure was shown to be identical on unmodified `main`, using a scratch `git worktree` (see the Task 7 report).

## 3. Added: Task 7 proven end to end

The admin-categories report (`…16-00-49Z`) flagged that the category re-index was only unit-tested, because `search.e2e` was unusable. With #7 fixed, `search.e2e` now has an **"admin category re-slug"** test:
- `PATCH /admin/categories/:maxiId { slug: 'maxi-gowns' }` returns 200.
- It waits until the linen product's **Meilisearch document** has `categorySlug: 'maxi-gowns'` and `categoryPath: ['women','dresses','maxi-gowns']`.
- `GET /search/products?q=linen&category=maxi-gowns` finds it.
- A `finally` block restores `maxi-dresses` and waits for the document to revert, because `beforeAll` upserts by slug. The suite passed **twice back to back**, which proves the restore.

That runs the whole chain for real: admin write, audit, `CATEGORY_PRODUCTS` job, processor fan-out, `PRODUCT` jobs, Meilisearch, search API.

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | **0 errors**, 138 warnings (all `no-explicit-any`) |
| `search.e2e` alone | 23/23, **two runs in a row** |
| `users.e2e` alone | 9/9 |
| All e2e except search | 11/11 suites, 187/187 |
| **Everything** (`jest --runInBand`, unit + e2e, `riven_test`) | **41/41 suites, 536/536 tests** |

## 5. Notes for reviewers

- **Local runs share the dev indexes.** Sourcing `.env` exports `NODE_ENV=development`, so e2e runs use the `riven_development_*` index prefix and the dev `search-sync` queue. The one exception is `search.e2e`, which pins `riven_test_`. It's harmless here, but a dev server running during e2e *could* consume the tests' sync jobs. CI is unaffected because it uses throwaway containers.
- **CLAUDE.md inaccuracy (not changed here):** Gotchas says "no seed script", but `apps/api/prisma/seed.ts` exists (it seeds the category tree, and `prisma db seed` is wired up in `package.json`). It's a one-line doc fix for a later docs change.
- `social.e2e` now seeds public targets. If a future test there needs a **hidden** target, it should create its own and not change the shared fixture.

## 6. Commit

```bash
git add apps/api/package.json apps/api/src report
git commit -m "fix(test): green e2e — stale asserts, social fixtures, users DI stubs, search index reset, jest testTimeout"
git push -u origin fix/stale-e2e-assertions
```

Once merged, CI's e2e job should go green on `main` for the first time since the search module landed.
