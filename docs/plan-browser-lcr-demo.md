# Plan: working in-browser road-hazard demo (GEFS LCR over US freeways)

## Context

The data side of this project is done and verified (`scripts/verify_join.py`):
freeway geometry + baked GEFS pixel indices live in `data/freeways_path.parquet`
(2,650 segments) and `data/freeway_hexes_r5.parquet` (5,952 res-5 cells with
`gefs_i/j`). What's missing is the browser half — the "Next" block in `NOTES.md`.

Two reference apps frame the build:
- **alukach/firesmoke** — zarrita.js + Web Worker (chunk fetch + zstd decode) +
  deck.gl + MapLibre, reading a Zarr v3 store on Source Coop. Renders the field
  as a raster. **No vector join.**
- **`deck.gl-raster/examples/dynamical-zarr-ecmwf`** (vendored) — the same stack,
  but with a reusable **`@developmentseed/deck.gl-zarr` `ZarrLayer`** that fetches
  spatial chunks **lazily per viewport**, decodes in workers, stacks all
  `lead_time` frames as a `Texture2DArray`, and runs a **GPU shader pipeline**
  (`SampleTexture2DArray → FilterRange → LinearRescale → Colormap`) per tile.

Both read large stores live in the browser without loading everything up front —
chunks stream on demand. We mirror that architecture. The one thing this project
adds that neither reference has: a **road-hazard model** and a **vector join** —
freeways colored by a real index, pickable.

**Hazard model — LCR (Loss-of-Control Risk), `https://icyroadsafety.com/lcr/`.**
An established, documented 0–12 driving-hazard scale (forecast mode; the
realtime-only "surprise event" +3 is dropped) combining temperature, precip
type/intensity, and wind — not an invented formula. Every input exists in the
`noaa-gefs-forecast-35-day` store (`v0.2.0.zarr`), confirmed:
`temperature_2m`, `relative_humidity_2m`, `precipitation_surface`,
`percent_frozen_precipitation_surface`, `categorical_{snow,freezing_rain,ice_pellets,rain}_surface`,
`wind_u_10m`/`wind_v_10m`, `total_cloud_cover_atmosphere`. (LCR is winter/ice-biased:
it only activates when cold + precip. Implemented as published for v1; a warm-rain
hydroplaning + high-wind extension is a documented follow-on toggle, not v1.)

**Store facts that drive the design** (from `scripts/inspect_gefs_zarr.py`):
- dims `(init_time=2065, ensemble_member=31, lead_time=181, lat=721, lon=1440)`,
  chunks `(1, 31, 64, 17, 16)`, blosc-zstd. Regular 0.25° lat/lon grid,
  lon −180→179.75, lat 90→−90. Pixel index is closed-form (already baked).
- A spatial chunk bundles **all 31 members × 64 lead steps × a 17×16 tile**.
  Lazy per-viewport tiling (as the ECMWF example does) keeps fetches bounded to
  the visible CONUS tiles, not the globe.
- v1 pins **ensemble member 0** (control run), exactly like the ECMWF example
  (`ENSEMBLE_MEMBER_IDX = 0`). "% of 31 members hazardous" is a fast-follow that
  reuses the same fetched chunks (all 31 members are already in each chunk).
- Time: open store, pin `init_time[-1]` (latest run), animate `lead_time`
  (181 steps, +0h→+840h). No init picker for v1.

## Approach

Fork `deck.gl-raster/examples/dynamical-zarr-ecmwf` into `web/` as the app, then
make three changes: (1) read **8 bands** instead of 1, (2) compute **LCR on the
GPU** from those bands, (3) overlay the **freeways** (PathLayer) and **pickable
freeway hexes** (H3HexagonLayer) colored by the same LCR, with picking showing the
per-cell breakdown.

This satisfies "display them as raster but pickable": the GEFS LCR field renders as
a raster (`ZarrLayer`, not natively pickable per pixel), and the freeway
**H3HexagonLayer** sitting on top **is** natively pickable — click a hex → its LCR
value, which factors fired, and (fast-follow) member spread.

### Step 1 — scaffold the app (`web/`)
- Copy the example into `web/` (Vite + React 19 + react-map-gl/maplibre +
  deck.gl 9 + zarrita + `@developmentseed/deck.gl-zarr` + `deck.gl-raster`).
  **Use npm, not pnpm** — `@developmentseed/deck.gl-zarr` and
  `@developmentseed/deck.gl-raster` are published (registry `0.7.0`), so pin
  `^0.7.0` instead of the example's `workspace:` protocol. The only non-published
  dep, `deck.gl-raster-examples-shared`, is just the `DeckGlOverlay` wrapper —
  **inline it into `web/`** rather than depend on it. `web/` is a standalone npm
  app, decoupled from the vendored monorepo. (If a used `gpu-modules`/`ZarrLayer`
  export is missing at `0.7.0`, bump or vendor that one file.)
  Keep `vite.config.ts`, `index.html`, `main.tsx`, the MapLibre style, and the
  `DeckGlOverlay` wiring (inlined). Reuse `metadata.ts` verbatim — its grid/affine
  (`spatial:transform [0.25,0,-180,0,-0.25,90]`, shape `[721,1440]`) is the GEFS
  grid. Replace the ECMWF lead schedule with the GEFS one (181 steps: 3-hourly
  0–240h, 6-hourly 243–840h).
- Set `ZARR_URL = https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr`.

### Step 2 — open and read the 8 LCR input bands
- Generalize `App.tsx`'s single-array open into opening the 8 named arrays
  (`zarr.open.v3(root.resolve(name))`). Default `initTimeIdx = shape[0]-1`.
- Generalize `selection.ts` `buildSelection` (pin `init_time`, pin
  `ensemble_member=0`, keep `lead_time` null) — used for every band.
- Generalize `get-tile-data.ts`: instead of one `Texture2DArray`, fetch the same
  `sliceSpec` for all 8 arrays and upload **8 `Texture2DArray`s** (one per band),
  each depth = 181. (Bands share the identical chunk grid, so one tile's
  `sliceSpec` is valid for all.) `byteLength` = sum across bands.
- Reuse the example's tuning: `maxRequests: 20`, `maxCacheSize` small (bands are
  8× heavier — start at 4 and adjust), `id` keyed on `initTimeIdx`.

### Step 3 — LCR GPU shader module (`web/src/gpu/lcr.ts`)
- New `ShaderModule` modeled on `gpu/sample-texture-2d-array.ts` +
  `gpu/filter-range.ts`. Inputs: the 8 band textures + `layerIndex` (current
  lead). It samples each band at `layerIndex`, applies the LCR ladder, writes the
  0–12 score into `color.r`:
  - activation gate (temp ≤ 38°F snow / 36°F other, wet-bulb approx from temp+RH,
    QPF>0), base LCR from QPF/snow-amount bins, cumulative `+` factors
    (below-freezing, critical-icing 20–30°F, freezing-rain/ice flags, de-icing
    latitude bands), clear-sky cap (cloud cover <10% → ≤3), northern-snow cap (≤7).
    Wind term: 10 m speed `sqrt(u²+v²)` as a gust proxy (>20 mph & LCR≥5 → +1).
  - Convert °C→°F and precip rate (kg m⁻² s⁻¹)→hourly QPF inline.
- Render pipeline becomes `[LCR(8 textures, layerIndex), FilterRange?, Colormap
  (0..12)]` — drop `LinearRescale`/`SampleTexture2DArray`; `LCR` writes the final
  scalar. Reuse `Colormap` from `deck.gl-raster/gpu-modules` with a hazard ramp
  and `rescale 0..12`.

### Step 4 — freeway overlay + the vector join (pickable)
- Emit two small static files from a tiny build step (extend
  `build_freeway_parquets.ipynb` or a 20-line script) into `web/public/`:
  - `freeways.json` — `{seg_id, path:[[lon,lat]…], h3_r5}` per segment (~6 MB).
  - `hex_pixels.json` — `{h3_r5, gefs_i, gefs_j}` for the 5,952 cells (tiny).
  GeoJSON/JSON keeps v1 free of parquet-wasm (NOTES open question → defer wasm).
- `H3HexagonLayer` (`@deck.gl/geo-layers`) over the freeway hexes:
  `getHexagon=h3_r5`, `pickable: true`, `getFillColor` = hazard ramp of the
  per-hex LCR. `PathLayer` (`@deck.gl/layers`) over `freeways.json` for the road
  ribbon, `getColor` from the same per-hex LCR via `h3_r5` lookup.
- **Per-hex LCR for color + picking** is computed in **JS**, not the GPU (the GPU
  path colors the raster field; the vector layers need values at the 5,952 hex
  pixels). Sample the fetched band chunks at each hex's `gefs_i/j` for the current
  lead and run the same LCR ladder in TS (`web/src/lcr/compute.ts` — a plain-JS
  twin of the shader, single source of truth for the thresholds). 5,952 cells ×
  per-frame is trivial. Picking `getTooltip` shows: LCR value, which factors
  fired, lead hour, init time.
- Layer order: `ZarrLayer` (raster, bottom) → `PathLayer` → `H3HexagonLayer`
  (pickable, top). Reuse the example's `ControlPanel` (play/pause, lead slider,
  colormap, frame duration); drop rescale/filter UI or repurpose to an LCR
  threshold.

### Step 5 — animation + latest-run wiring
- Reuse the example's `requestAnimationFrame` lead-time loop; swap
  `ECMWF_LEAD_TIME_STEP_HOURS` for the GEFS 3h/6h schedule so dwell stays
  constant across the 240h regime change. `leadTimeIdx` drives both the GPU
  `layerIndex` and the JS per-hex sampling, so raster and roads stay in sync.

## Files

Create (all under `web/`, forked from the vendored example):
- `web/src/App.tsx` — 8-band open, layer stack, animation (adapted)
- `web/src/gpu/lcr.ts` — **new** GPU LCR shader module
- `web/src/lcr/compute.ts` — **new** JS LCR (per-hex; mirrors the shader)
- `web/src/gefs/get-tile-data.ts` — multi-band tile fetch (adapted from `ecmwf/get-tile-data.ts`)
- `web/src/gefs/selection.ts`, `web/src/gefs/metadata.ts` — adapted from `ecmwf/`
- `web/src/overlay/freeways.ts` — PathLayer + pickable H3HexagonLayer + tooltip
- `web/public/freeways.json`, `web/public/hex_pixels.json` — emitted static data
- `web/package.json`, `vite.config.ts`, `index.html`, `main.tsx`, `map_style.json` — from example

Reuse unchanged from `deck.gl-raster`:
- `@developmentseed/deck.gl-zarr` `ZarrLayer`; `deck.gl-raster/gpu-modules`
  `Colormap`/`createColormapTexture`/`decodeColormapSprite`; `gpu/filter-range.ts`
  pattern; `DeckGlOverlay` from `deck.gl-raster-examples-shared`.

Build-side (reuse existing):
- `scripts/verify_join.py` thresholds → port LCR ladder consistently.
- `build_freeway_parquets.ipynb` → add a cell emitting the two `web/public/*.json`.

## Verification

1. **Python parity first (no browser):** extend `scripts/verify_join.py` (or a
   new `scripts/verify_lcr.py`) to read the 8 bands for `init_time[-1]`, member 0,
   one lead, compute LCR per res-5 hex, and render `data/verify_lcr.png` (freeways
   colored by LCR). Sanity: LCR ∈ [0,12]; cells with no precip or warm temps → 0;
   a cold+precip region lights up. This is the ground truth the JS/GPU must match.
2. **JS↔Python parity:** in the app, log per-hex LCR for a fixed lead and assert
   it matches `verify_lcr.py` within rounding (the shader and `compute.ts` share
   the ladder; this catches °C/°F and unit-conversion drift).
3. **App runs:** `cd web && pnpm install && pnpm dev`; confirm — raster LCR field
   over CONUS, freeways/hexes colored, animation over 181 leads, **clicking a hex
   shows the LCR breakdown tooltip**, latest init auto-selected.
4. **Network sanity:** DevTools shows chunk fetches scale with viewport (pan/zoom),
   not a single multi-hundred-MB up-front load — confirming lazy tiling works as in
   the references.

## Out of scope for v1 (documented follow-ons)
- Ensemble reduction "% of 31 members ≥ threshold" (chunks already hold all 31).
- Warm-season hydroplaning + standalone high-wind extension to LCR.
- res-7/8 ribbon rebuild + tiling (current res-5 parquets are enough for the demo).
- parquet-wasm path for freeway geometry (JSON is fine at this size).
