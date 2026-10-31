# 09 — One Backend for Website and Mobile Apps

> Status: **DRAFT for review** · 2026-10-24. Existing related specs to reconcile: `specs/api-contract.md`, `specs/web-dashboard-endpoints.md`, `specs/mobile-architecture.md`.

## 1. Principle

The website (shopper web + vendor/admin dashboard) and the mobile apps are **thin clients of one API**. Every business and financial rule — prices, totals, shipping fees, stock, payment and proof validation, state transitions, permissions — runs in the backend. Clients display state and send intent. A client can never cause a different business outcome than another client sending the same request.

Enforcement:
- No request or response field may change business behaviour based on client identity. `X-Client` (`web` / `ios` / `android` + version) is accepted for logging and analytics only; a lint/grep test fails if it is read outside the logging middleware.
- Amounts sent by clients (e.g. `claimedAmountMinor` on a proof) are compared against server values; they never become the server value.

## 2. Verified current state

| Area | Today | Evidence |
|---|---|---|
| Token delivery | access + refresh tokens returned in the JSON body | `auth.service.ts:278-284` |
| Rotation | yes, refresh tokens rotated on use | `auth.service.ts:260-276`, `auth.repository.ts:79-117` |
| Reuse detection | reuse of a revoked token **revokes every active token of the user** | `auth.service.ts:237-239`, `273-275` |
| Sessions / devices | none (no session or family id) | `schema.prisma:233-245` |
| OpenAPI | none | no `@nestjs/swagger` usage |
| Versioning / prefix | none | no `enableVersioning` / `setGlobalPrefix` |
| Mobile client | shopper only; empty checkout body; fixed status map; Paymob-only payment screen | `D:\Youssef\Riven-App` (`00-architecture-audit.md` §1.7) |
| Web client | dashboard specified, not in this repo | `specs/web-dashboard-endpoints.md` |

**R23 (MEDIUM):** a mobile app that loses the refresh response and retries with the old token triggers reuse detection and logs the user out on **all** clients.

## 3. Authentication for web and mobile

| Requirement | Design |
|---|---|
| Sessions per device | `RefreshToken.sessionId` (one per login on a device/browser) and `familyId` (the rotation chain). `GET /auth/sessions`, `DELETE /auth/sessions/:id` for the user |
| Rotation | unchanged: every refresh returns a new pair; the old token is revoked with `replacedById` set |
| Reuse detection | reuse of a revoked token revokes **that family only** (that device), not the user's other sessions (SD-03) |
| Concurrent refresh | clients must single-flight refresh (one in-flight refresh; other requests wait for it). Optional server grace per SD-03 |
| Web storage | refresh token in `httpOnly; Secure; SameSite=Strict; Path=/auth` cookie; CSRF double-submit token required on `/auth/refresh` and `/auth/logout`; access token in memory only (SD-04) |
| Mobile storage | `expo-secure-store` (Keychain / Keystore) for the refresh token; access token in memory |
| Body vs cookie | `/auth/login` and `/auth/refresh` return tokens in the body (mobile) **and** set the cookie when the request carries `X-Auth-Transport: cookie` (web). One code path, two transports |
| Logout | revokes the session's family; web clears the cookie |
| Role check | unchanged: the mobile app is shopper-only (`backend.ts:326-330` rejects other roles); the dashboard serves VENDOR / ORGANIZER / ADMIN |

## 4. Contracts

- **OpenAPI** generated from controllers and DTOs with `@nestjs/swagger` (TD-11), served at `/docs` in non-production and exported to `packages/api-contract/openapi.json` at build.
- **Shared types:** `packages/api-contract` (the monorepo's empty `packages/`) publishes generated TypeScript types used by the web app and the mobile app. The mobile app's hand-written `src/types/api.ts` migrates to it over time.
- **Error contract:** the existing `{ code, message, details? }` body from `AllExceptionsFilter` is the contract; every new error in this programme has a stable `code` listed in the module specs. Clients branch on `code`, never on `message`.
- **Versioning (TD-07):** `app.enableVersioning({ type: URI, defaultVersion: VERSION_NEUTRAL })` keeps every existing path working; new or changed behaviour is published under `/v1/...`. A breaking change ships only as a new version; the old one is kept until both clients have released the new one.
- **Additive-only on unversioned routes:** new response fields may be added; existing fields keep type and meaning; enums used by shipped clients (order status) keep their values (legacy projection, `03-state-machines.md` §13).

## 5. Network retries and app termination

| Situation | Design |
|---|---|
| Client retries a mutating request (timeout, flaky network) | `Idempotency-Key` header (UUID v4 generated per user intent, e.g. per "Place order" tap). Same key + same body → stored response replayed. Required on `/v1` money/inventory routes; optional during the compatibility window on unversioned routes (C8) |
| App killed after sending checkout | the key is persisted locally **before** sending; on restart the app re-sends with the same key (replay) or calls `GET /checkout/attempts/:key` → `{ status, orderGroupId? }` |
| App killed during Paymob payment | on restart `GET /orders/groups/:id/payment` returns attempt status, `clientUrl` while live, reservation expiry; the app resumes or shows the result. The server never depends on the app returning from Paymob (webhook + reconciliation decide) |
| App killed during proof upload | upload intent rows expire; the app requests a new upload URL; submission is idempotent per key |
| Polling | the app may poll `GET /orders/groups/:id/payment` (cheap, indexed); recommended back-off 2 s → 10 s; push replaces polling when notifications exist |

## 6. Payment-proof upload (same flow for both clients)

1. `POST /orders/groups/:groupId/payment-proofs/upload-url` → `{ url, fields, key, expiresInSeconds }` (presigned POST policy; private bucket; size/type limits in the policy).
2. Client uploads the file directly to storage (multipart form POST).
3. `POST /orders/groups/:groupId/payment-proofs` with `Idempotency-Key` and `{ key, channel, senderPhone, transactionRef, receivingAccountId, claimedAmountMinor, currency }`.
4. Server validates the stored object (HEAD, magic bytes, SHA-256) and the business rules (`payments-module-spec2.md` §4).

Web uses `fetch` + `FormData`; mobile uses `expo-file-system` / `FormData`. Neither client resizes or edits images in a way that changes the server-side checks (servers validate what was stored).

## 7. Notifications

- Source of truth for "what happened" is the backend state; notifications are best-effort hints delivered via the outbox (`01-target-architecture.md` §7).
- **In-app inbox:** the existing unused `Notification` model becomes the per-user inbox (`GET /notifications`), written by outbox consumers — same for web and mobile. Notification consumers only write notification rows and send pushes; they never change money, payment state or stock (`01` §7.8), so a delayed or duplicated notification can never change what the user owes or owns.
- **Push:** Expo push tokens (mobile) and Web Push (later) registered per session; consumers send with `eventId` for de-duplication; a duplicate push is tolerated.
- Events relevant here: order confirmed, proof approved/rejected (with reason), payment expired, refund completed, shipment handed over/delivered, COD confirmation call missed.
- Depends on `specs/notifications-module-spec.md` (which today covers only bazaar notifications) — a spec2 for commerce notifications is needed (TQ-11).

## 8. Mobile app changes required (separate repo, separate task)

- Checkout: payment-method picker (PAYMOB / TRANSFER / COD per availability from `GET /checkout/options`), address form, `Idempotency-Key`.
- Transfer flow: instructions screen (receiving accounts, amount, `paymentCode`), proof upload, status screen.
- Order screens: read `paymentMethod`, `paymentStatus`, shipment status; stop hard-coding `paymentMethod: 'paymob'` and shipping 0 (`backend.ts:283-287`); handle unknown future statuses gracefully (default label instead of a crash).
- Auth: single-flight refresh; SecureStore.

## 9. Contract and parity tests

| Test | What it proves |
|---|---|
| OpenAPI snapshot test | no unreviewed contract change (diff must be approved in PR) |
| Legacy shape tests | empty-body `POST /checkout` response fields; `GET /orders` row fields; status ∈ six legacy values |
| Parity suite (C-MC1) | every checkout/payment/cancel scenario run once with mobile transport (body tokens) and once with web transport (cookie + CSRF) → identical status codes, bodies (ignoring ids/timestamps) and end state |
| Session tests | reuse on device A revokes only A's family; device B keeps working (R23 regression) |
| Idempotent replay tests | same key replays; different body → 422; key scoped per user |
| `X-Client` test | changing the header changes no response or state |
