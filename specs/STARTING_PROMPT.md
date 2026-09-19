# Riven — Starting Prompt for Coding Agent

You are building **Riven**, a discovery platform (not e-commerce) connecting shoppers, vendors, and bazaar organizers in Egypt. Read every file below before writing any code — do not start from assumptions.

## Read first, in this order
1. `riven-spec.md` — product spec: roles, entities, monetization, MVP build order (§13 is your sequence).
2. `riven-backend-architecture.md` — non-negotiable engineering standards: modular monolith rules, folder structure, DB safety (onDelete policies, transactions, constraints), error format, validation, testing strategy.
3. `apps/api/prisma/schema.prisma` — the live database schema (the copy that used to live in `specs/` is retired; see the note left in its place). Do not modify it without flagging why first.
4. `specs/auth-module-spec.md` — exact requirements for the first module you build.
5. `specs/api-contract.md` — request/response shapes for MVP steps 1–4.
6. `specs/mobile-architecture.md` — RN app structure (for later, not step 1).
7. `specs/map-spike-brief.md` — the isometric map prototype (do this before the real booth editor, not before auth).

## Hard rules (from the architecture doc, restated because they're the ones most often skipped)
- Modules never reach into another module's Prisma calls/services directly — only through that module's exported public service, or domain events.
- Every Prisma call lives in that module's `*.repository.ts` — never in a service or controller.
- Every foreign key has an explicit `onDelete` policy — no defaults left unset.
- Any write touching more than one table goes in a `$transaction`.
- Every DTO uses `class-validator`; global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true`.
- Never hard-delete `Vendor`/`Bazaar`/anything a `Rating`/`Follow`/history points at — soft-delete via `deletedAt`.
- All errors throw the custom exception classes (not raw `Error`/strings) so the global filter formats them consistently.

## Build order (do not skip ahead)
1. `docker-compose.yml` + `.env.example` provided — bring the local stack up, confirm `prisma migrate dev` runs clean against it, and hand-add the GIST indexes + rating CHECK constraint noted at the bottom of `schema.prisma` to the generated migration SQL.
2. **Auth module** — build to `specs/auth-module-spec.md` exactly. This is what every other module's `@Roles()` guard depends on.
3. Isometric map spike (`specs/map-spike-brief.md`) — throwaway prototype, report back before continuing.
4. Bazaars module → BoothLayout/Booth → BoothListing application workflow, per MVP order in `riven-spec.md` §13 and shapes in `specs/api-contract.md`.
5. Stop and report back before starting anything past step 4 (discovery feed, notifications, search, payments) — those haven't been speced to this level of detail yet and need another pass first.

## Non-negotiable workflow rules
- **Show the diff before any code is committed or deployed.** No summaries accepted as proof of what changed — I need to see the actual diff.
- **No production credentials or env values touched without explicit approval.**
- **No claiming something works without raw terminal/test output.** "Tests pass" needs the actual test run shown, not a description of it.
- If a decision point comes up that isn't covered in the specs above (see "Open questions" in `api-contract.md` for two known ones), stop and ask rather than guessing and moving on.

## Current status
Schema is finalized (includes `passwordHash` + `RefreshToken` for auth). Docker environment, auth spec, API contract, mobile architecture, and map spike brief are all done. Nothing has been built yet — you're starting from zero code, step 1 above.
