# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What Riven is

A discovery platform connecting shoppers, local brands/vendors, and bazaar/event organizers across Egypt — with a fashion marketplace layer on top. Two product surfaces share one codebase:

1. **Discovery / bazaars** — organizers create bazaars, build an isometric booth layout, accept vendor applications. Shoppers browse, follow, favorite, rate. Monetized by organizer listing fees and vendor subscriptions.
2. **Fashion marketplace** — vendors sell directly: catalog with variants, multi-vendor cart, per-vendor sub-orders, Paymob payment.

`Vendor.vendorType` (`BAZAAR_ONLY` / `MARKETPLACE` / `BOTH`) separates them.

> **When reading specs:** `specs/riven-spec.md` §1 still says "Not e-commerce — no cart, no checkout for products." That was overridden by `specs/fashion-marketplace-addendum.md` and is contradicted by merged code. `specs/payments-module-spec.md` §1 repeats the outdated claim. Treat `riven-spec.md` as the base vision and the addendum as authoritative where they conflict.

Four roles, one per account, no multi-role: `SHOPPER`, `VENDOR`, `ORGANIZER`, `ADMIN`. `role` is set at registration and immutable; public registration must reject `role: ADMIN` **in the service layer**, not just the DTO enum. Approval-gated visibility is platform-wide — vendors, organizers and products are invisible to shoppers until an admin approves, and editing a product resets it to `PENDING`.

Ibrahim is the product decision-maker. Each module spec ends with an "Open Items" list — those go back to him rather than being resolved unilaterally.

## Repo layout

pnpm monorepo + Turborepo. **Only `apps/api` exists** (NestJS + Prisma + PostgreSQL/PostGIS); `packages/` is empty and there is no mobile, web, or portal app yet despite the README listing them.

```
apps/api/src/
  main.ts, app.module.ts
  common/{filters,validators}/
  infra/{prisma,config,queue,paymob}/
  modules/{auth,users,vendors,products,cart,checkout,orders,bazaars,booths}/
```

Merged modules: auth, users, vendors, products, cart, checkout, orders, bazaars, booths, discovery, social, search, categories, media, audit, admin. Specced but not built: payments, notifications. No spec yet: events.

`modules/admin/` is cross-cutting only (`GET /admin/overview`, `GET /admin/audit-log`); approval endpoints stay in their domain modules (`admin-vendors.controller.ts`, …). `modules/audit/` is a leaf module every domain module may import to write audit rows — keeping it out of `admin/` avoids a Vendors → Admin → Vendors cycle. See `specs/admin-module-spec.md`.

## Read before starting work

`WORKFLOW.md` — the development cycle. `CONTRIBUTING.md` — branches and commits. `specs/STARTING_PROMPT.md` — the required spec reading order. `specs/riven-backend-architecture.md` — full engineering standards.

## Architecture non-negotiables

- **Every Prisma call lives in that module's `*.repository.ts`** — never in a service or controller.
- **Never reach into another module's repository.** Go through its public service. Cross-module *constants* (e.g. `products/product-visibility.ts`) are fine; repository classes are not, and modules no longer export them.
- **Explicit `onDelete` on every foreign key.** No unset defaults.
- **Any write touching more than one table goes in a `$transaction`.** Events fire after it commits, never inside.
- **Soft-delete** (`deletedAt`) anything a Rating, Follow, or order history points at. Never hard-delete.
- **Constraints in the schema**, not just service-layer `if` checks — an app check races, a DB constraint doesn't.
- **Every DTO uses `class-validator`**; the global pipe runs `whitelist: true, forbidNonWhitelisted: true`.
- **Owner-scoped routes check ownership in the service**, not just `@Roles()` — the role alone lets any organizer touch any bazaar.
- **Prisma stays on 6.x.** Do not upgrade to 7 (breaking schema-format changes).

### Errors

Throw with an object payload so `AllExceptionsFilter` emits a stable code:

```ts
throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
```

A bare string (`new NotFoundException('Bazaar not found.')`) falls back to `code: "HTTP_ERROR"` and clients can't branch on it. Much of the existing code does this; prefer the coded form in new work.

### PostGIS

Location columns are `Unsupported("geography(Point, 4326)")` — Prisma Client cannot read or write them. Use `$queryRaw` / `$executeRaw` **in the repository layer**:

```sql
ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})
```

GIST index names: `user_location_gist`, `vendor_home_location_gist`, `bazaar_location_gist`, `event_location_gist`. **Check every new migration for stray `DROP INDEX` on these** — Prisma's diffing can't see them; recreate manually in the migration SQL if dropped.

### Module conventions

Controllers are split by audience, not merged: `public-bazaars.controller.ts`, `organizer-bazaars.controller.ts`, `admin-organizers.controller.ts`, `vendor-orders.controller.ts`. Guards go at class level when the whole controller shares a role:

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR)
@Controller('vendors/me/orders')
```

**Domain events** (`common/events/`): emit `new SomeEvent(...)` through `DomainEvents.emit()` *after* the write commits, never inside a transaction; listeners use `@OnEvent(SomeEvent.NAME)` and are best-effort (`ignoreErrors`). Event classes live in the owning module's `events/` folder (`bazaars/events/bazaar-published.event.ts`, `booth-listing-accepted.event.ts`).

**Paymob has one webhook route** (`infra/paymob`). A module that takes payments implements `PaymobWebhookHandler`, registers with `PaymobWebhookDispatcher` in `onModuleInit`, uses a prefixed `special_reference`, and matches only on signed ids.

**Lint is real now:** `pnpm --filter @riven/api lint` (ESLint 9, `eslint.config.mjs`) fails on `console.*`, on `PrismaService` outside `*.repository.ts`/`infra/`, and on importing another module's repository. `no-explicit-any` is a warning.

**Admin writes are audited by hand, not by magic.** A new admin action is recorded only if you add an `AdminAction` enum value (migration) **and** call `auditService.record()` in the service method, after the domain write. `actorId` always comes from `@CurrentUser()`, never the body. Audit is best-effort: `record()` logs failures and never fails the request (`specs/admin-module-spec.md` §5). Moderation transitions are idempotent — a no-op repeat writes nothing and records nothing.

## Process

- **One task = one small, coherent unit.** Never "build the whole module."
- **Spec first**, reviewed before implementation. A second pass gets a new numbered file (`bazaars-module-spec2.md`), not an edit to the original. Before implementing any spec, diff its schema assumptions against `apps/api/prisma/schema.prisma` — several specs predate the code and reference enums and index names that no longer match.
- **Show real evidence** — actual command output, actual HTTP responses, actual `git diff`. Never report success from a summary.
- **Staged diff review**, each stage approved before the next: repository/service → controllers/DTOs → tests. Never one combined diff.
- **Claude never runs `git commit` or `git push`.** Both are the maintainer's action, not the agent's. Finish the work, show the diff, and stop there — propose the conventional commit message if useful, but leave the commit itself to a human. Only Ibrahim pushes to `main`.
- If a decision isn't covered by the specs, stop and ask rather than guessing.

### Don't repeat these

Silent 429s on rate-limited endpoints · timing-unsafe signature comparison (use `crypto.timingSafeEqual` with a length check first, per `PaymobService.verifyWebhookHmac`) · N+1 queries passing review · internal fields leaking on public endpoints.

## Commands

```bash
docker compose up -d                              # postgres :5433, redis :6379, meilisearch :7700
cp .env.example .env
pnpm install
pnpm --filter @riven/api prisma generate
pnpm --filter @riven/api prisma migrate dev
pnpm --filter @riven/api start:dev
pnpm --filter @riven/api test
pnpm typecheck
```

## Gotchas

- **Postgres is on host port 5433**, not 5432 — deliberate, to avoid colliding with a local Postgres install.
- **`test` wipes the database.** Unit and e2e specs run together (`testRegex: .*\.spec\.ts$`), and the e2e specs `deleteMany()` users, vendors, bazaars and booths against the configured database. There is no separate test DB and no seed script.
- **CI** runs lint + typecheck + `check:env`, then unit tests, then `prisma migrate deploy` + e2e against throwaway postgis/redis/meilisearch containers (`.github/workflows/ci.yml`). Locally: `test:unit` needs no services; `test:e2e` and `test` wipe the configured database.
- **Env vars are Zod-validated at boot** (`infra/config/env.validation.ts`), including `S3_*` (required) and `PAYMOB_*` (optional, but must be well-formed when set). `pnpm --filter @riven/api check:env` verifies `.env.example` still lists every required key.
- **`apps/api/prisma/schema.prisma` is the source of truth**; `specs/schema.prisma` is a reference copy that has drifted.
- **Paymob webhook ID-matching is still unverified against a real sandbox.** The handler (`modules/checkout/paymob-webhook.service.ts`) matches only on signed fields (`order.id`, `id`) against `OrderGroup.paymobOrderId` / `paymobIntentId`, and `paymobOrderId` is read from `intention_order_id` in the intention response — both field names need confirming with a sandbox payload before any other payment work. Money is integer piastres end to end (`common/money.ts`).
