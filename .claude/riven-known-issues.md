# Riven — Known Issues & Spec Conflicts

Verified against the repo on 2026-08-31. None of these are hidden bugs — they are places where the code, the specs, and the handoff plan disagree with each other. Confirm current state before acting on any of them.

## Code deviating from `specs/riven-backend-architecture.md`

1. **No stable error codes.** §4 requires custom exception classes in `common/exceptions/` carrying codes like `RESOURCE_NOT_FOUND`. That directory doesn't exist; most services throw bare-string exceptions (`new NotFoundException('Bazaar not found.')`), which `AllExceptionsFilter` reports as `code: "HTTP_ERROR"`. Only `VALIDATION_ERROR`, `INVALID_ACCESS_TOKEN`, `CHECKOUT_ITEM_UNAVAILABLE` and `INTERNAL_SERVER_ERROR` are real codes today. Clients can't branch on failure type — this will bite when the mobile app lands.

2. **Booth layout is admin-only, with no ownership check.** All eight layout/booth routes sit on `admin-booths.controller.ts` under `@Roles(Role.ADMIN)` at `/admin/bazaars/:bazaarId/layout` and `/admin/booths/:id`, and `BoothsService` never verifies who owns the bazaar. But `api-contract.md`, `bazaars-module-spec.md` §2–3, and `riven-spec.md` §5 all specify `PUT /bazaars/:id/layout`, ORGANIZER **owner-only**, idempotent full replace. **As merged, an organizer cannot lay out their own bazaar** — a core product function. `bazaars-module-spec.md` §2 already contains the full correct design, including a `CANNOT_MODIFY_LAYOUT_WITH_ASSIGNED_BOOTHS` guard and atomic `updateMany`-based assignment. No new spec needed, only implementation. The booths module also shipped without its own spec file.

3. **Checkout breaks the module-boundary rules.** `checkout.service.ts` injects `PrismaService` and queries directly — the only service without a repository — and imports `ProductsRepository` across a module line. `cart.repository.ts` imports `ProductsRepository` too, and `paymob-webhook.controller.ts` runs raw Prisma **in a controller**.

4. **Access tokens aren't stateless.** `auth-module-spec.md` says the JWT is validated without touching the DB; `jwt.strategy.ts` calls `findAuthenticatedUserById()` on every authenticated request. The same spec requires `RolesGuard` to 403 with `code: 'FORBIDDEN_ROLE'`; it just returns `false`, producing Nest's generic error.

5. **`env.validation.ts` omits `PAYMOB_*` and `S3_*`.** Architecture §5 names `PAYMOB_API_KEY` as its own example of a boot-time check. Instead `PaymobService` defaults them to `''` and throws a 500 at request time.

6. **No domain events.** §1 prescribes event-based cross-module communication; there is no emitter and no `events/` directory. The notifications module spec depends on `bazaar.published` and `booth_listing.accepted` events that don't exist yet.

7. Minor: no `entities/` response-shape directories; no `transform.interceptor.ts`, so success responses aren't wrapped in a `{ success: true }` envelope though errors are; `console.error` used instead of Nest's `Logger` in checkout and Paymob code; `apps/api/cart_error.json` is a stray debug artifact that should be deleted.

## Specs that conflict with each other or with the live schema

1. **Two Paymob integrations are planned.** `payments-module-spec.md` specifies `POST /payments/webhook/paymob` with its own HMAC verifier, while the merged checkout module already owns `POST /webhooks/paymob` with one. That spec also restates the outdated "no in-app checkout for products" rule. Needs a decision before payments work starts.

2. **`discovery-module-spec.md` won't compile against the live schema.** It filters `scheduleType` on `ONE_OFF | RECURRING_WEEKLY | RECURRING_MONTHLY`; the live enum is `ONE_OFF | RECURRING`. It also cites GIST indexes as `idx_bazaars_location` / `idx_vendors_home_location`; the real names are `bazaar_location_gist` / `vendor_home_location_gist`.

3. **`riven-mobile-design-spec.md` describes an app that doesn't exist.** It opens as "a styling pass on existing, working screens" and references `@riven/ui-tokens`, `@riven/map-core`, and six `app/` screens — none of which exist. It also names different screens than `mobile-architecture.md` (`explore`/`favorites` vs `discover`/`following`). Its palette and type scale are real and approved, though: Deep Indigo `#1E2A44`, Soft Cream `#F8F6F2`, Warm Coral `#FF6B5E`, Charcoal `#2A2A2A`; Plus Jakarta Sans headings, Manrope body. Those values still need to land in `assets/brand/` and eventually `@riven/ui-tokens`.

4. **`specs/schema.prisma` has drifted** from `apps/api/prisma/schema.prisma`, which is the source of truth. `specs/.env.example` likewise duplicates the root `.env.example`.

## Corrections to the Backend Handoff Plan

The plan is a useful priority ordering but is out of date in five ways:

1. **Priority 1's blocking issue is already fixed and merged.** `BoothsService` depends on `BazaarsService`, not `BazaarsRepository` — zero references to the latter exist in the booths module, and `BoothsModule` imports `BazaarsModule`. Booth Layout is merged (`9dc7525` + `91d1cc5`), not in progress. Re-point Priority 1 at the real boundary violations in checkout/cart (item 3 above) and at the organizer-ownership problem (item 2 above).
2. **Priority 1 treats the admin-only booth design as intended.** It isn't — see item 2 above.
3. **Four specs it says need writing already exist**: `discovery-module-spec.md` (119 lines), `notifications-module-spec.md` (211, marked FINALIZED), `social-module-spec.md` (302), `fashion-marketplace-addendum.md` (236). Priority 5 is doubly stale — that addendum is already implemented and migrated.
4. **The payments module is absent from the plan entirely**, though the plan's own "Business model" line names both revenue streams. Neither exists in code.
5. **The CI description is optimistic** — see the CI note in `.claude/riven-architecture.md`.
