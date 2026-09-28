# Riven — Engineering Standards

Full detail in `specs/riven-backend-architecture.md`. These are the rules most often skipped.

## Module boundaries

- **Every Prisma call lives in that module's `*.repository.ts`.** Never in a service, never in a controller. Services hold business logic, validation, permission checks, orchestration.
- **A module never reaches into another module's repository or internals.** Cross-module access goes through the other module's exported public **service**, or through domain events.
- Wrong: `import { ProductsRepository } from '../products/products.repository'`
- Right: `import { ProductsService } from '../products/products.service'` + `imports: [ProductsModule]`

## Database safety

- **Every foreign key gets an explicit `onDelete`.** No defaults left unset. Decide per relation — `Cascade` for dependent rows, `Restrict` to force explicit handling.
- **Any write touching more than one table goes in a `$transaction`.** Domain events / notifications fire *after* the transaction commits, never inside it.
- **Constraints do work application code shouldn't.** Put uniqueness and validity in the schema (`@@unique([bazaarId, vendorId])`, CHECK constraints). An app-level `if` has a race condition; a DB constraint doesn't.
- **Soft-delete anything a Rating, Follow, or history row points at** — `Vendor`, `Bazaar`, `Product`, `User`. Set `deletedAt` and filter it out. Hard deletes break every reference.
- **Indexes from the first migration**, not "when it's slow": every FK, GIST on every geography column, and any column used in a `WHERE` on a list endpoint.

## PostGIS

Prisma has no geography type, so location columns are `Unsupported("geography(Point, 4326)")`. Prisma Client **cannot** read or write them — use `$queryRaw` / `$executeRaw` **in the repository layer**, never in a service.

```sql
-- write
ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
-- radius filter
ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})
```

Existing GIST index names: `user_location_gist`, `vendor_home_location_gist`, `bazaar_location_gist`, `event_location_gist`.

## Validation

Every DTO uses `class-validator`. The global pipe in `main.ts` runs `whitelist: true, forbidNonWhitelisted: true` — any unexpected field is rejected, not silently dropped. Validate once at the controller edge; the service layer then trusts its input shape.

Reuse `common/validators/is-egyptian-phone.validator.ts` for phone fields.

## Errors

One global `AllExceptionsFilter` formats every error as:

```json
{ "success": false, "error": { "code": "STABLE_CODE", "message": "..." } }
```

To get a real `code`, throw with an object payload:

```ts
throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
```

Throwing a bare string (`new NotFoundException('Bazaar not found.')`) falls back to `code: "HTTP_ERROR"` and clients can't branch on it. Much of the existing code does this — see `.claude/riven-known-issues.md`.

## Module layout

```
modules/<name>/
  <name>.module.ts
  <name>.service.ts        # business logic, public API for other modules
  <name>.repository.ts     # ALL Prisma calls
  dto/
  jobs/                    # BullMQ processors, if any
  <role>-<name>.controller.ts
```

Controllers are split by audience, not merged: `public-bazaars.controller.ts`, `organizer-bazaars.controller.ts`, `admin-organizers.controller.ts`, `vendor-orders.controller.ts`. Guards are applied at class level where the whole controller shares a role:

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR)
@Controller('vendors/me/orders')
```

Owner-scoped routes must check ownership **in the service**, not just the role — `@Roles(Role.ORGANIZER)` alone lets any organizer touch any bazaar.

## Testing

Proportional, not maximal — cover where a bug is expensive:

- **Unit** — service business logic with the repository mocked (`*.service.spec.ts`)
- **E2E** — critical paths only: signup → vendor application → acceptance → booth assignment, and the payment/webhook flow (`*.e2e.spec.ts`)

## Local development

```bash
docker compose up -d          # postgres+postgis :5433, redis :6379, meilisearch :7700
cp .env.example .env
pnpm install
pnpm --filter @riven/api prisma generate
pnpm --filter @riven/api prisma migrate dev
pnpm --filter @riven/api start:dev
```

- **Postgres is on host port 5433**, not 5432 — deliberate, to avoid colliding with a local Postgres install.
- Env vars are Zod-validated at boot in `infra/config/env.validation.ts`; a missing one crashes startup immediately. Note `PAYMOB_*` and `S3_*` are **not** in that schema yet.

### Tests wipe the database

`pnpm --filter @riven/api test` runs `jest --runInBand` with `testRegex: .*\.spec\.ts$` — **unit and e2e specs run together**. The e2e specs boot the full `AppModule` against the configured database and call `deleteMany()` on users, vendors, bazaars, booths and more in `beforeAll`. There is no separate test database and no seed script. Never run the suite against a database holding data you care about.

### CI does less than it looks

`.github/workflows/ci.yml` runs install → `prisma generate` → `pnpm lint` → `pnpm typecheck`. `pnpm lint` is currently a **no-op** — `@riven/api` has no `lint` script and there is no ESLint config in the repo — and **no tests run in CI**. A green check proves typecheck only. Run tests locally and show the output.
