# Riven API — Admin categories (Task 7) report

**Generated:** 2026-09-25T16:00:49Z
**Spec:** `specs/admin-module-spec2.md` §A7 (corrected during implementation, see §5)
**Branch:** `feature/admin-categories`, from `main` @ `a168df0` (the merge of PR #12, Task 6)
**Working tree:** 12 files modified and 3 new, 584 insertions and 11 deletions. **Uncommitted**; nothing has been pushed by the agent.
**Previous reports:** `…14-35-03Z_admin-management.md` (Tasks 1–3), `…15-06-51Z_admin-applications.md` (4), `…15-16-07Z_admin-orders.md` (5), `…15-30-55Z_admin-ratings.md` (6)

## 1. Summary

Admins can now manage the category taxonomy. Until now it existed only through `prisma/seed.ts`. This is the **first admin write** in pass 2, so it's the first task that uses the `CATEGORY_CREATED`, `CATEGORY_UPDATED` and `CATEGORY` audit values added by the Task 1 migration.

A category change can make product search results stale, so this task also adds a search re-index fan-out. It's built as a new `CATEGORY_PRODUCTS` job modelled on the existing `VENDOR_PRODUCTS` one.

Delete is **not** built. It's Open Item **B3**: `Product.categoryId` is `onDelete: Restrict` and categories have no `deletedAt`.

| Task | Scope | State |
|---|---|---|
| 1–6 | Enums, vendor and product detail, bazaars, applications, orders, ratings | merged (PRs #8–#12) |
| **7** | **`GET`, `POST /admin/categories`, `PATCH /admin/categories/:id`, plus search re-index** | **done, uncommitted** |
| 8 | Docs (CLAUDE.md module list, spec2 status) | next, last |

## 2. Endpoints

| Method | Path | Behaviour | Audit | Errors |
|---|---|---|---|---|
| GET | `/admin/categories` | Flat and alphabetical, not paginated (the taxonomy is small): `[{ id, name, slug, parentId, productCount, childCount }]`. `productCount` excludes soft-deleted products. | — | — |
| POST | `/admin/categories` | Body: `name` (1–60, trimmed), `slug` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤60), `parentId?`. Returns 201. | `CATEGORY_CREATED` | 400 · 404 `CATEGORY_PARENT_NOT_FOUND` · 409 `CATEGORY_SLUG_TAKEN` |
| PATCH | `/admin/categories/:id` | Rename, re-slug and/or move. `parentId: null` moves to the root; an omitted field is left unchanged. | `CATEGORY_UPDATED` (**not** for a no-op) | 400 `CATEGORY_UPDATE_EMPTY` / `CATEGORY_CYCLE` · 404 `CATEGORY_NOT_FOUND` / `CATEGORY_PARENT_NOT_FOUND` · 409 `CATEGORY_SLUG_TAKEN` |

**How the writes follow the rules:**
- **The database enforces slug uniqueness.** The `@unique` constraint is the guard. Its P2002 error is mapped to 409 in the service, the same way `booths.service.ts` does it, with no check-then-write race.
- **The parent and cycle checks happen inside the write's transaction.** The update walks up the ancestor chain of the new parent and refuses if it meets the category itself. It runs at **Serializable** isolation, because two concurrent moves could each pass the check under READ COMMITTED and together form a loop.
- **Audit comes after the commit and is best-effort** (pass 1 §5.2). The actor is always `@CurrentUser()`, never the request body.
- **No-op PATCH:** only the fields that actually differ get written. If nothing differs the response is 200, with no write, no audit row and no re-index.
- **The search re-index is enqueued after the commit.** It runs only when `slug` or `parentId` changed (§5).

## 3. Search re-index mechanism

- **New job:** `{ type: 'CATEGORY_PRODUCTS', categoryId }` in `infra/search/search-sync.job.ts`, with the dedup id `CATEGORY_PRODUCTS.<id>`. There's no `:`, because BullMQ rejects it in ids (see hotfix `2d5db7d`).
- **Enqueuer:** after a slug change or a move, `CategoriesService` works out the category plus all its descendants in memory (`subtreeIds`, which is guarded against corrupt loops) and enqueues one job per category.
- **Processor:** `fanOutCategoryProducts` pages `ProductsService.listProductIdsByCategory` (a new method → `ProductsRepository.listIdsByCategory`, reusing `pageIds`) and enqueues `PRODUCT` jobs. Each product job then decides whether the product is eligible for the index. It's a line-for-line copy of `fanOutVendorProducts`.
- **Module boundaries hold:** categories never touches the products table directly. The processor reads product ids through `ProductsService`, and `SearchIndexQueue` is injected from the global `SearchInfraModule`.

## 4. Files

**New**
- `modules/categories/admin-categories.controller.ts`
- `modules/categories/dto/create-category.dto.ts` (`CreateCategoryDto`, `UpdateCategoryDto`, `CATEGORY_SLUG_PATTERN`)

**Modified**
- `modules/categories/categories.repository.ts`: `findAllForAdmin`, `findById`, checked `create` and `update` returning a `CategoryWriteResult` union
- `modules/categories/categories.service.ts`: `listForAdmin`, `createCategory`, `updateCategory`, the error mapper, and `subtreeIds`
- `modules/categories/categories.module.ts`: imports `AuditModule`, registers the controller
- `infra/search/search-sync.job.ts`: the `CATEGORY_PRODUCTS` job and its id
- `modules/search/jobs/search-sync.processor.ts`: `fanOutCategoryProducts`
- `modules/products/products.{service,repository}.ts`: `listProductIdsByCategory` / `listIdsByCategory`
- Tests: `categories.service.spec.ts` (+16), `search-sync.processor.spec.ts` (+1), `admin/admin-management.e2e.spec.ts` (A7 block; `wipe()` also deletes `mgmt-*` categories)
- Docs: `specs/admin-module-spec2.md` (A7 and A9 corrections), `specs/postman-endpoints.md`

## 5. Spec corrections (written into spec2 A7/A9)

1. **A rename alone doesn't re-index.** The spec said to re-index on changes to `slug`, **`name`** or `parentId`. But `findCategoryPath` builds `categoryPath` from **slugs**, and the name isn't in the search document at all, so only `slug` and `parentId` make documents stale. A unit test checks that a rename writes, audits, and enqueues nothing.
2. **New error `CATEGORY_UPDATE_EMPTY` (400)** for a PATCH with none of the three fields. The spec required "at least one field" but didn't name a code for it.
3. **The cycle check uses Serializable isolation** (the reasoning is in §2).

## 6. Verification (dev machine, 2026-09-25)

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `eslint` over categories, search, products, infra/search, admin | **0 errors**, 19 `no-explicit-any` warnings (test style that was already there) |
| Unit | `pnpm test:unit` | **29 suites, 326 tests passing** (17 new) |
| E2E: admin | `jest --testPathPatterns "admin\|categories.e2e\|search.e2e"` against **`riven_test`** | **All 3 admin suites pass**, including the new A7 block |
| E2E: categories.e2e | same run | passes on its own; in the combined run its `beforeAll` hit the 5 s hook timeout (§7.2) |
| E2E: search.e2e | alone, on this branch **and on unmodified `main`** | **the same 9 / 22 tests fail on both** (§7.1) |

**Unit coverage:**
- create: audited with the right actor and target, no re-index, `parentId` defaults to root, P2002 becomes 409, an unknown parent becomes 404, and nothing is audited on failure.
- update: an empty body gives 400; an unknown id gives 404; a no-op writes, audits and re-indexes nothing; a rename writes only the changed field, audits, and doesn't re-index.
- A slug change re-indexes exactly the subtree, **after** the audit. A move to the root counts as a change.
- `cycle`, `parent_not_found` and `not_found` map to their codes with nothing audited; P2002 on update becomes 409.
- `subtreeIds`: the right subtree, and it terminates on a corrupt loop.
- Processor: `CATEGORY_PRODUCTS` pages by cursor and enqueues `PRODUCT` jobs without touching Meilisearch.

**E2E coverage (A7):**
- The auth check on GET, POST and PATCH.
- The list with correct counts.
- Create root and child: the name is trimmed, **each create leaves exactly one audit row whose `actorId` is the admin**, and the public `/categories` tree shows the child.
- Duplicate slug 409; four malformed slugs, a blank name and an unknown field each 400; an unknown parent 404. **The audit-row count is unchanged afterwards.**
- A move under itself or under its own child is `CATEGORY_CYCLE`; an empty body, an unknown id and a duplicate slug on PATCH are refused. **There are no `CATEGORY_UPDATED` rows for the refused calls.**
- A rename plus re-slug leaves 1 audit row; **the identical PATCH repeated still leaves 1**.
- Moving a category that has products under a parent and back to the root: 2 audit rows, and the parent's `childCount` goes up.

**What isn't proven end to end:** that a re-slug actually updates documents in Meilisearch. The e2e PATCH succeeds, which proves the enqueue works against real Redis. The processor fan-out is unit-tested. But `search.e2e` can't run green on this machine even on `main` (§7.1), so a real "re-slug, then search by the new slug" test would be unreliable here. It should be added once search e2e is healthy.

## 7. Findings

1. **`search.e2e` fails on unmodified `main`.** 9 of 22 tests time out waiting for documents to show up in Meilisearch. The **same 9** fail on this branch. I checked this with a temporary `git worktree` of `main` in the scratchpad, borrowing `node_modules` through directory junctions. The worktree has been removed, and the real `node_modules` was checked afterwards (761 packages, unit tests green). Meilisearch is healthy (`/health` returns available). One run logged "Meilisearch unavailable at boot", which didn't happen again. A dev server competing for the shared `search-sync` queue was ruled out, because nothing is listening on port 3000. **The root cause is still unknown**, and this needs its own investigation.
2. **`categories.e2e` hits the 5 s `beforeAll` limit** in combined runs, the same way `admin-management` did in Task 4. It passes on its own. This is more evidence for a repo-wide `testTimeout` in the Jest config.
3. **Carried over:** 5 outdated e2e tests on `main` (2 × `body.total`, 3 in `social.e2e`), for the suggested `fix/stale-e2e-assertions` change. spec2 Part B is still open for Ibrahim.
4. **The category path is capped at depth 10.** `findCategoryPath` stops at `CATEGORY_PATH_MAX_DEPTH = 10`. Admin moves aren't depth-limited, so a subtree moved deeper than 10 levels would get a truncated `categoryPath` in search. That's unrealistic for this taxonomy, and it's noted rather than enforced.

## 8. Postman (workspace "Riven")

Added to the **Products** collection, next to the public "Get Categories":
- `Admin - Get All Categories`: `GET {{URL}}admin/categories`
- `Admin - Create Category`: `POST`, with an example body (`maxi-dresses` under a parent)
- `Admin - Update Category`: `PATCH {{URL}}admin/categories/:id`, with an example rename body

## 9. Next

1. Review, then commit on `feature/admin-categories`. Suggested message: `feat(admin): admin category management with audit and search re-index`
2. Task 8: docs (CLAUDE.md module list, spec2 status), which closes out pass 2 Part A.
3. Separately: `fix/stale-e2e-assertions`, a Jest `testTimeout`, and investigating `search.e2e`.
