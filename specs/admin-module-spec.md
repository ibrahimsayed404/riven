# Admin Module Spec

**Status:** Draft for review
**Scope:** Moderation queues for vendors / organizers / products, reject-with-reason for vendors and organizers, an admin audit log, and an overview endpoint for the admin dashboard home. A new cross-cutting `modules/admin/` plus a leaf `modules/audit/`; the existing per-module `admin-*.controller.ts` files stay where they are and grow.
**Depends on:** `User`, `Vendor`, `Organizer`, `Product`, `Bazaar`, `Order` models (migrated). `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`. `SearchIndexQueue` (`infra/search`). The `{ data, meta }` pagination shape from `UsersService.getAdminUserList`.
**Out of scope (this pass):** Admin bootstrap (seeding the first `ADMIN` user — Open Item 1), refresh-token revocation on deactivate (Open Item 6), auditing booth-layout and search-reindex operations (Open Item 4), rate limiting on `/admin/*` (Open Item 7), disputes / flagged-content moderation (`riven-spec.md` §10, no schema for it yet).

Written against `apps/api/prisma/schema.prisma` as of `776a583`, not `specs/schema.prisma`.

> **Superseded (product moderation):** everything below about a product moderation queue, `approve`/`reject`, and `pending.products` no longer reflects the code — product approval was removed by product decision, 2026-09-27. See `specs/vendor-module-spec2.md`. Vendor/organizer moderation (this file's §3) is unaffected.

---

## 0. What exists today, and what's missing

Six controllers already carry `@Roles(Role.ADMIN)`:

| Controller | Routes today |
|---|---|
| `vendors/admin-vendors.controller.ts` | `PATCH /admin/vendors/:id/verify` |
| `bazaars/admin-organizers.controller.ts` | `PATCH /admin/organizers/:id/verify` |
| `products/admin-products.controller.ts` | `PATCH /admin/products/:id/approve`, `PATCH /admin/products/:id/reject` |
| `users/admin-users.controller.ts` | `GET /admin/users`, `GET /admin/users/:id`, `PATCH …/deactivate`, `PATCH …/reactivate` |
| `booths/admin-booths.controller.ts` | layout + booth CRUD, assign/unassign |
| `search/admin-search.controller.ts` | `POST /admin/search/reindex` |

An admin **cannot**: list what is pending (nothing feeds the approve endpoints), reject or revoke a vendor/organizer (`verified` is a bare boolean, no reason field), see who did what (no audit trail), or get counts for a dashboard home. `verifyVendor` also ignores `deletedAt` (`vendors.service.ts:101-115`).

## 1. Module shape

**Decision:** approval endpoints stay in their domain modules — CLAUDE.md's "controllers are split by audience, not merged" convention, and no churn across six modules. Two new modules own only what has no domain home:

```
modules/audit/                    # LEAF — depends on PrismaModule only
  audit.module.ts                 # exports AuditService
  audit.repository.ts             # every Prisma call on AdminAuditLog
  audit.service.ts                # record(entry), list(query)
  audit.service.spec.ts

modules/admin/                    # imports Audit, Vendors, Bazaars, Products, Users, Orders
  admin.module.ts
  admin-overview.controller.ts    # GET /admin/overview
  admin-overview.service.ts       # Promise.all over six public-service calls
  admin-audit-log.controller.ts   # GET /admin/audit-log
  dto/list-audit-log-query.dto.ts
  admin.e2e.spec.ts
```

**Why audit is not inside `admin/`:** domain services (`VendorsService.verifyVendor`, …) must *write* audit rows, and `AdminModule` must import those domain modules for overview counts. Audit inside `AdminModule` → `VendorsModule → AdminModule → VendorsModule` cycle. A leaf `AuditModule` that both sides import has no cycle.

`AdminModule` talks to other modules only through their exported services (`VendorsService`, `OrganizersService`, `ProductsService`, `UsersService`, `OrdersService`, `BazaarsService`). It never imports a repository. (`VendorsModule`, `ProductsModule` and `BoothsModule` currently export their repositories too — don't use that.)

## 2. Schema changes (one migration)

```prisma
model Vendor {
  // …existing…
  verified        Boolean @default(false)
  rejectionReason String?        // NEW — current rejection state only, see §3
}

model Organizer {
  // …existing…
  verified        Boolean @default(false)
  rejectionReason String?        // NEW
}

enum AdminAction {
  VENDOR_VERIFIED
  VENDOR_REJECTED
  ORGANIZER_VERIFIED
  ORGANIZER_REJECTED
  PRODUCT_APPROVED
  PRODUCT_REJECTED
  USER_DEACTIVATED
  USER_REACTIVATED
}

enum AdminTargetType {
  VENDOR
  ORGANIZER
  PRODUCT
  USER
}

model AdminAuditLog {
  id         String          @id @default(uuid())
  actorId    String
  // Restrict: an audit row must outlive its actor. Users are soft-deleted in
  // production (CLAUDE.md), so this only bites hard-deletes in e2e cleanup — §9.
  actor      User            @relation(fields: [actorId], references: [id], onDelete: Restrict)
  action     AdminAction
  targetType AdminTargetType
  targetId   String
  reason     String?
  createdAt  DateTime        @default(now())

  @@index([actorId])
  @@index([targetType, targetId])
  @@index([createdAt])
  @@map("admin_audit_logs")
}

model User {
  // …existing…
  auditLogs AdminAuditLog[]
}
```

Migration name: `admin_audit_log_and_rejection_reason`. **Inspect the generated SQL for stray `DROP INDEX` on `user_location_gist`, `vendor_home_location_gist`, `bazaar_location_gist`, `event_location_gist`** — Prisma's diff can't see them; recreate in the migration if dropped.

No `targetId` FK — it points at four different tables. Existence is checked by the service that performs the action, which already 404s before recording.

## 3. Vendor / Organizer moderation state

`verified` stays the single visibility gate. `rejectionReason` distinguishes pending from rejected:

| State | `verified` | `rejectionReason` |
|---|---|---|
| pending | `false` | `null` |
| verified | `true` | `null` |
| rejected / revoked | `false` | non-null |

**`rejectionReason` is the *current* rejection state, not a history.** `verify` clears it. If someone wants "why was this vendor rejected last March", the answer is `AdminAuditLog.reason`, never the Vendor row. Do not later treat it as a permanent field.

**Transition table — idempotent, audit only on real change:**

| Current | Action | Result | Audit row | Search enqueue (vendor only) |
|---|---|---|---|---|
| pending | verify | verified | yes | yes |
| pending | reject(r) | rejected, reason = r | yes | no (`verified` unchanged) |
| verified | reject(r) | rejected (revoke), reason = r | yes | yes |
| rejected | verify | verified (re-approval), reason cleared | yes | yes |
| verified | verify | **200, unchanged** | no | no |
| rejected | reject(r2), r2 differs from r | rejected, reason **replaced** with r2 | yes | no (`verified` unchanged) |
| rejected | reject(r), same r | **200, unchanged** | no | no |

Service loads the row, computes the target `{ verified, rejectionReason }`, and if it equals the current pair returns the row as-is — no write, no audit, no enqueue. Response shape is identical either way. Repeats return 200, not 409 (Open Item 5b lists the alternative).

**Concurrency:** two admins acting on the same vendor at the same instant is a read-then-write race in the service; last write wins and both may record an audit row. State stays consistent, the log may contain two rows for one logical decision. No DB constraint expresses "only one transition per row per instant"; accepted at admin volume. Documented so nobody files it as a bug later.

**`deletedAt`:** `verify` and `reject` 404 (`VENDOR_NOT_FOUND` / `ORGANIZER_NOT_FOUND`) when `deletedAt != null`. This is a fix to today's `verifyVendor`, which doesn't check.

**Search invalidation is asymmetric — verified in code, not assumed:**
- **Vendor:** product search/public eligibility filters on `vendor.verified` (`products.repository.ts:22-31` `visibilityFilter`; `vendors.repository.ts:92-97` `findForSearch`). Any change to `verified` enqueues `{ type: 'VENDOR', id }` and `{ type: 'VENDOR_PRODUCTS', vendorId }` exactly as `verifyVendor` does today. A reason-only change (`verified` unchanged) enqueues nothing.
- **Organizer:** bazaar public and search eligibility is `status = PUBLISHED && deletedAt = null` only (`bazaars.repository.ts:344` `listPublicIds`; nothing in `infra/search/` reads `organizer.verified`). Organizer verify/reject enqueues **nothing**. Corollary: revoking a verified organizer leaves their `PUBLISHED` bazaars public and searchable — Open Item 3.

## 4. Endpoints

All under `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN)` at class level. Every write takes `@CurrentUser() admin: AuthenticatedUser` and passes `admin.id` as `actorId`; `actorId` never comes from the body.

### 4.1 Vendors — `admin-vendors.controller.ts`

| Method | Route | Body / Query | Service |
|---|---|---|---|
| `GET` | `/admin/vendors` | `?status=pending|verified|rejected&search=&page=&limit=` | `VendorsService.listForAdmin` |
| `PATCH` | `/admin/vendors/:id/verify` | — | `VendorsService.verifyVendor(adminId, id)` |
| `PATCH` | `/admin/vendors/:id/reject` | `{ reason }` | `VendorsService.rejectVendor(adminId, id, reason)` |

- `status` → `@IsOptional() @IsIn(['pending','verified','rejected'])`; maps onto the §3 pairs. Omitted = all three. `deletedAt != null` always excluded; no `includeDeleted`.
- `search` → `contains`/`insensitive` on `name` and owner `email`.
- List row: `id, ownerId, name, category, vendorType, verified, rejectionReason, subscriptionStatus, createdAt, owner: { id, name, email }`. Admin-only, so `ownerId`/email are fine here — never reuse this shape on a public route.
- `owner` comes from the same `findMany` via `include` — no N+1.
- `RejectVendorDto`: `@IsString() @MinLength(1) @MaxLength(1000) reason`.
- Verify/reject response: `{ id, verified, rejectionReason }`.
- Add `rejectionReason` to `vendorProfileSelect` (`vendors.repository.ts:6`) so `GET /vendors/me` surfaces it to the vendor dashboard, the same way product `rejectionReason` is surfaced (`web-dashboard-endpoints.md:130`). `GET /vendors/:id` (public) already 404s on unverified, so the field never leaks there.

### 4.2 Organizers — `admin-organizers.controller.ts`

Same three routes under `/admin/organizers`, backed by `OrganizersService.listForAdmin / verifyOrganizer(adminId, id) / rejectOrganizer(adminId, id, reason)`. List row: `id, ownerId, name, verified, rejectionReason, createdAt, owner: { id, name, email }`. `RejectOrganizerDto` same shape. Add `rejectionReason` to `organizerProfileSelect` (`organizers.repository.ts:6`) so `GET /organizers/me` (`organizer-bazaars.controller.ts:24`) surfaces it. No search enqueue (§3).

### 4.3 Products — `admin-products.controller.ts`

| Method | Route | Body / Query | Service |
|---|---|---|---|
| `GET` | `/admin/products` | `?approvalStatus=&vendorId=&page=&limit=` | `ProductsService.listForAdmin` |
| `PATCH` | `/admin/products/:id/approve` | — | `ProductsService.approveProduct(adminId, id)` |
| `PATCH` | `/admin/products/:id/reject` | `{ reason }` | `ProductsService.rejectProduct(adminId, id, reason)` |

- `approvalStatus` → `@IsOptional() @IsEnum(ApprovalStatus)` — exactly `PENDING | APPROVED | REJECTED`. Omitted = all three.
- `deletedAt != null` **always** excluded — a soft-deleted product is not moderatable. `isActive` is **not** filtered — an inactive `PENDING` product still needs a decision.
- **Must not** reuse `ProductsRepository.findManyPaginated` — it applies `visibilityFilter` (APPROVED + verified vendor) and would hide the queue. New `findManyForAdmin` with only `deletedAt: null` plus the optional filters, `include: { vendor: { select: { id, name, verified } } }`.
- Approve/reject idempotency mirrors §3: approve on APPROVED → 200 no-op no audit; reject with same reason on REJECTED → no-op; reject with a different reason → replace + audit. Approve/reject on a product whose `deletedAt != null` → 404 `PRODUCT_NOT_FOUND` (today `updateAdminStatus` will happily update a deleted row — fix).
- Existing search enqueue on approve/reject stays; skip it on a no-op.

### 4.4 Users — `admin-users.controller.ts`

No new routes. `deactivateUser(adminId, targetId)` already takes `adminId`; `reactivateUser` gains it. Both record an audit row (`USER_DEACTIVATED` / `USER_REACTIVATED`, `targetType: USER`). Deactivating an already-deactivated user or reactivating an active one is a no-op with no audit (today's `softDelete`/`reactivate` overwrite blindly — check `deletedAt` first).

### 4.5 Overview — `admin-overview.controller.ts`

`GET /admin/overview` →

```json
{
  "pending":   { "vendors": 3, "organizers": 1, "products": 12 },
  "users":     { "SHOPPER": 120, "VENDOR": 14, "ORGANIZER": 5, "ADMIN": 1 },
  "orders":    { "PENDING": 2, "PAID": 7, "FULFILLED": 1, "SHIPPED": 0, "DELIVERED": 30, "CANCELLED": 3 },
  "bazaars":   { "DRAFT": 2, "PUBLISHED": 4, "CANCELLED": 0, "COMPLETED": 9 }
}
```

**Exactly six queries, fixed regardless of enum size:**

| Block | Repository method (new) | Prisma |
|---|---|---|
| `pending.vendors` | `VendorsRepository.countPendingForAdmin()` | `count({ where: { verified: false, rejectionReason: null, deletedAt: null } })` |
| `pending.organizers` | `OrganizersRepository.countPendingForAdmin()` | same |
| `pending.products` | `ProductsRepository.countPendingForAdmin()` | `count({ where: { approvalStatus: 'PENDING', deletedAt: null } })` |
| `users` | `UsersRepository.groupByRole()` | `groupBy({ by: ['role'], _count: { _all: true }, where: { deletedAt: null } })` |
| `orders` | `OrdersRepository.groupByStatus()` | `groupBy({ by: ['status'], _count: { _all: true } })` |
| `bazaars` | `BazaarsRepository.groupByStatus()` | `groupBy({ by: ['status'], _count: { _all: true }, where: { deletedAt: null } })` |

Each is exposed through that module's public service (`VendorsService.countPendingForAdmin()`, `UsersService.countByRole()`, …). `AdminOverviewService` runs the six with `Promise.all`, then maps each `groupBy` result onto the full enum (`Object.values(Role)`, `Object.values(OrderStatus)`, `Object.values(BazaarStatus)`) so absent statuses come back as `0`, never as missing keys. **Never** one `count()` per enum value.

`Order` has no `deletedAt`; orders count as-is.

### 4.6 Audit log — `admin-audit-log.controller.ts`

`GET /admin/audit-log?actorId=&targetType=&targetId=&action=&page=&limit=`

- `actorId`, `targetId` → `@IsOptional() @IsUUID()`; `targetType` → `@IsEnum(AdminTargetType)`; `action` → `@IsEnum(AdminAction)`; `page`/`limit` as `AdminListUsersQueryDto` (`limit` max 100).
- Newest first. Row: `id, action, targetType, targetId, reason, createdAt, actor: { id, name, email }` — `actor` via `include` in the same query.
- Response `{ data, meta: { total, page, limit, totalPages } }`.

## 5. Audit semantics

### 5.1 Write timing

Verify + audit is a two-table write. The audit row is written **after** the domain write returns, **outside** its transaction — the same posture as the search-index enqueue that already follows every moderation write. This is a deliberate deviation from CLAUDE.md's "any write touching more than one table goes in a `$transaction`":

- the audit row is a derived log, not a source of truth;
- the alternative — a domain repository inserting into `admin_audit_logs` — violates "never reach into another module's repository";
- the codebase has no domain-event bus to hang a post-commit listener on (known deviation).

### 5.2 Failure semantics — best-effort with loud failure

> **Rule:** an audit-write failure never rolls back and never makes the successful moderation operation look unsuccessful. `AuditService.record()` catches its own errors, logs them at `error` level via Nest `Logger` with the full entry (`actorId`, `action`, `targetType`, `targetId`, `reason`), and resolves. The HTTP response reflects the domain write only.

So `verify succeeds → audit INSERT fails` returns **200 with the verified vendor** plus one error log line carrying enough to reconstruct the row by hand. If a *guaranteed* trail is required (compliance, disputes), that is an outbox/transactional design and a different spec — Open Item 5, and the first thing Ibrahim should answer.

### 5.3 Invariants the DB does not enforce (documented, owned by the app layer)

- **Every `actorId` is an existing `User` with `role = ADMIN`.** The FK guarantees existence. The `ADMIN` part is guaranteed only by `JwtAuthGuard + RolesGuard` on every `/admin/*` controller and by `actorId` always coming from `@CurrentUser()`. No `CHECK` constraint can express a cross-row role condition.
- **Adding a new auditable admin action = add an `AdminAction` value (migration) + call `auditService.record()` in that service method.** There is no reflection or decorator magic. A new admin endpoint with no hook is silently un-audited. This sentence goes into `CLAUDE.md` (§10, Task 8).

### 5.4 `AuditService` contract

```ts
record(entry: {
  actorId: string;
  action: AdminAction;
  targetType: AdminTargetType;
  targetId: string;
  reason?: string | null;
}): Promise<void>;                    // never rejects — §5.2

list(query: {
  actorId?: string; targetType?: AdminTargetType; targetId?: string; action?: AdminAction;
  page: number; limit: number;
}): Promise<{ data: AuditLogRow[]; meta: PageMeta }>;
```

## 6. Errors

Coded form throughout new/changed code (`AllExceptionsFilter` emits `code`):

| Code | HTTP | When |
|---|---|---|
| `VENDOR_NOT_FOUND` | 404 | vendor missing or `deletedAt != null` |
| `ORGANIZER_NOT_FOUND` | 404 | same for organizer |
| `PRODUCT_NOT_FOUND` | 404 | same for product |
| `USER_NOT_FOUND` | 404 | existing |
| `CANNOT_DEACTIVATE_SELF` | 400 | existing |

Validation failures come from the global pipe (`whitelist: true, forbidNonWhitelisted: true`). Non-admin → 403 from `RolesGuard`; unauthenticated → 401 from `JwtAuthGuard` — both already behave this way, the e2e just asserts them.

## 7. Tasks — one reviewed unit each, staged diffs (repository/service → controllers/DTOs → tests)

| # | Task | Touches |
|---|---|---|
| 0 | This spec, reviewed | `specs/admin-module-spec.md` |
| 1 | Schema + migration + e2e cleanup order (§2, §9) | `schema.prisma`, `prisma/migrations/*`, every `*.e2e.spec.ts` with `user.deleteMany` |
| 2 | `modules/audit/` (§5) | new module, `app.module.ts` |
| 3 | Vendor moderation (§3, §4.1) | `vendors/*` |
| 4 | Organizer moderation (§3, §4.2) | `bazaars/organizers.*`, `admin-organizers.controller.ts` |
| 5 | Product moderation (§4.3) | `products/*` |
| 6 | Users audit (§4.4) | `users/*` |
| 7 | `modules/admin/` overview + audit-log read (§4.5, §4.6) | new module, count methods in 5 repositories/services |
| 8 | Docs | `CLAUDE.md`, `specs/web-dashboard-endpoints.md` "Admin dashboard" section |

Claude does not run `git commit` or `git push`; each task ends with the diff and a proposed `feat(admin): …` / `feat(audit): …` message.

## 8. Verification — real output, per task

- **Task 1:** migration SQL (checked for GIST `DROP INDEX`), `prisma generate` output, `pnpm typecheck`, and a **full** `pnpm --filter @riven/api test` — cleanup order is exactly what this task can break. Reminder: `test` wipes the dev DB (Postgres on :5433).
- **Task 2:** unit spec — `record()` resolves when the repository throws and `Logger.error` was called with the entry.
- **Tasks 3–6:** unit specs cover every row of the transition table (including the two no-op rows: no repository write, no `record`, no enqueue). E2e per module: queue lists the pending row; reject sets reason, `GET /vendors/me` shows it, `GET /products` drops that vendor's products; verify clears it; audit rows exist for real transitions only (repeat the same reject → count unchanged).
- **Task 7:** `admin.e2e.spec.ts` — overview matches seeded rows and contains **every** enum key; audit-log lists rows written by Tasks 3–6 with `actor.email`; 403 for a `VENDOR` token; 401 with no token. Prisma query logging for one `GET /admin/overview` showing exactly six statements.
- **Manual curl** against `start:dev` with an admin JWT (mint with `JwtService.signAsync({ sub, role: 'ADMIN' })` as the e2e specs do, or a hand-inserted admin — bootstrap is Open Item 1): `GET /admin/vendors?status=pending` → `PATCH …/reject` → `GET /vendors/me` as that vendor shows `rejectionReason` → `GET /products` no longer lists their products → `GET /admin/audit-log` shows the row → same `reject` again → audit count unchanged → `GET /admin/overview` counts move.
- **Audit-failure path:** unit test only. Not reproduced over HTTP — no clean way to make one INSERT fail against a live DB without breaking the rest of the run.

## 9. E2E cleanup order (consequence of `onDelete: Restrict`)

Any e2e cleanup that hard-deletes users fails once an audit row exists. Grep at spec time (`prisma\.user\.deleteMany` under `apps/api`; there is no `apps/api/test/` directory) found **13 call sites in 8 files**: `vendors` ×2, `social`, `search`, `media` ×2 (filtered `where: { email: { startsWith: 'media-' } }`), `discovery` ×2, `checkout` ×2, `booths`, `bazaars` ×2. Task 1 **re-runs the grep and patches every hit**, not this list. Each hit gets `await prisma.adminAuditLog.deleteMany();` immediately before it — the filtered `media` ones too; cheaper than reasoning about whether a media test user could ever be an actor.

## 10. Docs to update (Task 8)

- `CLAUDE.md`: merged-module list gains `admin`, `audit`; "Module conventions" gains: *"A new admin action is audited only if you add an `AdminAction` value and call `auditService.record()`. Audit is best-effort — failures log and never fail the request."*
- `specs/web-dashboard-endpoints.md`: new "Admin dashboard" section listing every `/admin/*` route (including the six pre-existing controllers).

---

## Open Items (for Ibrahim — not resolved here)

1. **Admin bootstrap.** How does the first `ADMIN` user come to exist? Registration rejects `ADMIN`; `prisma/seed.ts` seeds categories only. Today: manual DB insert. Proposal: `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `env.validation.ts`, idempotent upsert in `seed.ts` (~30 lines). Deferred from this pass by the user; **recommend pulling it in as Task 9** — every manual verification step in §8 otherwise depends on a hand-inserted row, and the feature ships unusable without one.
2. **Does editing a rejected vendor/organizer profile clear `rejectionReason` (re-apply)?** Products reset to `PENDING` on edit. Proposed default for vendors/organizers: **no** — only an admin `verify` clears it.
3. **Revoking a verified organizer.** Neither bazaar public visibility nor search eligibility filters on `organizer.verified` (§3); verification only gates *creating* bazaars. A revoked organizer's `PUBLISHED` bazaars stay public and searchable. Intentional, or should revoke also un-publish (a second, bigger change)?
4. **Should booth-layout admin ops and `POST /admin/search/reindex` be audited?** Left out of `AdminAction` for now; each is one enum value + one hook later.
5. **Audit is best-effort, not mandatory** (§5.2). If a guaranteed trail is a requirement, that needs an outbox/transactional design and its own spec. **Answer this one first** — it changes Task 2 before any code is written.
   - **5b. Idempotency choice** (§3): repeats are 200 no-ops with no audit row; `reject` with a *different* reason on a rejected account replaces and audits. Alternative is 409 on repeats — one line in the service.
6. **`deactivateUser` still does not revoke refresh tokens** (`users.service.ts:174`). Still a fast-follow, not in this pass.
7. **Rate limiting on `/admin/*`.** None today, same as every other endpoint. Out of scope; noting it because CLAUDE.md lists silent 429s under "don't repeat".
