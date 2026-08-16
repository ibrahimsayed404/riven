# Riven Mobile (React Native / Expo) — Architecture Spec

## Navigation
- **Expo Router** (file-based), not React Navigation configured by hand — less boilerplate, matches Next.js mental model for the same team building the web app.
- Top-level structure:
```
app/
  (auth)/login.tsx, register.tsx
  (tabs)/
    discover.tsx        # map/list toggle, the main screen
    following.tsx
    profile.tsx
  bazaar/[id].tsx        # bazaar detail + isometric map
  vendor/[id].tsx        # vendor profile
  booth-editor/...       # NOT in mobile — organizer web-only per spec §5, omit entirely
```

## State management
- **Server state**: TanStack Query (React Query) for everything that comes from the API — bazaars, vendors, feed. No Redux for this; API responses are the source of truth, cache invalidation on mutations (follow/favorite/rate) via query invalidation, not manual store updates.
- **Client-only state** (map viewport, active filters, logged-in-user session): Zustand — small, no boilerplate, fine for the little that isn't server state.
- **Auth tokens**: `expo-secure-store`, never AsyncStorage (refresh tokens are sensitive — see auth spec). Access token kept in memory + rehydrated from secure store on app boot; refresh handled by an axios/fetch interceptor that retries once on 401.

## Consuming `packages/types`
- Types generated from Prisma (per spec doc §12) live in `packages/types`, imported directly: `import type { Bazaar, Vendor } from '@riven/types'`.
- API response wrapper types (`ApiSuccess<T>`, `ApiError`) also belong in `packages/types` — written once, shared by RN, Next.js web, and the portal, so a backend response-shape change is a single-package version bump, not three separate manual syncs.

## Map rendering
- Isometric map component is **shared logic, platform-specific renderer**: the pure math (grid → screen coordinates, booth positioning) lives in `packages/map-core` as plain TypeScript with zero React/RN imports. RN renders it via `react-native-svg`; web renders the same data via plain SVG. This is what makes "same data renders identically on RN, web, portal" (spec §5) actually true instead of aspirational — see the map spike brief for why this needs proving out before real map screens are built.

## Push notifications
- Expo push token registered on login, sent to `POST /users/me/push-token`. Fan-out is entirely a backend concern (BullMQ, per architecture doc) — mobile only registers the token and handles the three notification types as deep links (`bazaar/[id]`, etc.) on tap.

## Non-goals for v1 mobile build
- No offline mode / local persistence beyond React Query's in-memory cache.
- No deep universal-link handling beyond the three notification types above.
- No tablet-specific layout.
