# Riven API — Admin pass 2: close-out report

**Generated:** 2026-09-25T16:10:54Z
**Spec:** `specs/admin-module-spec2.md`
**Branch (Task 8):** `feature/admin-docs`, from `main` @ `94dfc40` (the merge of PR #13). The Task 8 diff is **documentation only**: `CLAUDE.md` and the spec, 35 insertions and 15 deletions. Uncommitted; nothing has been pushed by the agent.
**Per-task reports:** `report/2026-09-25T14-35-03Z_admin-management.md` (Tasks 1–3), `…15-06-51Z_admin-applications.md`, `…15-16-07Z_admin-orders.md`, `…15-30-55Z_admin-ratings.md`, `…16-00-49Z_admin-categories.md`

## 1. Outcome

**Spec2 Part A is complete.** Admins can now see and manage the platform through dedicated `/admin/*` routes. Each lives in its own domain module and is backed by `*ForAdmin` methods that look up records globally by id.

**The rejected alternative** was letting ADMIN pass every role check in `RolesGuard`. That was never built: `RolesGuard` is unchanged, every owner route kept its ownership check, and the e2e suite checks that non-owners are still refused.

| Task | Delivered | PR |
|---|---|---|
| 1 | Migration: `AdminAction.CATEGORY_CREATED`, `CATEGORY_UPDATED`; `AdminTargetType.CATEGORY` | #8 |
| 2 | `GET /admin/vendors/:id`, `GET /admin/products/:id`: any state, soft-deleted included | #8 |
| 3 | `GET /admin/bazaars`, `/:id`: every organizer's bazaars, DRAFT included | #9 |
| 4 | `GET /admin/applications`, `/:id`: every booth application (read-only) | #10 |
| 5 | `GET /admin/orders`, `/:id`: every order, the detail with the Paymob record (read-only) | #11 |
| 6 | `GET /admin/ratings`: moderation list with `hasComment` / `maxScore` (read-only) | #12 |
| 7 | `GET`, `POST /admin/categories`, `PATCH /:id`: audited, with a `CATEGORY_PRODUCTS` search fan-out | #13 |
| 8 | Docs: CLAUDE.md admin surface, layout and conventions; spec2 status | this change |

**14 new admin endpoints** in total. All are on the Postman "Riven" workspace, and all are documented in `specs/postman-endpoints.md`.

## 2. Task 8 changes

**`CLAUDE.md`**
- **The repo layout was stale.** It listed 9 of the 16 modules and was missing `common/{dto,events,guards}` and `infra/{search,storage}`. It now matches `apps/api/src`.
- **New "Admin surface" section:** why there's no guard bypass, and a table mapping every `/admin/*` prefix to its controller file and what admin can do there. It ends with a pointer that the remaining admin writes are Part B Open Items and must not be built without Ibrahim.
- **Audit rule, expanded:** a new target kind also needs an `AdminTargetType` value, and enum-only migrations can be hand-written (`ALTER TYPE … ADD VALUE`), because `prisma migrate dev` hangs on its interactive prompt in the agent shell.
- **New "Search sync" convention:** enqueue through `SearchIndexQueue` after the commit; use a fan-out job (`VENDOR_PRODUCTS`, `CATEGORY_PRODUCTS`) when a write changes *other* entities' documents; no `:` in job ids.

**`specs/admin-module-spec2.md`**
- The status header now says Part A is implemented and merged, and Part B is still open. The A10 task table records the PR for each task.
- The deviations found during implementation were already written inline in A1–A9 as each task landed.

## 3. Deviations from spec2, all recorded inline in the spec

1. A malformed `:id` returns **404**, not 400. This matches the pass 1 admin routes, which don't use `ParseUUIDPipe`.
2. The organizer object is `{ id, name, verified }`. The column is `name`; `organizationName` is only the registration field.
3. **Category re-index only on a slug change or a move**, not on a rename. `categoryPath` is built from slugs, and the name isn't in the search document.
4. New error **`CATEGORY_UPDATE_EMPTY`** (400).
5. The category cycle check runs at **Serializable** isolation.

## 4. Verification across the pass

- Every task: `pnpm typecheck` passes on both tsconfigs; ESLint has **0 errors**; `pnpm test:unit` is green. The final unit count is **326 tests across 29 suites**, up from 299 at the start of the pass.
- **E2E:** `admin-management.e2e.spec.ts` is new and covers every pass 2 route: the auth check, global reach, filters, validation, coded 404s, audit rows (and none for no-ops or refused writes), and ownership still holding on owner routes. It passes, along with the pass 1 admin suites.
- **All e2e runs used a separate `riven_test` database.** The e2e suites wipe tables, and Youssef tests by hand against `riven`, which was never touched.

## 5. Open items and test debt (none introduced by this pass)

**For Ibrahim, spec2 Part B, nothing built:**
- B1 vendor suspend
- B2 admin edits
- B3 deletes (product, category, rating)
- B4 product unpublish
- B5 admin decisions on applications
- B6 order status, cancel and refund (refund also needs the Payments spec and a Paymob sandbox)
- B7 bazaar cancel
- B8 the four items still open from pass 1

**Test debt found on `main`, each shown to fail on `main` itself:**
1. `bazaars.e2e.spec.ts:193` and `checkout.e2e.spec.ts:191` assert `body.total`, but those endpoints return `body.meta.total`.
2. Three tests in `social.e2e.spec.ts` seed an unverified vendor and a PENDING product, so favorite and follow correctly return 404 since `6fd94ef`.
3. `search.e2e.spec.ts` fails 9 of 22 on unmodified `main`, with the cause undetermined. Meilisearch is healthy, and a dev server competing for the queue was ruled out.
4. Jest has no `testTimeout`, so heavier `beforeAll` hooks flake at the 5 s default. This was fixed locally for `admin-management` and seen in `categories.e2e`.

**Suggested follow-ups**
- `fix/stale-e2e-assertions` for items 1 and 2
- a repo-wide `testTimeout` for item 4
- a separate investigation of `search.e2e` (item 3)

## 6. Commit (Task 8)

```bash
git add CLAUDE.md specs/admin-module-spec2.md report
git commit -m "docs(admin): admin surface in CLAUDE.md, spec2 Part A marked done"
git push -u origin feature/admin-docs
```
