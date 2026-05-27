# zarr-road-risk — session notes

## Renames (this session)
- `ctrees-earthmover/` → **`zarr-road-risk/`** (folder + local git repo; no remote).
  - Reopen this folder in your editor — the old path no longer exists, so an
    editor window still pointed at `ctrees-earthmover` will look empty.
- `python-workflow/` → **`python-workflow-ctrees/`** (the ctrees notebooks).

## Layout
```
zarr-road-risk/
├── overture_motorways.py        # marimo: Overture motorways → CONUS GeoParquet
├── python-workflow-ctrees/      # ctrees notebooks (cheshire, explore, ...)
├── web/src/                     # browser app (empty scaffold)
├── deck.gl-raster/              # cloned dev-seed example (reference)
├── plan-hazard-infra-hexes.md   # the running plan
├── pyproject.toml / uv.lock     # python project stays at root
└── CLAUDE.md                    # STALE — still describes ctrees-only project
```

## Deps added (uv project, latest)
duckdb 1.5.2 · geopandas 1.1.3 · shapely 2.1.2 · pyarrow 24.0.0 ·
lonboard 0.16.0 · marimo 0.23.8. Venv repaired after rename via `uv sync`.

## Run the marimo
```
cd /Users/stephenk/dev/projects/zarr-road-risk
uv run marimo edit overture_motorways.py
```
Click **Fetch CONUS motorways** (S3 scan ~1–3 min, button-gated). Writes
`data/motorways_conus_2026-05-20.0.parquet`.

Overture access verified against release **2026-05-20.0**
(`theme=transportation/type=segment`, `subtype='road'`, `class='motorway'`,
`bbox` struct, anonymous S3 read via duckdb httpfs).

## Build notebook — freeway parquets (DONE this session)
`build_freeway_parquets.ipynb` (kernel `zarr-road-risk`) — pure-local, runs
end-to-end, no network store. Natural Earth `ne_10m_roads_north_america`
→ filter `type ∈ {Freeway,Tollway}` & `country == United States` → h3 → parquet.

Outputs:
- `data/freeways_path.parquet` — 2,650 segments · `seg_id, path[[lon,lat]], h3_r5, type, length_km` · 5.7 MB
- `data/freeway_hexes_r5.parquet` — 5,952 res-5 cells · `h3_r5, lat, lon, gefs_i, gefs_j` · 141 KiB

Sanity: every per-segment cell present in hex table; all `gefs_i/j` in bounds;
pixel round-trip < 0.125°.

### Time axis — settled
- App always uses the **latest forecast**: open store, take `init_time[-1]`, animate
  over `lead_time` (181 steps, +0h→+840h / 35 days). No init_time picker; "latest"
  auto-tracks the current run as dynamical appends. Parquets are forecast-independent
  (geometry + `gefs_i/j` don't depend on init_time) → build once, never rebuild.
- Store confirmed via `scripts/inspect_gefs_zarr.py` (obstore, uv sandbox): uniform
  0.25° grid (1440×721) for ALL lead times, lon −180→179.75 @0.25, lat 90→−90 @−0.25
  — matches hardcoded `GRID`. `init_time` 2020-10-01→present (2065 runs). No 240h cap
  needed for indexing. Vars incl. `temperature_2m` (°C), `wind_u/v_10m` (m/s),
  `precipitation_surface`, `categorical_snow_surface` (0/1).

### Decided / settled
- **No zarr read in Python.** The GEFS grid is a fixed published spec
  (lon −180→179.75 @0.25, lat 90→−90 @0.25, 1440×721). `gefs_i/j` is plain
  arithmetic: `i=(lon+180)/0.25`, `j=(90−lat)/0.25`. Hardcoded as `GRID` in the
  config cell. The **browser** reads the zarr per frame, not Python. (Backed out
  the aiohttp/requests deps added earlier — not needed.)
- Render = lines (`PathLayer`); res-5 hexes only gate hazard color.
- Corridor cells via densify-in-meters + per-vertex h3 (no buffer needed; the
  `ST_Buffer` caveat is only for the DuckDB polygon polyfill path).

### Pipeline VERIFIED end-to-end (Route A) ✅
`scripts/verify_join.py` (run: `uv run --with obstore python scripts/verify_join.py`)
proves zarr → hex pixel → road color before any browser work. All checks PASS:
- baked `gefs_i/j` == xarray `.sel(method="nearest")` lookup (indices correct)
- `temperature_2m` values physically plausible; every segment got a value
- renders `data/verify_join.png` — recognizable US freeway net, sensible temp gradient
Reads ONE 2D field (~4 MB, latest init, member 0, chosen lead) via obstore — fast,
no fsspec/aiohttp. `scripts/inspect_gefs_zarr.py` dumps store metadata the same way.

→ Data side is DONE. Browser is now translation, not design:
  1. fork `deck.gl-raster/examples/dynamical-zarr-ecmwf`, swap URL → GEFS v0.2.0
  2. load `freeways_path.parquet` → PathLayer; pick `init_time[-1]`
  3. per frame: read lead slice, sample at `gefs_i/j`, threshold, color by `h3_r5`
  OPEN: how path data enters browser (parquet-wasm vs emit Arrow IPC / GeoJSON;
  hex table is tiny → inline as JSON).

### Docs moved to `docs/`
`plan-build-parquets.md`, `h3-res-and-readpath.md`, `plan-hazard-infra-hexes.md`.

## Next (open thought — not started)
- **Inspect data via Kyle's deck.gl example to define the runtime analytics shape.**
  Kyle's `deck.gl-raster/examples/dynamical-zarr-ecmwf` reads a dynamical zarr
  directly in TS (`src/App.tsx`: `ZARR_URL = data.source.coop/dynamical/
  ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr`, opened with
  `zarr.withConsolidatedMetadata` + `zarr.open.v3`). GEFS 35-day equivalent store:
  `https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr`
  (v0.2.0 confirmed 200). Open question: do the per-frame data-analytics
  (threshold, % members over threshold, affected count) live in that JS/TS
  runtime, or somewhere else? → look at the example's TS to decide the format.
- Rewrite `CLAUDE.md` for the zarr-road-risk direction (still STALE).
```
