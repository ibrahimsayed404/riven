# Riven

Discovery platform connecting shoppers, vendors, and bazaar organizers in Egypt — not e-commerce.

This repository is a **pnpm monorepo** orchestrated with **Turborepo**. Application code lives in `apps/`; shared libraries live in `packages/`.

## Structure

```
riven/
├── apps/              # api, mobile, vendor-portal, admin (future)
├── packages/          # types, ui-tokens, map-core, auth-proxy (future)
├── assets/            # brand assets and shared images
├── specs/             # product and engineering specifications
└── .github/workflows/ # CI
```

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) 9+ (`corepack enable` recommended)
- Docker (for local Postgres, Redis, Meilisearch — see `docker-compose.yml`)

## Getting started

```bash
corepack enable
pnpm install
```

When apps and packages are added, common commands will be:

```bash
pnpm dev          # run dev servers via Turborepo
pnpm build        # build all packages/apps
pnpm lint         # lint all workspaces
pnpm typecheck    # typecheck all workspaces
```

Copy `.env.example` to `.env` before running services locally.

## Specs

Read `specs/STARTING_PROMPT.md` first, then the module specs in `specs/` before building features.

## Development process

This project follows a strict small-step, evidence-based workflow. See [WORKFLOW.md](./WORKFLOW.md) for the full process.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for commit conventions, branch naming, and workflow expectations.

## License

Private — all rights reserved.
