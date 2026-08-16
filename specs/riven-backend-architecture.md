# Riven — Backend Architecture & Engineering Standards

## 1. Architecture style: Modular Monolith

One NestJS application, one PostgreSQL database, organized into strictly isolated modules.

**The one rule that makes this work:** modules never import another module's internals directly (no reaching into another module's Prisma calls, services, or repositories). They only talk to each other through that module's exported **public service interface**, or through **domain events** for anything that isn't a direct request/response. This one discipline is what makes the codebase both bug-resistant now and splittable into real microservices later, if you ever actually need that — because the boundary already exists in the code, not just in your head.

```
Bazaars module          Notifications module
     │                          ▲
     │  BazaarsService          │  listens for
     │  .create()               │  "bazaar.created" event
     ▼                          │
  (public API)  ──emits event──┘
```

Never do this instead:
```ts
// ❌ inside notifications module
import { PrismaService } from '../bazaars/bazaars.prisma'; // reaching into another module
```

## 2. Full folder structure

```
apps/api/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── strategies/          # jwt.strategy.ts, refresh.strategy.ts
│   │   │   ├── guards/              # jwt-auth.guard.ts, roles.guard.ts
│   │   │   ├── decorators/          # @Roles(), @CurrentUser()
│   │   │   └── dto/
│   │   │
│   │   ├── users/
│   │   ├── vendors/
│   │   ├── organizers/
│   │   ├── bazaars/
│   │   │   ├── bazaars.module.ts
│   │   │   ├── bazaars.controller.ts
│   │   │   ├── bazaars.service.ts        # public API other modules use
│   │   │   ├── bazaars.repository.ts     # ALL Prisma calls live here, nowhere else
│   │   │   ├── dto/
│   │   │   │   ├── create-bazaar.dto.ts
│   │   │   │   └── update-bazaar.dto.ts
│   │   │   ├── entities/                 # response shapes (not DB models)
│   │   │   └── events/
│   │   │       └── bazaar-created.event.ts
│   │   │
│   │   ├── booth-listings/               # vendor↔bazaar application workflow
│   │   ├── booth-layouts/                # the isometric map data
│   │   ├── events/                       # standalone Events entity (not domain events)
│   │   ├── discovery/                    # feed + geo search — reads from other modules'
│   │   │                                 #   public services, owns no data of its own
│   │   ├── follows/
│   │   ├── favorites/
│   │   ├── ratings/
│   │   ├── notifications/
│   │   ├── media/                        # S3 signed upload URLs
│   │   ├── search/                       # Meilisearch sync
│   │   ├── payments/                     # Paymob integration
│   │   └── admin/
│   │
│   ├── common/
│   │   ├── filters/
│   │   │   └── all-exceptions.filter.ts  # ONE place all errors get formatted
│   │   ├── interceptors/
│   │   │   ├── logging.interceptor.ts
│   │   │   └── transform.interceptor.ts  # consistent response envelope
│   │   ├── pipes/
│   │   │   └── validation.pipe.ts
│   │   ├── decorators/
│   │   └── constants/
│   │       └── error-codes.ts            # every error has a stable code, see §6
│   │
│   ├── infra/
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts
│   │   │   └── prisma.service.ts
│   │   ├── redis/
│   │   ├── queue/                        # BullMQ setup
│   │   └── config/
│   │       └── env.validation.ts         # validates all env vars at boot, see §5
│   │
│   └── jobs/                             # BullMQ processors, separate from HTTP request path
│       ├── notification-fanout.processor.ts
│       ├── search-sync.processor.ts
│       └── subscription-renewal.processor.ts
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/                       # never hand-edit, never delete old ones
│   └── seed.ts
│
└── test/
    ├── unit/            # mirrors src/ structure exactly
    └── e2e/
```

**Why `repository.ts` is separated from `service.ts` in every module:** the service holds business logic (validation, orchestration, permission checks); the repository holds only Prisma queries. This means (a) you can unit-test business logic by mocking one repository interface instead of mocking Prisma, and (b) if a query is wrong, there's exactly one file per module to check.

## 3. Database safety — this is where most "random bugs" actually come from

**Migrations:**
- Every schema change goes through `prisma migrate dev` — never edit the database by hand, ever, not even "just this once" in production. One manual fix that isn't in a migration file is the start of your dev/prod schema drifting apart silently.
- Migrations are one-way and additive where possible. To remove a column: (1) stop writing to it, deploy, (2) stop reading it, deploy, (3) drop it in a later migration. Never drop+rebuild in one step on a live table.

**Every foreign key gets an explicit `onDelete` policy** — don't leave it to the default. Decide per relation:
- `BoothListing.vendorId` → `onDelete: Cascade` (if vendor deleted, their applications go too)
- `Bazaar.organizerId` → `onDelete: Restrict` (don't allow deleting an organizer who has active bazaars — force explicit handling)
Getting this wrong is one of the most common causes of either orphaned rows or accidental mass-deletion.

**Transactions for anything multi-step.** Any operation that writes to more than one table must be wrapped in a Prisma `$transaction`. Example: accepting a `BoothListing` application also needs to assign a `Booth` and fire a notification — if the process crashes between steps without a transaction, you get a vendor marked "accepted" with no booth assigned, and no way to know it happened.

```ts
await this.prisma.$transaction(async (tx) => {
  await tx.boothListing.update({ where: { id }, data: { applicationStatus: 'accepted' } });
  await tx.booth.update({ where: { id: boothId }, data: { boothListingId: id } });
});
// notification is fired via domain event AFTER the transaction commits, not inside it
```

**Constraints do work your application code shouldn't have to.** Put uniqueness and validity rules in the schema, not just in service-layer `if` checks:
```prisma
@@unique([bazaarId, vendorId]) // a vendor can't apply to the same bazaar twice
```
An app-level check has a race condition (two requests at once both pass the check before either writes). A DB constraint doesn't.

**Indexes from the first migration, not added later "when it's slow":**
- Every foreign key column
- `Bazaar.location` and `Vendor.homeLocation` as GIST/PostGIS spatial indexes
- Any column used in a `WHERE` on a list endpoint (e.g. `BoothListing.applicationStatus`)

**Soft-delete for anything a rating/review/history depends on.** Don't hard-delete `Vendor` or `Bazaar` rows — add `deletedAt: DateTime?` and filter it out in queries. Hard deletes break every `Rating`, `Follow`, and historical `BoothListing` pointing at that row.

## 4. Error handling — one consistent system, not ad-hoc try/catch

Define a small set of custom exceptions once, in `common/exceptions/`, and throw *those* everywhere — never throw raw strings or generic `Error`:

```ts
export class ResourceNotFoundException extends NotFoundException {
  constructor(resource: string, id: string) {
    super({ code: 'RESOURCE_NOT_FOUND', message: `${resource} ${id} not found` });
  }
}
export class InvalidStateTransitionException extends BadRequestException {
  constructor(from: string, to: string) {
    super({ code: 'INVALID_STATE_TRANSITION', message: `Cannot move from ${from} to ${to}` });
  }
}
```

One global `AllExceptionsFilter` catches everything and formats every response the same way — the mobile app and web app should never have to guess what shape an error comes in:
```json
{ "success": false, "error": { "code": "RESOURCE_NOT_FOUND", "message": "..." } }
```

This matters more than it sounds: "zero bugs" mostly comes from *predictable* failure, not from failures never happening. If every error is shaped the same way, your RN and Next.js clients can handle errors generically instead of each screen needing custom error-parsing logic (which is where UI bugs hide).

## 5. Config & environment — fail at boot, not at 2am in production

Validate all environment variables with a schema (Zod or `class-validator`) at startup, so a missing `DATABASE_URL` or `PAYMOB_SECRET` crashes the app immediately on deploy, not three hours later when the first payment comes in.

```ts
// infra/config/env.validation.ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PAYMOB_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // ...
});
```

## 6. Validation — reject bad data at the edge, trust it everywhere after

Every DTO uses `class-validator` decorators, and a global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true` — this strips/rejects any field the client sends that isn't explicitly expected. This alone prevents a huge class of bugs where a typo'd or malicious extra field silently gets through to the database.

```ts
export class CreateBazaarDto {
  @IsString() @Length(3, 100) name: string;
  @IsEnum(ScheduleType) scheduleType: ScheduleType;
  @ValidateIf(o => o.scheduleType === 'recurring')
  @IsString() recurrenceRule?: string;
}
```

Once past the controller boundary, the service layer trusts the shape of its input — you don't re-validate everywhere, you validate once at the edge.

## 7. Testing strategy (proportional, not maximal)

You don't need 100% coverage — you need coverage where a bug is expensive:
- **Unit tests**: service-layer business logic (booth assignment rules, subscription state transitions, geo-radius edge cases). Mock the repository.
- **Integration tests**: anything touching the database directly — use a real test Postgres (via Docker) not mocks, since Prisma query bugs won't show up against a mock.
- **E2E tests**: the critical paths only — signup→vendor application→organizer acceptance→booth assignment, and the Paymob webhook flow. These are your money paths; they're the ones that must never silently break.

## 8. CI gate before merge (set this up week one, not "later")
1. Lint + typecheck
2. Unit + integration tests
3. `prisma migrate diff` check — fails the build if schema.prisma and the migrations folder are out of sync
4. Build all four apps (api, mobile, web, portal) to catch shared-type breakage early

## 9. When (if ever) to actually split into services

Don't, until you have a concrete, measured reason — e.g. the `discovery`/search module needs independent scaling because it's read-heavy at 100x the traffic of `payments`. Because module boundaries were respected from day one (§1), extracting one module into its own service later means: give it its own database, replace its direct service calls with HTTP/queue calls, done. That's a project, not a rewrite.
