# Riven API — Admin applications (Task 4) report

**Generated:** 2026-09-25T15:06:51Z
**Spec:** `specs/admin-module-spec2.md` §A4
**Branch:** `feature/admin-applications`, re-created from `main` @ `97a8c78` (the merge of PR #9, Task 3)
**Working tree:** 6 files modified and 2 new, 199 insertions and 2 deletions. **Uncommitted**; nothing has been pushed by the agent.
**Previous report:** `report/2026-09-25T14-35-03Z_admin-management.md` (Tasks 1–3)

## 1. Summary

Admins can now see every booth application on every bazaar. Until now the only views were the organizer's, limited to their own bazaars, and the vendor's, limited to their own applications. This task is **read-only**: accepting or rejecting an application stays with the organizer, and admin decisions wait on Open Item **B5**.

Task 4 was started twice. The first attempt was interrupted. It was redone from scratch on a clean branch after removing the two untracked files that attempt had left behind.

| Task | Scope | State |
|---|---|---|
| 1 | Migration for the category audit enums | merged (PR #8) |
| 2 | `GET /admin/vendors/:id`, `GET /admin/products/:id` | merged (PR #8) |
| 3 | `GET /admin/bazaars`, `GET /admin/bazaars/:id` | merged (PR #9) |
| **4** | **`GET /admin/applications`, `GET /admin/applications/:id`** | **done, uncommitted** |
| 5 | Admin orders list and detail | next |
| 6 | Admin ratings list | todo |
| 7 | Categories: list, create, update, plus search re-index | todo |
| 8 | Docs | todo |

## 2. Endpoints

| Method | Path | Returns | Errors |
|---|---|---|---|
| GET | `/admin/applications` | Every application on every bazaar, newest first, as `{ data, meta }`. Filters: `bazaarId?`, `vendorId?`, `status?` (PENDING/ACCEPTED/REJECTED), `page`, `limit`. Each row embeds `bazaar { id, name, status, startDate }`, `vendor { id, name, verified }`, `booth { id, label } \| null`. | 400 on a bad enum, a non-uuid id or an unknown query field |
| GET | `/admin/applications/:id` | One application, same shape as a list row, including applications on soft-deleted bazaars | 404 `APPLICATION_NOT_FOUND` (an existing code, reused) |

Both have class-level `JwtAuthGuard` and `RolesGuard` with `@Roles(Role.ADMIN)`. They are reads, so no audit rows are written. Each list is one `$transaction` (a count and a page) with the relations loaded through a single Prisma `select`, so there is no N+1.

## 3. Files

- `apps/api/src/modules/bazaars/admin-applications.controller.ts`: **new**
- `apps/api/src/modules/bazaars/dto/admin-list-applications-query.dto.ts`: **new**, extends the shared `PaginationQueryDto`
- `apps/api/src/modules/bazaars/bazaars.repository.ts`: `adminApplicationSelect`, `AdminApplication`, `findApplicationsForAdmin`, `findApplicationByIdForAdmin`
- `apps/api/src/modules/bazaars/bazaars.service.ts`: `listApplicationsForAdmin`, `getApplicationForAdmin`
- `apps/api/src/modules/bazaars/bazaars.module.ts`: registers the controller
- `apps/api/src/modules/bazaars/bazaars.service.spec.ts`: 3 unit tests
- `apps/api/src/modules/admin/admin-management.e2e.spec.ts`: two application fixtures (one PENDING, one older REJECTED on the soft-deleted bazaar), the A4 tests, and a `beforeAll` timeout fix (§5)
- `specs/postman-endpoints.md`: the two routes

The existing organizer and vendor application routes and `decideApplication` are **unchanged**.

## 4. Verification (dev machine, 2026-09-25)

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `eslint src/modules/bazaars src/modules/admin` | **0 errors**, 22 `no-explicit-any` warnings (test style that was already there) |
| Unit | `pnpm test:unit` | **29 suites, 305 tests passing** (3 new) |
| E2E | `jest --runInBand --testPathPatterns "admin\|bazaars.e2e\|booths"` against **`riven_test`** | **85 / 86 passing, twice in a row after the fix.** The 1 failure is the outdated test already on `main` (§6.1). |

**New e2e coverage:**
- The auth check on both routes: ADMIN 200, VENDOR/ORGANIZER/SHOPPER 403, no token 401.
- Newest-first ordering, and the embedded bazaar, vendor and booth.
- Each filter, alone and combined with `limit`; 400 on `status=APPROVED`, a non-uuid `bazaarId`, and an unlisted `organizerId` query field.
- The detail view of an application on a soft-deleted bazaar; 404 for an unknown id.
- **Ownership still holds:** a second organizer still can't list another organizer's applications.

## 5. Found and fixed: intermittent e2e setup timeout

In 2 of 7 runs of the admin, bazaars and booths suites, **every** test in `admin-management.e2e.spec.ts` failed together, Tasks 1–3 included. Run on its own, the suite always passed.

**Cause:** Jest has no `testTimeout` configured, so hooks get the 5 s default. This suite's `beforeAll` boots the app and runs five registrations, each hashing a password with bcrypt at 12 rounds. That puts it right at the 5 s limit, and in the failing run the suite took 8.3 s. When `beforeAll` times out, every test in the file fails.

**Fix:** `beforeAll(…, 30_000)`, the same explicit-timeout pattern `search.e2e.spec.ts` uses. It's test-only; no application code changed. The full set passed twice after the fix.

The other e2e suites have the same exposure. A repo-wide `testTimeout` in the Jest config would cover them all, but that's a config change outside this task and is left as a suggestion.

## 6. Findings (open)

1. **An outdated e2e test is already on `main`.** `bazaars.e2e.spec.ts:193` ("7b") asserts `res.body.total`, but `GET /vendors/me/bazaar-applications` returns `{ data, meta: { total } }`. The one-line fix is `res.body.meta.total`. It should be a separate `fix(test)` change. It still fails in CI.
2. **A Jest-wide `testTimeout`** (see §5): suggested, not done.

## 7. Postman (workspace "Riven")

Added to the **Bazaars** collection, next to the admin organizer and bazaar requests:
- `Admin - Get All Applications`: `GET {{URL}}admin/applications`. The `status`, `bazaarId` and `vendorId` params are included but disabled.
- `Admin - Get Application By Id`: `GET {{URL}}admin/applications/:id`

## 8. Next

1. Review, then commit on `feature/admin-applications` and open the PR. Suggested message: `feat(admin): admin booth applications list and detail across all bazaars`
2. Task 5: admin orders.
