# Development Workflow

This project is built in small, fully-verified steps. No exceptions, no shortcuts — this discipline is what keeps the codebase trustworthy.

## The cycle

1. **One task = one coherent unit of work.** Never "build the whole module" — always one small, clearly-scoped piece (e.g. "add login endpoint," not "build auth").
2. **Specify before coding.** Every task is specified in detail before any code is written — including exactly what must be verified and what evidence must be shown.
3. **Implementation must produce real evidence**, not summaries:
   - Actual command output (typecheck, build, test runs)
   - Actual HTTP responses (`curl` output), not paraphrased
   - Actual database query results when relevant (e.g. confirming a password is really hashed, not just "should be hashed")
   - Actual `git diff` output for review
   - Never accept or produce a report that just says "done ✅" without the underlying evidence attached.
4. **Commit locally. Do not push.** Every unit of work is committed with a conventional commit message (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) but held locally until reviewed.
5. **Review the real diff before approving.** Read the actual changed lines, not just the description of them. Check the evidence against the original requirement specifically — does it actually prove what it claims to prove?
6. **Only push after explicit approval.** Nothing reaches `main` without this step.
7. **CI must be green.** Every push triggers lint + typecheck in a clean environment — this catches anything a local machine's cached state might hide (e.g. a missing `prisma generate` step that only breaks in a truly clean install).

## Why this matters

Every one of these rules exists because skipping it has caused a real problem in this project:

- Trusting a summary instead of real evidence let bugs slip through unnoticed.
- Pushing before review let a broken CI config go unnoticed for 9 commits.
- Large, unscoped tasks ("build the whole module") made it hard to catch exactly where something went wrong.

## Commit discipline

- Conventional commit prefixes, always.
- One commit = one logical change. Don't bundle unrelated edits.
- If a task reveals an unrelated necessary fix (e.g. a stale tsconfig warning), that becomes its own separate commit, not folded into the original one.

## When something breaks

- Diagnose the actual root cause before attempting a fix — don't guess-and-check.
- If a fix doesn't fully resolve the issue, say so plainly rather than declaring success prematurely.
- Prefer the smallest correct fix over a broad rewrite.
