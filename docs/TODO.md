# TODO

Tracked follow-ups from the browser LCR demo work. Captured 2026-05-28.

## In progress (2026-05-29) — app as a queryable backend

Goal: app becomes a **backend**, not a picking UI. A right-hand-side table of
roads-affected-by-state, computed live (works "as if opening during a
developing storm"), and queryable outside the viz on the CLI with DuckDB.
Decisions locked this session:

- **In-browser reader = hyparquet (hyparam), NOT duckdb-wasm.** The table has
  to move fast; hyparquet reads the parquet columnar over HTTP, no 30 MB wasm.
  hyparquet-compressors for zstd; hyparquet-writer if we want in-app export.
- **The parquet is the shared artifact.** App reads `data/road_table.parquet`
  via hyparquet; CLI reads the *same file* via `duckdb -c "from
  'road_table.parquet'"`. No server (MVP = duckdb in-memory).
- **Road names + state via Overture join** (H3 columnar first, spatial sjoin
  fallback). State comes from Overture `division_area` (`subtype='region'`) —
  Stephen OK'd Overture divisions over Natural Earth since it's easier.
- **No ramps.** Overture flags ramps in `road_flags` containing `is_link`
  (NOT `subclass`). Filter them out in the motorway query.
- **US-only.** HRRR is essentially CONUS (marginal MX/CA overlap we don't
  care about), and cell 9 of the hex notebook clips to the HRRR grid anyway.
  Keep the `country == "United States"` filter in build_freeway_parquets.

Done this session:
- `scripts/build_road_table.py` — staged ETL. Pulls Overture motorways
  (ramp-filtered) + admin1 regions for the hex bbox via DuckDB (Overture's
  documented pattern: `bbox.xmin BETWEEN ... hive_partitioning=1`), H3-joins
  road names onto our r5 hexes (longest named road per cell), point-in-polygon
  for state, writes `data/road_table.parquet`. Caches Overture pulls.
- `scripts/preview_motorways.py` — fetch + matplotlib PNG of the road network.
- `explore_overture_roads.ipynb` — lonboard `viz(gdf)` of the ramp-filtered
  Overture motorways (the geometry feeding the join).
- Re-ran `build_freeway_parquets.ipynb` → fresh US hexes (5912) / segs (2650).

Still to do on the backend:
- Run `build_road_table.py` end-to-end (the ramp-filtered refetch + join had
  not been run as of session end — kept getting interrupted). Verify state +
  road_name coverage; fall back to spatial sjoin if H3 columnar leaves cells
  nameless.
- Wire hyparquet into `web/` to read `road_table.parquet`; build the live
  affected-roads Arrow/columnar table joined to `hexLcr`.
- Right-hand-side roads-by-state panel; de-emphasize picking.
- "Current storm" button (point init_time at latest cycle); lead-range
  aggregation of `hexLcr` over selected leads.

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
- ✅ **Temperature colormap → diverging cool→warm.** DONE — switched off
  sequential `blues` to a diverging cool→warm ramp; precip stays sequential.
- ✅ **Highway color ramp.** DONE (2026-05-29). Unaffected (LCR=0) silver at
  alpha 38 so it recedes into the dark basemap; affected roads ramp by hue
  only, light orange `(255,175,60)` → burnt orange `(170,65,5)` at full
  opacity. No red. Path width 2→1px to reinforce recession.
  `web/src/lcr/compute.ts:lcrColor`, `web/src/overlay/freeways.ts`.

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

- ✅ **Vet that LCR actually fires.** DONE (2026-05-29). Confirmed visually
  in-app — LCR lights up affected freeways as expected. No drift/gate issue.

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
