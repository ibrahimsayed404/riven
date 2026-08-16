# Contributing to Riven

This document defines how we work in this monorepo — even when working solo. Consistency here keeps history scannable and makes changelogs and reviews straightforward later.

## Branch strategy

- **Default branch:** `main`
- **Feature work:** branch from `main`, open a PR back to `main`, merge when ready
- **Branch naming:**
  - `feature/<short-description>` — new capability (e.g. `feature/auth-module`)
  - `fix/<short-description>` — bug fix (e.g. `fix/token-refresh-loop`)
  - `chore/<short-description>` — tooling, deps, CI (e.g. `chore/upgrade-turbo`)

During initial foundation setup, direct commits to `main` are acceptable. Once real application modules begin, treat `main` as protected: no direct pushes; use feature branches and PRs (including self-review PRs).

## Conventional commits

Every meaningful unit of work gets its own commit with a [Conventional Commits](https://www.conventionalcommits.org/) prefix:

| Prefix | Use for |
|--------|---------|
| `feat:` | New user-facing capability |
| `fix:` | Bug fix |
| `chore:` | Tooling, deps, CI, repo maintenance |
| `docs:` | Documentation only |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |

**Examples:**

```
feat(auth): add refresh token rotation
fix(api): reject expired JWT before DB lookup
chore: upgrade turbo to 2.3
docs: document local docker stack
```

### Commit discipline

- One logical change per commit — not one giant commit per session
- Message body optional but encouraged for non-obvious changes
- Reference spec or issue when relevant: `feat(bazaars): booth layout CRUD per bazaars-module-spec`

## Pull requests

Each meaningful unit of work should land via PR, even when reviewing your own work:

1. Create a feature branch from `main`
2. Make focused commits following the convention above
3. Open a PR against `main` with a short summary of what changed and why
4. Ensure CI passes (lint + typecheck at minimum)
5. Merge when satisfied — squash or merge commit per preference; keep `main` history clean

## Local checks before pushing

```bash
pnpm install
pnpm lint
pnpm typecheck
```

Expand this list as apps and packages add real lint/typecheck scripts.

## What not to commit

- `.env` or any file with secrets
- `node_modules/`, build artifacts (`dist/`, `.next/`, `.expo/`), or local caches
- Generated files that can be reproduced (unless the repo explicitly tracks them)

See `.gitignore` for the full list.
