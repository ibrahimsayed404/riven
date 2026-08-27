# Bazaars Module Spec

**Status:** Draft for review
**Scope:** Organizer application (admin-approved, not direct signup), Bazaar CRUD, vendor application/acceptance flow for bazaars (via `BoothListing`).
**Depends on:** `User`, `Organizer`, `Bazaar`, `BoothListing`, `Vendor` (all already migrated).
**Out of scope (this pass):** Booth layout/grid system (`BoothLayout`, `Booth` — the isometric grid positioning) is a separate follow-up module. This pass only tracks *that* a vendor is accepted into a bazaar (`BoothListing`), not *where* their physical booth sits.

---

## 1. Organizer Application (Admin-Approved)

Unlike Vendor's direct signup, Organizer requires admin approval before the account can create Bazaars — reflecting the higher trust/liability of running a public event that vendors pay to join.

**Endpoint:** `POST /auth/register/organizer`
- Creates `User` (role=ORGANIZER) + `Organizer` (verified: false — reusing the same boolean pattern as Vendor) in one transaction, same as Vendor registration.
- Returns tokens immediately (organizer can log in right away and see their own dashboard, just can't create Bazaars yet) — matches the pattern of "you have an account, but a specific capability is gated," consistent with how Vendor's `verified` gate works for product creation.
- Request body: `{ email, password, name, organizationName }` — `Organizer.name` field only (schema doesn't have the richer storefront fields Vendor has — brandStory etc. — since Organizer is a simpler entity in the current schema).

**Admin approval:** `PATCH /admin/organizers/:id/verify` — `@Roles(Role.ADMIN)`, sets `Organizer.verified: true`. Mirrors the existing `PATCH /admin/vendors/:id/verify` pattern exactly.

## 2. Bazaar CRUD

**Endpoints (Organizer-facing):**
- `GET /organizers/me` — own organizer profile.
- `PATCH /organizers/me` — update `name` only for now (schema is minimal — just `name`, `verified`, timestamps).
- `GET /organizers/me/bazaars` — own bazaars, all statuses, paginated.
- `POST /organizers/me/bazaars` — create a Bazaar. **Requires `organizer.verified === true`** — same verified-gate pattern as Vendor's product creation. Starts `status: DRAFT` (schema default).
  - Body: `name, description?, coverMedia?, location (lat/lng), scheduleType (ONE_OFF | RECURRING), recurrenceRule? (required if RECURRING), startDate, endDate?`.
  - `location` write uses the same `ST_SetSRID(...)::geography` raw SQL pattern already established in Users/Vendors — reuse, don't reinvent.
- `GET /organizers/me/bazaars/:id` — single, own only.
- `PATCH /organizers/me/bazaars/:id` — update any of the above fields. Does NOT reset `status` (unlike Product's approval-reset-on-edit — Bazaar status is a manually-managed lifecycle the organizer controls directly, not an approval workflow with admin review, so there's no equivalent "reset" concept here. Confirm this asymmetry is intentional — see Open Items).
- `PATCH /organizers/me/bazaars/:id/publish` — transitions DRAFT → PUBLISHED. Only valid from DRAFT.
- `PATCH /organizers/me/bazaars/:id/cancel` — transitions to CANCELLED. Valid from DRAFT or PUBLISHED, not from COMPLETED.
- No explicit "complete" transition triggered by an API call. **Bazaars auto-transition PUBLISHED → COMPLETED via a scheduled job** comparing `endDate` to the current time (for `ONE_OFF` bazaars) or the end of the current occurrence (for `RECURRING` — see note below). This is the first scheduled/cron job in the codebase — use BullMQ's repeatable job pattern (already in the stack per the infra setup) rather than a raw `setInterval` or external cron, for consistency with how the rest of the backend is expected to handle background work.
  - Run on a reasonable interval (e.g. every 15 minutes) — check for `PUBLISHED` bazaars where `endDate < now()` (or `startDate < now()` if `endDate` is null, treating it as a single-day event) and transition them to `COMPLETED`.
  - **`RECURRING` bazaars are more complex** — `recurrenceRule` (an iCal RRULE string per the schema comment) implies the bazaar recurs rather than having one fixed end. Since this pass doesn't have a recurrence-expansion library wired in, flag this as a known simplification: recurring bazaars are NOT auto-completed by this job in this pass (only `ONE_OFF` bazaars are) — completing a recurring bazaar needs either a manual organizer action (not built yet) or a proper RRULE-aware job (bigger scope). Confirm this simplification is acceptable, or flag it as an open item if recurring bazaars matter for an early launch.

**Public Bazaar browsing (Shopper-facing):**
- `GET /bazaars` — public, only `status: PUBLISHED`, `deletedAt: null`. Filterable by proximity (lat/lng + radius, using the existing GIST index on `Bazaar.location` — `ST_DWithin` query) and by `scheduleType`. Paginated.
- `GET /bazaars/:id` — public single bazaar detail, same visibility filter. **Only includes ACCEPTED vendors** (via `BoothListing` where `applicationStatus: ACCEPTED`) — PENDING/REJECTED applications are never exposed publicly, only visible to the organizer and the applying vendor themselves.

## 3. Vendor Applications to Bazaars

This is the `BoothListing` model — tracks a vendor applying to participate in a bazaar, independent of booth physical placement (that's the deferred follow-up module).

**Vendor-facing:**
- `POST /bazaars/:id/apply` — `@Roles(Role.VENDOR)`. Creates a `BoothListing` with `applicationStatus: PENDING`. Requires the calling vendor to be `verified` (reuse the same gate as product creation — an unverified vendor shouldn't be applying to bazaars either). Reject if the bazaar isn't `PUBLISHED` (can't apply to a draft or cancelled bazaar) — schema already has a unique constraint on `(bazaarId, vendorId)` preventing duplicate applications, surface that as a clean 409 rather than a raw Prisma error.
- `GET /vendors/me/bazaar-applications` — vendor's own applications across all bazaars, paginated, filterable by `applicationStatus`.
- `DELETE /bazaars/:id/apply` — vendor withdraws a PENDING application. Reject if already ACCEPTED/REJECTED (can't withdraw after a decision — that needs organizer/admin involvement, not a vendor self-service action).

**Organizer-facing:**
- `GET /organizers/me/bazaars/:id/applications` — list applications for one of the organizer's own bazaars, filterable by `applicationStatus`.
- `PATCH /organizers/me/bazaars/:id/applications/:applicationId/accept` — sets `applicationStatus: ACCEPTED`, `decidedAt: now()`. Only valid from PENDING.
- `PATCH /organizers/me/bazaars/:id/applications/:applicationId/reject` — sets `applicationStatus: REJECTED`, `decidedAt: now()`. Only valid from PENDING.

## 4. Response Shapes

- Bazaar public response: `id, name, description, coverMedia, location, scheduleType, startDate, endDate, status, acceptedVendors: [{ vendorId, businessName, logo }]`.
- Reuse the location `{ lat, lng }` shape and raw-SQL read pattern already established for User/Vendor.

## 5. Open Items For Discussion

1. **Recurring bazaars are not auto-completed** in this pass (see Section 2) — only `ONE_OFF` bazaars get the scheduled-job treatment. Confirm this simplification is acceptable for now.
2. **Editing a PUBLISHED bazaar doesn't reset it to DRAFT or require re-review** — unlike Product's approval-reset pattern. This seems right since there's no separate admin-approval step for bazaars in the current spec (only organizer-verification at the account level), but flag if you actually want bazaar-level admin review too, which would be a bigger addition.
