# Riven — Build State

**Verified against the repo on 2026-08-31** (25 commits, all on `main`). Re-check against `git log` and `apps/api/src/modules/` before relying on it.

## Apps and packages

Only `apps/api` exists. `packages/` is **empty** despite the README listing `types`, `ui-tokens`, `map-core`. There is no `apps/mobile`, no consumer web, no vendor/organizer portal. `assets/` contains only a placeholder `brand/README.md` and an `images/.gitkeep` — no logo or brand files have ever been committed.

## API modules — merged

| Module | Surface |
|---|---|
| **auth** | register (shopper / vendor / organizer), login, refresh-token rotation with reuse detection, logout, `GET /auth/me`. Exports `JwtAuthGuard`, `RolesGuard`, `@Roles()`, `@CurrentUser()`. bcrypt at 12 rounds. |
| **users** | `GET/PATCH /users/me`, `PATCH /users/me/location` (PostGIS), soft-delete `DELETE /users/me`; `admin/users` list / detail / deactivate / reactivate |
| **vendors** | vendor registration, storefront profile, location, public `GET /vendors/:id`, full product + variant CRUD under `/vendors/me/products`, `PATCH /admin/vendors/:id/verify` |
| **products** | public `GET /products`, `GET /products/:id` behind a shared visibility filter; admin approve / reject with reason |
| **cart** | shopper-only cart with lazy creation, `quantity: 0` removes |
| **checkout** | `POST /checkout` — Serializable transaction, per-vendor order split, price snapshots, stock decrement, cart clear, then Paymob intent outside the transaction; retry-payment; `POST /webhooks/paymob` with HMAC verification |
| **orders** | shopper list / detail / cancel / confirm-delivery; `vendors/me/orders` with forward-only status transitions |
| **bazaars** | organizer registration (admin-approved), bazaar CRUD, publish / cancel, vendor applications with accept/reject, BullMQ auto-complete job |
| **booths** | booth layout + booth CRUD, assign / unassign a `BoothListing` to a booth |

Roughly 74 endpoints across 19 controllers, ~7,600 lines of TypeScript, 18 spec files (13 unit + 5 e2e).

## Specced but not built

| Module | Spec | Notes |
|---|---|---|
| **payments** | `specs/payments-module-spec.md` | Organizer listing fees + vendor subscriptions. **Not in any current plan.** `publishBazaar()` currently goes DRAFT → PUBLISHED with no payment gate, though `api-contract.md` requires payment first. No `Subscription` code exists. Both revenue lines are unbuilt. |
| **discovery** | `specs/discovery-module-spec.md` | PostGIS proximity feed, keyset pagination |
| **social** | `specs/social-module-spec.md` | Follow / favorite / rating. Needs an `OptionalJwtAuthGuard` added to the auth module first. |
| **notifications** | `specs/notifications-module-spec.md` | 3 triggers, idempotency keys, EventEmitter2 + hourly cron. The `Notification.idempotencyKey` column it needs is already migrated. |
| **search** | — | Meilisearch sync via queue. No spec, no stub. |
| **media** | — | S3 signed upload URLs. No spec. |
| **admin** | — | Consolidating the approval flows that currently live in each module. |
| **events** | — | The standalone `Event` model is migrated but has no module. |

## Blocked

- **Paymob sandbox credentials** — blocks webhook ID-matching verification (the highest-risk unverified assumption in the codebase, marked at `modules/checkout/paymob-webhook.controller.ts` lines 33–48) and all end-to-end payment testing.
- **S3 / storage decision** (MinIO locally vs real S3/R2) — blocks avatar upload and product image upload.
- **RRULE library choice** — blocks recurring bazaar support. `ScheduleType` currently has `ONE_OFF | RECURRING` and `Bazaar.recurrenceRule` exists, but only one-off is handled.

## Never done

The isometric map spike (`specs/map-spike-brief.md`) — a throwaway prototype that was meant to prove the shared `gridToScreen` math across SVG and `react-native-svg` **before** any real booth editor or map screen is built. `specs/riven-mobile-design-spec.md` assumes it landed and that `@riven/map-core` exists; it doesn't.
