# Riven — API Contract Stub (v1)

Rough request/response shapes for MVP steps 1–4 (auth, bazaars, booth layout, booth listings). Not final — the agent should generate real DTOs from these plus `schema.prisma`, and this doc gets updated to match once real code exists (don't let it silently drift).

All responses use the envelope from architecture doc §4:
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "...", "message": "..." } }
```

## Auth
```
POST /auth/register
  body: { name, email, phone?, password, role: SHOPPER|VENDOR|ORGANIZER }
  → 201 { user: { id, name, email, role }, accessToken, refreshToken }

POST /auth/login
  body: { email, password }
  → 200 { user: {...}, accessToken, refreshToken }

POST /auth/refresh
  body: { refreshToken }
  → 200 { accessToken, refreshToken }

POST /auth/logout
  body: { refreshToken }
  → 204
```

## Vendors (profile lives on the User created at registration)
```
POST /vendors                    [auth: VENDOR, one per user]
  body: { name, category, description?, hasFixedLocation, homeLocation? }
  → 201 { vendor }

PATCH /vendors/me                [auth: VENDOR]
GET  /vendors/:id                [public]
GET  /vendors                    [public] ?category=&near=lat,lng&radius=
```

## Bazaars
```
POST /bazaars                    [auth: ORGANIZER]
  body: { name, description?, location, scheduleType, recurrenceRule?, startDate, endDate? }
  → 201 { bazaar } (status: DRAFT)

POST /bazaars/:id/publish        [auth: ORGANIZER, owner only]
  → triggers Paymob listing-fee payment flow, bazaar → PUBLISHED only after payment succeeds

GET  /bazaars/:id                [public]
GET  /bazaars                    [public] ?near=lat,lng&radius=&status=PUBLISHED&date=
```

## Booth layout (organizer web only)
```
PUT /bazaars/:id/layout          [auth: ORGANIZER, owner only]
  body: { gridConfig: {...}, booths: [{ label, positionX, positionY, width, height }] }
  → 200 { layout, booths }        // idempotent full replace, not incremental patch — simplest
                                   // correct behavior for a drag-and-drop editor that saves on exit

GET /bazaars/:id/layout          [public]  → { layout, booths: [{..., boothListing? }] }
```

## Booth listings (vendor application workflow)
```
POST /bazaars/:id/apply          [auth: VENDOR]
  → 201 { boothListing }  (PENDING)  — 409 CONFLICT if already applied (DB @@unique catches races)

GET /bazaars/:id/applications     [auth: ORGANIZER, owner only] ?status=PENDING
  → { boothListings: [{..., vendor}] }

POST /booth-listings/:id/accept   [auth: ORGANIZER, owner only]
  body: { boothId }
  → 200 { boothListing }   // wrapped in $transaction per architecture doc §3:
                            // updates applicationStatus AND assigns booth atomically

POST /booth-listings/:id/reject   [auth: ORGANIZER, owner only]
  → 200 { boothListing }
```

## Open questions the agent should NOT decide unilaterally — flag back if hit
- Exact Paymob webhook payload shape (depends on Paymob's actual API response — pull from their docs when building the payments module, don't guess).
- Whether `/bazaars/:id/publish` blocks synchronously on payment or returns a pending state with a redirect URL (likely the latter, but confirm before building the payments module).
