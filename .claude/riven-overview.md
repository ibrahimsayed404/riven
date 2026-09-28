# Riven — Product Overview

Discovery platform connecting shoppers, local brands/vendors, and bazaar/event organizers across Egypt.

## Two product surfaces, one codebase

Riven started as a pure discovery platform and later grew a commerce layer. Both are live in the schema and code:

1. **Discovery / bazaars** — organizers create bazaars, build an isometric booth layout, and accept vendor applications. Shoppers browse, follow, favorite and rate. Monetized by organizer listing fees and vendor storefront subscriptions.
2. **Fashion marketplace** — vendors sell products directly: catalog with variants, multi-vendor cart, per-vendor sub-orders, Paymob payment.

`Vendor.vendorType` (`BAZAAR_ONLY` / `MARKETPLACE` / `BOTH`) is what separates them.

> **Important when reading specs:** `specs/riven-spec.md` §1 still says "Not e-commerce — no cart, no checkout for products." That was overridden by `specs/fashion-marketplace-addendum.md` and is contradicted by merged code. `specs/payments-module-spec.md` §1 repeats the outdated claim too. Treat `riven-spec.md` as the base vision and the addendum as the authoritative override where they conflict.

## Roles

Four roles, one per account — no multi-role accounts. Someone who both shops and sells needs two accounts.

| Role | Can do |
|---|---|
| `SHOPPER` | Browse/discover, follow & favorite, rate, cart & checkout, get notifications |
| `VENDOR` | Brand profile + product catalog, apply to bazaars, manage own subscription and orders |
| `ORGANIZER` | Create bazaars/events, define schedule, build booth layout, review vendor applications, pay listing fee |
| `ADMIN` | Approve vendors/organizers/products, moderate content, manage disputes |

`role` is set at registration and is immutable. Public registration must reject `role: ADMIN` in the **service layer**, not just the DTO enum — admin accounts are created out-of-band only.

## Approval-gated visibility is platform-wide

Vendors, organizers, and products are all invisible to shoppers until an admin approves them. Editing a product resets it to `PENDING`. Any new module that creates user-facing content must follow the same pattern.

## Stack

| Layer | Choice |
|---|---|
| Backend | NestJS + TypeScript (modular monolith) |
| Database | PostgreSQL + PostGIS via **Prisma 6.x** — do not upgrade to 7 (breaking schema-format changes) |
| Search | Meilisearch |
| Cache / queue | Redis + BullMQ |
| Storage | S3-compatible + Cloudflare CDN (not yet set up — blocks all image upload work) |
| Payments | Paymob (cards, wallets, Fawry) — sandbox credentials still pending |
| Mobile | React Native (Expo) — not started |
| Web + portal | Next.js ×2 — not started |
| Monorepo | Turborepo + pnpm workspaces |

Geographic scope is Egypt only. Currency is EGP; Paymob amounts are sent in piastres (`amount * 100`, integer).

## Decision ownership

**Ibrahim** is the product decision-maker. Locked decisions are recorded inline in the specs (e.g. `fashion-marketplace-addendum.md` §1 "Decisions Locked (Confirmed by Ibrahim)"). Each module spec ends with an "Open Items" list — those go back to him rather than being resolved unilaterally.
