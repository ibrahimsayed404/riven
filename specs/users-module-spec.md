# Users Module Spec

**Status:** Draft for review
**Scope:** Profile management, admin user management. Builds on the existing Auth module (registration/login/tokens already implemented) and the `User` model already in the live schema.
**Out of scope (this pass):** Avatar upload — deferred until S3-compatible storage (MinIO for local dev, or real S3/R2 credentials) is decided and set up. Vendor/Organizer profile fields (handled in their own modules), Follow/Favorite/Rating (Social module), Notifications module.

---

## 1. Profile CRUD

Fields already on `User`: `name`, `email`, `phone`, `interests` (string array), `location` (PostGIS geography point). `email` is immutable post-registration (used for login + enumeration-proof auth) — changing it needs a separate verified-email-change flow, not in scope here.

**Location semantics: auto-updated from device GPS**, not a manually-set profile field. This means:
- A separate lightweight endpoint, not bundled into general profile edits, since it's called frequently (e.g. on app foreground / periodic background ping) and shouldn't require sending the full profile payload each time.
- `PATCH /users/me/location` — body: `{ lat, lng }` only. High-frequency endpoint, keep it cheap (no heavy validation beyond lat/lng range checks, no audit logging of every ping).
- Rate-limit this endpoint specifically (e.g. max 1 update per N seconds per user) to prevent abuse/battery-drain-driven spam — flag for implementation, exact threshold TBD.
- Client controls the update cadence (out of scope for backend — mobile app decides how often to ping).

**Endpoints:**
- `GET /users/me` — returns own profile (already partially covered by `/auth/me`; this extends it with `interests`, `location`, `phone`)
- `PATCH /users/me` — update own `name`, `phone`, `interests` only (NOT `location` — see dedicated endpoint above). All fields optional in the DTO (partial update). `email` and `role` are rejected if present in the body (400, not silently ignored — the person should know their edit was rejected).
- `PATCH /users/me/location` — see above.
- `DELETE /users/me` — soft-delete own account (`deletedAt` set, not a hard delete — table already has `deletedAt`). Requires password re-confirmation in the request body (prevents accidental/hijacked deletion via a stolen access token alone).

**Validation:**
- `phone`: Egyptian phone format validation (`+20` or `01` prefix, standard mobile lengths). Reuse or extend whatever validator pattern the Auth module already uses for consistency.
- `location`: valid lat/lng pair, converted to PostGIS `geography(Point,4326)` on write.
- `interests`: array of strings, cap at a reasonable max (e.g. 20) to prevent abuse.

## 2. Avatar Upload — DEFERRED

Not built in this pass. Needs a decision first: MinIO in Docker Compose for local dev, or real S3/R2 credentials. Schema will eventually need `User.avatarUrl String?` added. Revisit as a small follow-up module once storage is decided.

## 3. Admin User Management

Admin-only (`@Roles(Role.ADMIN)`), consistent with existing `RolesGuard` pattern from Auth module.

**Endpoints:**
- `GET /admin/users` — paginated list, filterable by `role`, searchable by `name`/`email`/`phone`. Excludes soft-deleted users by default; add `?includeDeleted=true` to include them.
- `GET /admin/users/:id` — full profile detail for one user (admin view — may include fields not exposed on the public profile endpoint later, but for now same shape as `GET /users/me`).
- `PATCH /admin/users/:id/deactivate` — soft-delete a user (sets `deletedAt`). Does NOT delete related records (Vendor, Orders, etc. stay intact per existing Restrict/Cascade rules already in the schema).
- `PATCH /admin/users/:id/reactivate` — clears `deletedAt`.

**Guardrails:**
- Admin cannot deactivate their own account through this endpoint (prevents accidental lockout) — reject with a clear error.
- Deactivating a user should NOT auto-revoke their refresh tokens in this pass (out of scope) — flag as a known gap, not silently handled. A deactivated user could theoretically still use an existing valid access token until it expires (15m TTL per `.env.example`, so blast radius is small). Full session-kill on deactivate can be a fast-follow if needed.

## 4. Response Shape

Standard profile response (used by `/users/me` and admin detail endpoint):

```
{
  id, name, email, phone, role,
  interests, location: { lat, lng } | null,
  createdAt, updatedAt
}
```

Never return `passwordHash` — confirm the Prisma select/serialization excludes it explicitly (don't rely on DTO mapping alone catching this).

## 5. Open Items

1. Rate limit threshold for `PATCH /users/me/location` — needs a concrete number before/during implementation (suggest starting at 1 update per 60s per user, adjustable).
2. Avatar storage decision (MinIO vs real S3/R2) — needed before the deferred avatar module can start.
