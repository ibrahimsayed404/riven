# Riven — How We Work

Small, fully-verified steps. This discipline exists because skipping each of these rules has already caused a real problem in this project.

## The cycle

1. **Spec first.** Write a scoped spec before any code. Surface open questions up front rather than guessing.
2. **Review the spec** with Ibrahim before implementation starts.
3. **Implement** against the approved spec — one small, coherent unit of work. Never "build the whole module."
4. **Staged diff review.** Submit in three separate passes, each approved before the next begins:
   - (a) repository / service layer
   - (b) controllers / DTOs
   - (c) tests

   Never dump everything in one diff.
5. **A human commits.** Claude never runs `git commit` — it finishes the work, shows the diff, and stops. Proposing the conventional commit message is fine; running the command is not.
6. **Only Ibrahim runs `git push origin main`.** Agent sessions can't complete interactive auth. Never push; coordinate timing with him.

## Evidence, not summaries

A report that says "done" without the underlying output is not accepted. Show:

- Actual command output — typecheck, build, test runs
- Actual HTTP responses (`curl` output), not paraphrased
- Actual database query results where relevant (e.g. proving a password is really hashed)
- Actual `git diff` output for review

Never claim something works without the raw run attached. If a fix doesn't fully resolve the issue, say so plainly rather than declaring success early.

## Spec format

Each module gets `specs/<name>-module-spec.md` with a consistent header:

- **Status** — Draft for review / FINALIZED
- **Scope**
- **Depends on** — which models are already migrated
- **Out of scope (this pass)**
- **Blocked (partial)** — where an external dependency is missing
- **Open Items For Discussion** — closing section

A second pass at a module gets a **new numbered file** (`bazaars-module-spec.md` → `bazaars-module-spec2.md`), not an edit to the original.

Before implementing any spec, diff its schema assumptions against `apps/api/prisma/schema.prisma` and check whether an already-merged module owns the same route. Several specs predate the code — see `.claude/riven-known-issues.md`.

## Commit discipline

Conventional prefixes always: `feat:` `fix:` `chore:` `docs:` `refactor:` `test:`. Scope where useful — `feat(bazaars): booth layout CRUD per bazaars-module-spec`.

One commit = one logical change. If a task reveals an unrelated necessary fix, that becomes its own separate commit, not folded into the original.

## Migrations

- Every schema change goes through `prisma migrate dev`. Never edit the database by hand, never hand-edit or delete an existing migration.
- **Check every new migration for stray `DROP INDEX` on the four GIST indexes** — `user_location_gist`, `vendor_home_location_gist`, `bazaar_location_gist`, `event_location_gist`. Prisma's diffing can't see them because the columns are `Unsupported(...)`. If dropped, recreate them manually in the migration SQL.
- Removing a column is three deploys: stop writing → stop reading → drop. Never drop-and-rebuild a live table in one step.

## Bugs that have already bitten us — don't repeat

- Silent 429s on rate-limited endpoints (caught in review, nearly shipped)
- Timing-unsafe HMAC comparison on a webhook — use `crypto.timingSafeEqual` with a length check first, per `PaymobService.verifyWebhookHmac`
- N+1 queries passing review unnoticed
- Internal fields leaking on public endpoints — verify DTOs/selects exclude them before marking an endpoint public
- Trusting a summary instead of real evidence
- Pushing before review (left a broken CI config unnoticed for 9 commits)
