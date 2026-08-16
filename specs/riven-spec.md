# Riven — Product & Architecture Spec (v1)

## 1. What Riven is
A discovery platform connecting shoppers, local brands/vendors, and bazaar/event organizers across Egypt. Not e-commerce — no cart, no checkout for products. Riven monetizes the *infrastructure of discovery*, not the sale of goods.

## 2. Revenue model
- **Organizers** pay to create/list a bazaar (per-bazaar fee).
- **Vendors/Brands** pay a recurring subscription for their profile page (their "storefront" instead of building a website).
- No commission on product sales. No shopper-facing fees.
- Payments via **Paymob** (cards, mobile wallets, Fawry references in one integration).

## 3. Roles (strict, one role per account)
| Role | Can do |
|---|---|
| **Shopper** | Browse/discover, follow & favorite vendors/bazaars, rate, get notifications |
| **Vendor/Brand** | Create brand profile + product catalog (landing-page style), apply to bazaars, manage own subscription |
| **Organizer** | Create bazaars/events, define schedule (one-off or recurring), build booth layout, review/accept/reject vendor applications, pay listing fee |
| **Admin** | Approve vendors/organizers, moderate content, manage disputes |

No multi-role accounts in v1 — a person who both shops and owns a brand needs two accounts.

## 4. Core entities

```
User            id, name, email, phone, role(enum), location(point), interests[]

Vendor          id, ownerId→User, name, category, description,
                logo, coverMedia[], hasFixedLocation(bool),
                homeLocation(point, nullable), verified, subscriptionStatus

Product         id, vendorId→Vendor, name, price, images[], description
                // catalog item on the vendor's page — NOT purchasable in-app

Organizer       id, ownerId→User, name, verified

Bazaar          id, organizerId→Organizer, name, description, coverMedia[],
                location(point), scheduleType(enum: one_off/recurring),
                recurrenceRule(nullable), startDate, endDate, status

BoothLayout     id, bazaarId→Bazaar, gridConfig(json)   // isometric layout definition

Booth           id, layoutId→BoothLayout, label, position(x,y,w,h),
                boothListingId(nullable)

BoothListing    id, bazaarId→Bazaar, vendorId→Vendor, boothId(nullable),
                applicationStatus(enum: pending/accepted/rejected), appliedAt

Event           id, bazaarId(nullable)→Bazaar, organizerId→Organizer,
                title, type, location(point), startsAt, endsAt, coverMedia[]

Follow          userId→User, followableType(enum: vendor/bazaar), followableId

Favorite        userId→User, favorableType(enum: vendor/bazaar/event), favorableId

Rating          userId→User, targetType(enum: vendor/bazaar/event),
                targetId, score(1-5), comment(nullable)

Notification    userId→User, type(enum), payload(json), readAt

Subscription    vendorId→Vendor, plan, status, paymobRef, currentPeriodEnd

Payment         id, payerType(enum: vendor/organizer), payerId, amount,
                purpose(enum: subscription/bazaar_fee), paymobRef, status
```

**Key modeling decisions:**
- `BoothListing` is the join between Vendor and Bazaar with a real approval workflow (`pending/accepted/rejected`) — this is where the organizer-vendor application process lives.
- `BoothLayout`/`Booth` are separate from `BoothListing` so a layout can exist before any vendor is assigned, and organizers can rearrange freely.
- `Vendor.hasFixedLocation` toggle: if true, vendor always appears on the main discovery map at `homeLocation`; if false, they only appear via active `BoothListing`s at bazaars they're attending.
- `Follow` = ongoing relationship (get notified of their activity). `Favorite` = bookmark/save for later. Kept separate since they serve different UI purposes (following feed vs. saved list).

## 5. The bazaar map (biggest architectural piece)

**Rendering: isometric 2.5D**, not flat 2D grid, not true 3D engine.
- Built with SVG/Canvas from `BoothLayout.gridConfig` + `Booth` position data — same data renders identically on RN mobile, Next.js web, and vendor portal.
- Looks premium (angled blocks, depth via shading) without needing 3D assets, a game engine, or per-bazaar manual authoring.
- Fast to render, low data cost, scales to any number of bazaars automatically since it's just structured data, not custom content.

**Layout creation: self-serve, organizer-built (web portal only)**
1. Organizer opens the booth editor, defines a grid or freeform canvas.
2. Drags/places booth blocks, sets label + dimensions.
3. Once a `BoothListing` is accepted, organizer assigns that vendor to a `Booth`.
4. Vendor's profile/products now render at that spot when a shopper opens the bazaar map.
- v2 (not now): allow uploading a background reference image behind the booths for extra realism — layered on top of the same booth-data system, not a replacement.

## 6. Discovery
- **Both map and list/feed views**, equally prioritized.
- Filters in v1: category, distance, date, price range.
- Personalization deferred past pure distance/recency sort is fine for MVP — but design the feed service so ranking weights (followed-entity boost, interest match) can be added without a schema change.

## 7. Community features (lightweight, v1)
- Follow / favorite vendors and bazaars.
- Rate (1–5 + comment) vendors, bazaars, events.
- No posts, no chat, no "Moments" (explicitly deferred — revisit later).

## 8. Notifications
- Push only (no email in v1).
- Three triggers, equal priority at launch: new bazaar nearby, followed vendor joining a new bazaar, reminder before a favorited event/bazaar starts.
- Use FCM (works for both iOS and Android via Expo).

## 9. Media
- Images and video both supported.
- Vendors upload: logo, cover media, product images.
- Organizers upload: bazaar/event cover media.
- Store via S3-compatible storage (e.g. AWS S3 or Cloudflare R2) with signed upload URLs — never proxy uploads through the API server.

## 10. Admin
- Approve/reject vendor and organizer accounts.
- Moderate flagged content.
- Needed from day one — build as a protected module in the vendor-portal app (or a separate lightweight admin app) rather than bolting onto the consumer app.

## 11. Scale requirements (design for this from day one, not later)
Target: hundreds of thousands of users, nationwide, heavy media volume.
- **Postgres + PostGIS** for geo queries, with proper spatial indexes from the first migration.
- **Redis** for feed caching (geo+rank queries are expensive — cache per location bucket).
- **Meilisearch** for vendor/bazaar/event search, kept in sync via a queue (not synchronous writes).
- **CDN in front of media storage** (Cloudflare) — non-negotiable given "a lot of items images" at national scale.
- **Background job queue** (BullMQ on Redis) for: notification fan-out, Meilisearch sync, subscription renewal checks, Paymob webhook processing.

## 12. Finalized stack

| Layer | Choice |
|---|---|
| Backend | NestJS + TypeScript |
| Database | PostgreSQL + PostGIS, via Prisma |
| Search | Meilisearch |
| Cache/Queue | Redis + BullMQ |
| Storage | S3-compatible + Cloudflare CDN |
| Payments | Paymob |
| Mobile | React Native (Expo) |
| Web (consumer) | Next.js |
| Vendor/Organizer/Admin portal | Next.js (separate app) |
| Shared types | `packages/types`, generated from Prisma, consumed by all four clients |
| Monorepo | Turborepo |

## 13. MVP build order
1. Auth + roles (User, Vendor, Organizer, Admin) + Paymob subscription flow for vendors
2. Bazaar creation + payment for listing fee
3. BoothLayout editor (organizer web) — grid + booth placement
4. BoothListing application/approval workflow
5. Isometric map renderer (shared data → RN + web + portal)
6. Discovery feed: list + map view, filters, distance sort
7. Follow / Favorite / Rating
8. Notifications (push, three trigger types)
9. Search (Meilisearch sync)
10. Admin moderation panel

---
*Open items to revisit later, by your own note: user-generated "Moments" content module, direct messaging, multi-country expansion, personalized ranking.*
