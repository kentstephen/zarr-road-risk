# Plan — Hazard × Infrastructure Hex Map (animated)

> Status: design / not started. Standalone plan; does not modify existing files
> (`python-workflow/`, the `deck.gl-raster/` clone, the ctrees notebooks).

## One-line concept

Threshold a weather forecast time series, intersect with the H3 hexes that
contain infrastructure, and **light up the affected hexes — animated over the
forecast lead time.** No damage model, no risk index. Two binary conditions:

```
affected(hex, t)  =  (hazard(hex, t) > threshold)  AND  (hex has infrastructure)
```

Optionally grow the affected set with H3 neighbor traversal (see below).

## Why this version

- Sidesteps the icechunk problem entirely: the weather is a **plain Zarr v3**
  store that already loads in the running deck.gl example.
- H3 is global lat/lon-native → **no reprojection layer to build.** Drop-in
  `H3HexagonLayer`.
- "Risk not modeling": it's a **descriptive** map (exposure under a hazard),
  not a predictive one. Removes the only hard/contestable piece (a vulnerability
  / damage function).
- Reads instantly: *"built-up / road-covered areas about to be hit by the
  forecast [cold / wind / heat] over the next N days."*

## Resolution decision — multi-res, LOD by zoom

- **Precompute res 5, 6, 7, 8** offline; **swap resolution by zoom level.**
  Coarse (5/6) when zoomed out, fine (7/8) when zoomed in.
- Fine res is justified **only because the colored signal is infrastructure, not
  weather.** A weather-colored hex map at res 7/8 would be fake detail (one 0.25°
  weather cell spans ~150 res-7 hexes); an infra-driven one carries real signal.
- **MVP scope: CONUS.** Widen later. Weather-side clip is just a lon/lat `.sel()`.

### CONUS cell counts (all land-covering; infra-only is a subset)

| res | cell area | CONUS cells | ship/render |
|-----|-----------|-------------|-------------|
| 5 | ~253 km² | ~32k | trivial, ship whole |
| 6 | ~36 km² | ~224k | easy, ship whole |
| 7 | ~5.2 km² | ~1.57M | borderline; OK with GeoArrow + tiling |
| 8 | ~0.74 km² | ~11M | **too heavy whole — must tile by H3 parent** |

## Browser-weight strategy (the real constraint)

- **Render with the GeoArrow H3 layer** (`@geoarrow/deck.gl-layers`), which takes
  the **uint64/bigint H3 index in a binary Arrow column** — no per-feature JS
  objects, GPU-instanced. Does ~1M+ hexes/frame. The classic `H3HexagonLayer`
  chokes around a few hundred k; do not use it here.
- **Payload math:** hex id (8B) + value (4B) = 12 B/cell. Res 7 CONUS ≈ 18 MB raw
  / single-digit MB as zstd parquet-arrow. Res 8 ≈ 130 MB raw → never ship whole.
- **Tile the heavy levels by H3 parent.** Pick a coarse tile resolution (~res 3),
  group children under each parent, load only parent tiles in the viewport.
  Same idea as a `TileLayer` but keyed on the free H3 parent/child hierarchy.
- **No DuckDB-WASM / no query engine in the browser.** Runtime just loads static
  GeoArrow/parquet and renders.

## Tooling

- **Offline precompute: `h3o` (Rust)** — fast H3 reimplementation. One pass over
  Overture → cells at res 5/6/7/8 + neighbor/buffer sets. (DuckDB native is fine
  for the ETL too; the constraint is only "no DuckDB-**WASM** at runtime".)
- **Client: GeoArrow deck.gl H3 layer** (bigint h3) + the example's MapLibre/slider.
- Data is **static** → precompute everything; nothing computed in the browser
  except optionally `gridDisk(k)` over the viewport subset (h3-js / h3o-wasm) if
  the buffer radius `k` is a live UI knob.

## Data layers

### 1. Exposure (static) — Overture
- Source: Overture Maps (GeoParquet).
  - **Transportation theme** → roads. Clean scalar = road-length-km per hex;
    continuous coverage (no empty hexes).
  - **Base/Buildings theme** → structure counts (sparser, "how many structures").
  - Prep both; toggle in UI. Decide later which is the headline.
  - **Highways / major roads** as a separate, sparser class — good headline layer
    (uniform global coverage, "transit disruption" reads clearly).
- Aggregate to H3 **res 5/6/7/8** offline with `h3o` (Rust) or DuckDB native,
  CONUS bbox filter. Overture worldwide coverage is good enough for the demo.
- Degenerate form for the simplest demo: a flat **set of hex IDs that contain any
  infrastructure** (a static mask). Keep counts only if coloring by intensity.
- Output: one GeoArrow/parquet per resolution, e.g.
  `infra_hexes_conus_r{5,6,7,8}.arrow` → `(h3 uint64, road_km, major_road, building_count)`.
  Res 8 split into per-H3-parent tiles.

### 2. Hazard (time series) — weather Zarr
- Want a **different but similar dataset** than the ECMWF example, to show
  real-time forecast driving the infra map. Options:
  - **HRRR** (NOAA High-Res Rapid Refresh) — **3 km, CONUS-only, hourly,
    near-real-time.** Best match: 3 km ≈ res-7 scale, so it *justifies* the fine
    hexes instead of upsampling a coarse field. Caveat: confirm a Zarr source the
    browser can range-read (NOAA ships GRIB on AWS; Zarr mirrors exist).
  - **NOAA GEFS 35-day** (source.coop) — known-good plain Zarr v3 fallback, but
    coarse (~0.25°), so hazard edge stays blocky regardless of hex res.
  - ECMWF IFS ENS 15-day — already wired; coarse, same blocky-edge caveat.
- Per lead-time frame: a gridded variable (2 m temp, wind, precip…).
- **Bilinear-interpolate** the field onto hex centroids so the threshold boundary
  sweeps smoothly. (Less critical with HRRR's 3 km grid; essential at 0.25°.)

### 3. Impact (animated) — the intersection
- Per frame `t`: `hazard(hex,t) > threshold` ∩ `infra_hexes`. Color/light those.

## H3 neighbor traversal (spillover / buffer)

If one cell is affected, neighbors likely are too. Use H3 grid functions:

- `gridDisk(cell, k)` — grow each affected cell by `k` rings. Cheap proxy for
  **both** forecast spatial uncertainty **and** impact spillover (e.g. a hit
  corridor drags in adjacent cells).
- `gridDistance(a, b)` — falloff: fade intensity by ring distance from the core
  affected set (k=0 full, k=1 dimmer, …).
- Use it to (a) smooth/dilate the hazard mask edge, and (b) optionally propagate
  along infra — start from affected infra cells and `gridDisk` outward to flag
  at-risk neighbors.
- Knob in UI: `k` (buffer radius in rings).

## Live stats & interaction (the CDL-dashboard pattern)

Data access is **solved**: source.coop + dynamical serve range-readable Zarr to
the browser (no server, no icechunk). deck.gl-raster adds **picking** and
**vectorization**, which turn this from an animation into a live-stats dashboard
— the same shape as the Cropland Data Layer dashboard, swapping a static crop
raster + drawn AOI for a moving forecast raster + threshold mask.

- **Picking:** hover/click a hex → infra count + current-frame hazard value;
  hover the weather raster → hazard value at cursor. GeoArrow H3 layer supports
  picking on the bigint index.
- **Live affected count:** updates every animation frame, e.g.
  *"42.3k hexes / 18.4k km highway over threshold at +111 h."* Plus a sparkline
  of the count across lead time, and optional per-state breakdown.
- **Viewport = query:** pan/zoom recomputes stats for what's on screen — the
  "moveable box" comes free from picking + viewport bounds.

**Two ways to compute the count (pick one deliberately):**
1. **Sample hazard at hex centroids → filter.** Infra is already H3, so just read
   the raster value per visible hex and count over threshold. Less work, no
   vectorize→join round trip. Likely the default.
2. **Vectorize hazard → spatial-join infra.** Uses deck.gl-raster vectorization to
   turn the thresholded frame into an affected-polygon, then intersect. More
   raster-native; yields a reusable/exportable affected-region geometry.

## Architecture

```
Overture GeoParquet ──DuckDB(h3)──► infra_hexes_na.parquet   (static, once)
                                            │
weather Zarr (NA slice) ──per frame──► hazard mask(t)        (per lead time)
                                            │
                          intersect + gridDisk(k) ──► affected hexes(t)
                                            │
                              deck.gl H3HexagonLayer + time slider/animate
```

## Build path (two tiers)

### Tier A — baked playback (fastest "is this compelling" test, ~1 day)
1. DuckDB: Overture → `infra_hexes_na.parquet` (res 7).
2. Python: pull weather (NA slice), threshold per frame, intersect with infra,
   optional `gridDisk(k)`, emit sparse `(hex_id, t, on)` table (only lit hexes).
3. Drop the table into **kepler.gl** — free time-playback animation + draggable
   map, **zero frontend code.** Judge whether it's worth the live build.

### Tier B — live deck.gl app (the "real" version)
1. Fork the running `dynamical-zarr-ecmwf` example.
2. Add `H3HexagonLayer` fed by `infra_hexes_na.parquet` (load once).
3. On each frame: sample/interpolate weather at hex centroids, threshold,
   `gridDisk(k)`, set `getFillColor` / visibility.
4. Reuse the existing lead-time slider + play/pause for animation.
5. UI knobs: variable, threshold, `k` (buffer rings), exposure layer (roads/bldgs).

## Honest caveats (keep in framing)

- **Descriptive, not predictive.** Shows exposure under a hazard, not expected
  failures. The "exposed → affected" gap is exactly the modeling we skip.
- **Coarse + uncertain hazard.** 0.25° ensemble → real spatial spread. A hard
  threshold on the ensemble mean makes boundary hexes flicker on a forecast that
  isn't that precise. Don't present on/off as certainty. Later softening:
  "% of ensemble members over threshold" instead of a binary mask.
- **Crowded genre** (FEMA NRI, insurers). Edge is execution — live forecast +
  serverless + the animation feel — not a novel risk method.

## Open decisions

- Exposure layer: highways/major roads, all roads, buildings, or toggle?
- Hazard variable + threshold(s): temp / wind / precip; single or multi?
- Weather store: HRRR (best CONUS fit, needs Zarr source) vs GEFS 35-day (safe).
- Tier A baked playback first, or straight to Tier B live app?
- Resolution-by-zoom breakpoints (which res at which zoom).
- Is the buffer radius `k` a fixed bake or a live UI knob?
- Live count method: sample-at-centroids (default) vs vectorize-then-join.
- Stats panel scope: live affected count, lead-time sparkline, per-state breakdown?

## Locked for MVP

- Extent: **CONUS**.
- Multi-res precompute: **5/6/7/8**, LOD by zoom, res 8 tiled by H3 parent.
- Render: **GeoArrow deck.gl H3 layer** (bigint h3). No DuckDB-WASM at runtime.
- Offline precompute with **h3o (Rust)**; data fully static.
