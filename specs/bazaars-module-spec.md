# Riven — Bazaars Module Specification

## 1. Scope
The Bazaars module encompasses:
- Bazaar lifecycle: Draft creation (`POST /bazaars`), publishing (`POST /bazaars/:id/publish`), public listing and detail endpoints.
- Booth layout management: Isometric grid configuration and booth coordinate definitions (`PUT /bazaars/:id/layout`, `GET /bazaars/:id/layout`).
- Booth listing application workflow: Vendor applications (`POST /bazaars/:id/apply`), organizer application review (`GET /bazaars/:id/applications`), atomic acceptance and booth assignment (`POST /booth-listings/:id/accept`), and rejection (`POST /booth-listings/:id/reject`).

---

## 2. Architecture & Concurrency Rules

### 2.1 Atomic Booth Assignment
- Booth assignment uses an atomic conditional query (`updateMany({ where: { id: boothId, boothListingId: null }, data: { boothListingId: listingId } })`) inside a Prisma `$transaction` to prevent race conditions during concurrent organizer assignments.
- If `count === 0`, the system validates booth existence and throws `BOOTH_ALREADY_ASSIGNED` (409 Conflict).

### 2.2 Booth Layout Idempotent Full Replace & Mutation Guard
- Layout creation/update (`PUT /bazaars/:id/layout`) operates as an idempotent full replace.
- **Explicit Architecture Decision**: Layout edits are blocked entirely (`CANNOT_MODIFY_LAYOUT_WITH_ASSIGNED_BOOTHS`, 400 Bad Request) once any booth in the layout has an assigned listing (`boothListingId !== null`), even for unrelated additions. This prevents silent deletion or orphaning of vendor booth assignments. *Revisit in a future phase if organizers need to expand a partially-filled bazaar.*

---

## 3. Endpoints & Permissions
- `POST /bazaars` — `Role.ORGANIZER`
- `POST /bazaars/:id/publish` — `Role.ORGANIZER` (Owner only)
- `GET /bazaars/:id` — Public
- `GET /bazaars` — Public (`?status=&organizerId=`)
- `PUT /bazaars/:id/layout` — `Role.ORGANIZER` (Owner only)
- `GET /bazaars/:id/layout` — Public
- `POST /bazaars/:id/apply` — `Role.VENDOR` (One application per bazaar/vendor pair)
- `GET /bazaars/:id/applications` — `Role.ORGANIZER` (Owner only)
- `POST /booth-listings/:id/accept` — `Role.ORGANIZER` (Owner only)
- `POST /booth-listings/:id/reject` — `Role.ORGANIZER` (Owner only)
