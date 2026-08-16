# Riven Mobile — Visual Design Spec (v1)

This translates the approved reference mockups (Discover feed, bazaar booth map, vendor profile) into concrete rules for implementation. This is a **styling pass on existing, working screens** — no new features, no new data, no new routes. Every screen listed already functions correctly (per the mobile architecture work); this spec only changes how they look.

## 1. Source of truth for values

All colors/fonts below already exist in `@riven/ui-tokens` — this spec should **consume that package**, not redefine values inline. If a needed token is missing from `@riven/ui-tokens` (e.g. a specific shade of coral for hover/pressed states), add it there first, don't hardcode hex values in component files.

## 2. Color usage rules (from the reference images)

- **Deep Indigo (`#1E2A44`)**: primary screen background for immersive/discovery contexts (Discover feed, bazaar detail/map). Not used as a text color on light backgrounds.
- **Soft Cream (`#F8F6F2`)**: card backgrounds, bottom sheets, and screens that are primarily informational/form-based (vendor profile page background is cream, not indigo — note this contrast between screen types, it's intentional in the reference).
- **Warm Coral (`#FF6B5E`)**: reserved for primary actions and selection states only — "Explore" buttons, "Follow" button, the selected booth on the map, active tab indicator. Do not use coral for decorative purposes or large fill areas; it should always mean "this is interactive/selected."
- **Charcoal (`#2A2A2A`)**: body text on light backgrounds.
- On dark (indigo) backgrounds, primary text is cream/white, secondary text is cream at reduced opacity (~60-70%) — see the "1.2 km" distance badge and event subtext in the reference for the muted-text pattern.

## 3. Typography rules

- **Plus Jakarta Sans Bold/SemiBold**: all headings, screen titles ("Discover," "Garden Stories Bazaar"), vendor/bazaar names, button labels.
- **Manrope Regular/Medium**: body copy, descriptions, metadata (dates, distances, categories).
- Establish a type scale now, don't let it drift screen to screen:
  - Screen title: 28-32px, Bold
  - Card title: 17-18px, SemiBold
  - Body: 14-15px, Regular
  - Caption/meta: 12-13px, Regular, reduced opacity

## 4. Component patterns (extracted from the reference images — build these as reusable components, not one-off styles per screen)

### Card (`components/shared/Card.tsx`)
- Cream background, rounded corners (~16-20px radius), subtle shadow, used for bazaar cards, event cards, product cards.
- Image on top (rounded top corners matching card radius), content below with consistent padding (~16px).

### Badge/Pill (`components/shared/Badge.tsx`)
- Small rounded-pill shape, dark translucent background on images (e.g. "1.2 km" over a photo), or coral/outlined for status/category tags.

### Primary Button (`components/shared/Button.tsx`)
- Coral fill, cream text, fully rounded (pill-shaped, matching "Explore," "Follow," "View Vendor" in the reference), Plus Jakarta Sans SemiBold label.
- Needs pressed/disabled states — define opacity or slight darken on press.

### Tab Pill (`components/shared/SegmentedTabs.tsx`)
- Used for "Overview / Map / Info" pattern — pill-shaped container, active segment gets a cream rounded-pill background with dark text, inactive segments are transparent with light/muted text. This is a reusable pattern, not specific to the bazaar detail screen — check if other screens need segmented tabs too (e.g. Admin's Pending/Approved/Rejected could reuse this same pattern later).

### Bottom Sheet (`components/shared/BottomSheet.tsx`)
- Cream background, rounded top corners, drag handle indicator at top, used for the booth-detail-on-map-tap pattern. Should be a reusable sheet component since this interaction (tap something on a map/list → sheet slides up with detail + action button) will likely recur.

### Isometric Booth Map styling (within `components/bazaar/BoothMapView.tsx`, wrapping `@riven/map-core`'s `IsometricBoothMapRN`)
- Occupied booths: Soft Cream fill, thin Charcoal outline, label in Charcoal.
- Empty/unassigned booths: Deep Indigo fill (slightly lighter tone than the screen background for subtle contrast), label in muted cream.
- Selected booth: solid Warm Coral fill, white label, no other decoration (no pin/marker overlay — confirmed from the corrected reference).
- **Important implementation note**: the reference image shows a denser, more organic layout than what `@riven/map-core`'s grid-based coordinate system currently produces. Treat the reference for **color/label/selection styling only** — the actual booth positions/spacing come from real `BoothLayout`/`Booth` data via the proven grid math, not from trying to visually replicate the reference's exact arrangement. Do not modify `@riven/map-core`'s coordinate logic to chase the mockup's layout.
- Ensure minimum tap-target size per booth (recommend ≥44x44pt effective hit area per Apple/Android guidelines) even if the visual block is smaller — pad the hit-test area if needed, since the reference shows tightly-packed blocks that would be hard to tap accurately as-is.

## 5. Screens in scope for this pass

Apply the above system to these existing screens (all already functional, per the mobile architecture work):

1. `app/(tabs)/explore.tsx` — Discover feed (matches reference image 1)
2. `app/bazaar/[id].tsx` + `BoothMapView.tsx` — bazaar detail with map (matches reference image 2)
3. `app/vendor/[id].tsx` — vendor profile (matches reference image 3)
4. `app/(tabs)/favorites.tsx` — apply the same Card component, no new reference needed
5. `app/(auth)/login.tsx`, `register.tsx` — apply typography/button/color system, no reference image exists yet; use judgment consistent with the established system (cream background, coral CTA button, Plus Jakarta Sans heading)
6. `app/(tabs)/profile.tsx`, `app/notifications.tsx` — same, apply system consistently

## 6. What this pass does NOT include
- No changes to data fetching, routing, or any business logic
- No changes to `@riven/map-core`'s coordinate/geometry engine — styling only, per §4
- No new screens beyond what already exists
- Vendor-portal and admin styling — separate future pass, not this one

## 7. Verification
1. Visual check: screenshot each of the 6 screens in §5, compare against the reference images/this spec for the 3 that have direct references.
2. Confirm `npx tsc --noEmit` still passes — this is styling, should introduce zero type errors.
3. Confirm no functional regression: re-run through the same interaction proofs already established (discovery feed loads real data, booth tap-and-select still works, follow/favorite still fires) — styling changes should not break any working interaction.
4. Confirm all colors/fonts trace back to `@riven/ui-tokens` — spot check 2-3 components to confirm no hardcoded hex values were introduced.

Please review and confirm before implementation.
