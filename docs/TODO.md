# TODO

Tracked follow-ups from the browser LCR demo work. Captured 2026-05-28.

## Visualization

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
