# TODO

Tracked follow-ups from the browser LCR demo work. Captured 2026-05-28.

## Next session (Stephen, end of 2026-05-28)

- **App as SQL backend, not just a pickable map.** The interesting move is
  vectorizing the LCR field into queryable rows — "which roads are at risk
  right now?", "which roads in New Hampshire are at risk over 2026-01-12 to
  2026-01-15?". Picking is a UI affordance for the same underlying data;
  the real value is the query surface. Sketch already exists in the
  "Backend" section below.
- **Road visuals need a rebuild.** Today's Natural Earth `Freeway/Tollway`
  segments don't look good — thin, fragmented, no name affordance.
  Two directions to compare tomorrow:
  - **Polyfill the H3 corridor cells** and render those instead of (or as
    a backdrop for) the line segments. Whole-cell color reads stronger
    than 2 px polylines at zoom 3–4.
  - **Overture motorways CONUS, side-by-side with Natural Earth.** Pull
    Overture's `transportation` motorways for CONUS, render in parallel
    with the current NE layer, compare. Overture brings `names.primary`
    + canonical road IDs we can carry through picking / queries.

## Visualization

- **Raster framing post-HRRR swap.** With `beforeId: "water"` the HRRR
  raster only paints on land. Reads as confusing on its own — the Lambert
  grid's straight edges along the Canadian / Mexican borders look like data
  artifacts, and there's no visual cue that the field is bounded by the
  HRRR domain (not the basemap). Options: (a) draw a faint CONUS outline so
  the cutoff reads as intentional, (b) fade raster opacity near the HRRR
  grid edges, (c) keep an over-water raster at lower opacity to communicate
  "forecast field, CONUS only".
- **Control panel rewrite.** Out of scope for the HRRR swap; revisit once
  the data layer is settled. Header still says "GEFS LCR".
- **Temperature colormap → diverging cool→warm.** Today every band uses
  ColorBrewer `blues` (sequential). Temperature needs Kepler-style
  cool-to-warm: deep blue cold, white neutral, deep orange hot. Precip stays
  sequential blues — that's fine.
- **Highway color ramp.** Stephen can't see red. Rework the LCR ramp so:
  - Unaffected (LCR = 0) → lower opacity than today's silver baseline so
    they recede further.
  - Most affected (LCR ≈ 12) → **deep orange**, not red.
  - Mid-range → tighter contrast so the worst hexes pop, not a smooth pastel
    fade.

## Data / ETL

- **Re-emit `web/public/*.json` after the latest ETL run.** Stephen re-ran
  `build_freeway_parquets.ipynb` on 2026-05-28; the data parquets are fresh
  but the in-app JSONs (May 28 14:26) still reflect the prior run.
  Command: `uv run python scripts/emit_web_json.py`.
- **All-NA freeways + country + state in the schema.** Drop the CONUS-only
  filter on Natural Earth highways. The GEFS zarr covers all of North
  America (and globally), so the build should keep Canada + Mexico. Carry
  `country` + `state/admin1` columns through to the hex parquet and the
  emitted JSONs so picking can show them.
- **Overture motorways join.** Plan the join from our Natural Earth hex /
  path table → Overture `transportation` to pick up canonical road names
  (`highways.primary`) and improved geometry. Interacts with the previous
  todo.

## Verification

- **Vet that LCR actually fires.** Stephen's intuition: in the mid-Jan 2026
  window we're staring at, there were sub-freezing temps over much of the
  country with standing water — LCR should be lighting up freeways visibly,
  but it doesn't feel like it. To verify:
  1. Pick a known winter date.
  2. Server-side: sample N hex pixels through `scripts/verify_lcr.py`.
  3. In-browser: log JS LCR at the same hexes.
  4. Cross-check. If JS != Python → ladder ports drifted. If both = 0 →
     the activation gate is too strict for the source forecast data and
     needs loosening.

## Backend

- **App as SQL backend for date-range queries.** "Which freeway hexes are
  affected by LCR ≥ N for init T, leads X–Y?" The current parquets + zarr
  have everything needed. Sketch:
  - Pre-compute per-hex LCR for a date range; store as parquet keyed
    `(init_time, lead_time, h3_r5) → lcr`.
  - Expose via DuckDB or a tiny FastAPI service.
  - Hooks into the existing `freeway_hexes_r5.parquet` join.

## Performance

- **Raster load speed.** Today's single-band raster + 1.2 s-delayed,
  3-concurrent LCR side channel is faster than the prior 8-band fetch but
  still feels slow compared to the dynamical ECMWF example. Open
  questions:
  - WASM decoder (blosc + zstd) cold-cache cost on first load.
  - 17 MB `freeways.json` blocking the PathLayer.
  - source.coop request budget while the side channel is running.

## Deploy

- **GitHub Pages.** Deploy `web/` as a static site. Set Vite `base`
  appropriately and add a workflow that runs `npm run build` and uploads
  `web/dist`.
