# Isometric Booth Map — Spike Brief

**Goal:** prove the rendering approach works before any real booth-editor or map-screen code is built on top of it. This is a throwaway prototype — expected to be deleted/rewritten, not hardened.

## What to prove
1. **Coordinate transform**: a pure function `gridToScreen(x, y, cellSize) → { screenX, screenY }` that produces a believable isometric (2:1 angled) projection from `Booth.positionX/Y/width/height` grid data. Test with a 10x10 grid of ~20 booths of varying sizes.
2. **Same data, two renderers**: render the *same* `gridConfig` + `Booth[]` JSON through both an SVG web renderer and a `react-native-svg` renderer, side by side. They must look equivalent — this is the actual architectural claim being tested (spec §5: "same data renders identically on RN, web, portal").
3. **Depth/shading without assets**: verify booths can look "premium" (angled top faces, subtle side shading for depth) using only fill/stroke/gradient, no image assets per booth. This is what avoids needing a game engine or per-bazaar manual art.
4. **Performance ceiling**: render 200 booths (large bazaar) and check frame time isn't janky on a mid-range Android device via Expo Go — if it's slow, know that now, not after the real editor is built on the same primitives.
5. **Hit-testing**: given a tap/click at screen coordinates, correctly resolve which booth was tapped (inverse of the grid→screen transform) — needed for both the shopper map (tap a booth → vendor profile) and organizer editor (drag to reposition).

## Explicitly out of scope for the spike
- The drag-and-drop editing UI itself (organizer web builds this after, using the proven primitives).
- Real API integration — hardcode a sample `gridConfig`/`Booth[]` JSON fixture.
- Any vendor/product rendering inside booths — just colored blocks + labels.

## Deliverable
A short throwaway repo/branch with the `gridToScreen`/hit-test math in `packages/map-core` (so it can be lifted directly into the real build if it works), plus one web page and one Expo screen both rendering the same fixture. Report back: does the shared-math approach hold up, or does something force platform-specific logic beyond the renderer layer?

**Do not proceed to the real BoothLayout editor (MVP step 3) until this spike is reviewed.**
