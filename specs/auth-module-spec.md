# Auth Module — Build Spec

Everything below is a *requirement*, not code. The agent writes the implementation; I'll review the diff against this spec.

## Scope
`POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, plus the guards/decorators every other module will depend on.

## Folder structure (per architecture doc §2)
```
modules/auth/
  auth.module.ts
  auth.controller.ts
  auth.service.ts        # business logic only
  auth.repository.ts      # ALL Prisma calls, nowhere else
  strategies/jwt.strategy.ts
  strategies/refresh.strategy.ts
  guards/jwt-auth.guard.ts
  guards/roles.guard.ts
  decorators/roles.decorator.ts     # @Roles('vendor')
  decorators/current-user.decorator.ts
  dto/register.dto.ts, login.dto.ts, refresh.dto.ts
```

## Password handling
- Hash with `argon2` (preferred) or `bcrypt` (cost factor ≥ 12) — never store plaintext, never roll a custom hash.
- Password rule: min 8 chars, at least one letter + one number. Don't over-engineer this for v1.

## Token strategy
- **Access token**: JWT, 15 min TTL, signed with `JWT_SECRET`, payload = `{ sub: userId, role }`. Stateless — never hits the DB to validate.
- **Refresh token**: opaque random string (not a JWT), 30 day TTL. Only its hash (sha256) is stored in the `RefreshToken` table — never the raw token.
- On login: issue both tokens, store the refresh token hash.
- On `/auth/refresh`: look up the hash, check `revokedAt IS NULL` and `expiresAt > now`, issue a new access token **and rotate the refresh token** (revoke the old one, issue + store a new one). Rotation is mandatory — it's what makes stolen-refresh-token replay detectable.
- **Reuse detection**: if a refresh token is presented that's already `revokedAt IS NOT NULL`, that's a signal of token theft — revoke *all* refresh tokens for that user (`revokeAllRefreshTokensForUser`) and force re-login everywhere.
- On `/auth/logout`: revoke just that one refresh token.

## Role enforcement
- `role` is set once at registration and is immutable after — no "become a vendor later" flow in v1 (per spec doc: one role per account, two accounts if you need both).
- Public registration must **reject `role: ADMIN`** outright, even if a client sends it — validate this in the service layer, not just the DTO enum, since DTO-level enum checks don't stop someone constructing an ADMIN registration if the enum accepts it. Admin accounts are created out-of-band (seed script / manual DB insert) only.
- `RolesGuard` reads `@Roles(...)` metadata off the route and compares against `request.user.role` (populated by `JwtAuthGuard` from the access token payload). 403 with `code: 'FORBIDDEN_ROLE'` on mismatch.

## Error responses (per architecture doc §4 format)
- Wrong email/password → `401 { code: 'INVALID_CREDENTIALS' }` — **same message whether the email doesn't exist or the password is wrong.** Never reveal which one failed; that's a user-enumeration leak.
- Expired/revoked/unknown refresh token → `401 { code: 'INVALID_REFRESH_TOKEN' }`.
- Email already registered → `409 { code: 'EMAIL_ALREADY_IN_USE' }`.

## Explicit non-goals for v1 (don't build these — flag if the agent tries to)
- No email verification flow.
- No password reset flow (add later, not blocking).
- No OAuth/social login.
- No multi-role accounts.

## Definition of done
- All four endpoints working against the real Postgres (docker-compose), not mocked.
- `@Roles()` + `JwtAuthGuard` usable by any future module by just adding the decorator — zero changes needed to auth module itself.
- Unit tests for: password hashing round-trip, refresh rotation, reuse-detection revocation, role rejection on register.
- E2E test for the full register → login → refresh → logout happy path.
