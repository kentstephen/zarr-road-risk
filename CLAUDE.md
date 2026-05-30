# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Purpose

**Zarr Road Risk** — a live road-weather hazard viewer. NOAA **HRRR** 48-hour
forecast rasters are rendered in the browser, with US freeways colored by
**LCR** (Loss-of-Control Risk, the 0–12 icy-road driving-hazard scale —
<https://icyroadsafety.com/lcr/>). A right-side panel lists the roads currently
at risk, grouped by state, updated live as the forecast animates.

Live: <https://kentstephen.github.io/zarr-road-risk/> (auto-redeploys on every
push to `main` via `.github/workflows/deploy.yml`).

This is a personal data-visualization experiment, not a library. Prefer short
scripts / notebooks over framework-style abstractions.

## ⚠️ On THIS machine, launch the dev server on port 5371, NOT 3000

Stephen runs another process on **port 3000** at all times. The committed Vite
default is 3000 (standard, for anyone cloning the repo), but on this machine
**always launch with the PORT override**:

```sh
cd web && PORT=5371 npm run dev      # http://localhost:5371
```

`strictPort` is on, so a forgotten override fails loudly on 3000 instead of
silently hopping. Never start this project's dev server on 3000.

## Shape of the project

Two halves with a clean seam — the **static parquet/JSON files** in
`web/public/`:

- **Python ETL** (repo root: `scripts/` + `*.ipynb`, managed by `uv`) builds
  the freeway geometry + per-cell lookups. These artifacts are
  **forecast-independent** — geometry and grid indices don't depend on init
  time — so they're built once, not per deploy.
- **Browser app** (`web/`, standalone Vite + React + deck.gl-raster + MapLibre,
  its own `package.json`) reads the HRRR zarr **live per frame** from the cloud
  (no server, no pre-render) and overlays the static vector assets.

```
Overture + Natural Earth
  ─(build_freeway_parquets.ipynb)→ data/freeways_path.parquet
                                   data/freeway_hexes_r5.parquet
  ─(scripts/build_road_table.py)→  data/road_table.parquet   (road names + state)
  ─(scripts/emit_web_json.py)→     web/public/{freeways,hex_pixels}.{parquet,json}
                                   web/public/road_table.parquet
HRRR forecast zarr (source.coop) ─(live, in-browser)→ raster + per-hex LCR
```

## Data sources & key facts

- **HRRR store:** `https://data.source.coop/dynamical/noaa-hrrr-forecast-48-hour/v0.1.0.zarr`
  (Dynamical, Zarr v3, read anonymously). Lambert Conformal Conic grid (sphere
  R=6371229, central meridian −97.5, lat origin 38.5), shape **1059 (y) × 1799
  (x)**, dx/dy = ±3000 m. Dim order on variables: `(init_time, lead_time, y, x)`.
  Lead times: 49 hourly steps, 0..48 h. Inits every 6 h since 2018-07-13 12:00
  UTC. The full grid spec is hardcoded in `web/src/gefs/metadata.ts` (`HRRR_GRID`,
  `HRRR_GEOZARR_ATTRS`) — **do not read it from Python**; `hrrr_x/hrrr_y` indices
  are baked into the hex parquet.
- **The app always uses the latest forecast:** open store, take `init_time[-1]`,
  animate over `lead_time`. No init picker; "latest" auto-tracks new runs.
- **LCR score** uses all 8 `LCR_BANDS` (temperature, precip, snow/freezing-rain/
  ice-pellet categoricals, wind u/v, cloud cover). The single source of truth is
  triplicated and **must stay in sync**: `web/src/lcr/compute.ts` (JS, drives the
  road table), `web/src/gpu/lcr.ts` (GLSL, drives the map color), and
  `scripts/verify_lcr.py` `lcr_score` (Python, verification). Only cloud cover is
  shown as the displayed raster (neutral backdrop); the score is not the backdrop.
- **Freeways** come from Natural Earth `ne_10m_roads_north_america` filtered to
  `type ∈ {Freeway, Tollway}`, US-only (HRRR is essentially CONUS). Geometry is
  densified and mapped to **H3 res-5** cells (`h3_r5`); the r5 hexes gate hazard
  color, the lines render.
- **Road names + state** come from an **Overture** join (`build_road_table.py`):
  Overture `transportation` motorways (`subtype='road'`, `class='motorway'`,
  ramps dropped via `road_flags` containing `is_link`) give `names.primary`;
  Overture `divisions/division_area` (`subtype='region'`) give the state via
  point-in-polygon, mapped to USPS two-letter codes. Join is H3-columnar
  (longest named road per cell). Overture is pulled via DuckDB httpfs from
  `s3://overturemaps-us-west-2`, cached in `data/`.

## Environment

- Python >= 3.12, managed by `uv` (`pyproject.toml`, `.python-version`). Venv at
  `.venv/`. Prefer `uv run <cmd>` so activation state doesn't matter.
- Jupyter kernel name: `zarr-road-risk`.

## Commands

Python ETL:

```sh
uv sync
uv run python scripts/build_road_table.py    # -> data/ + web/public/road_table.parquet
uv run python scripts/emit_web_json.py        # -> web/public/{freeways,hex_pixels}.{parquet,json}
uv run python scripts/verify_lcr.py           # reads HRRR store, sanity-checks LCR
uv run jupyter lab build_freeway_parquets.ipynb
```

The `road_table.parquet` the browser reads is the same file DuckDB queries:

```sh
duckdb -c "SELECT state, count(*) FROM 'web/public/road_table.parquet'
           WHERE road_name IS NOT NULL GROUP BY state ORDER BY 2 DESC"
```

Web app (see `web/README.md`):

```sh
cd web && npm install && PORT=5371 npm run dev   # 5371 on this machine (see warning above)
npm run build        # -> web/dist/   (Vite base = /zarr-road-risk/)
npm run typecheck    # tsc --noEmit
```

## Browser data-loading rules (learned the hard way)

- **In-browser parquet reader = hyparquet**, not duckdb-wasm (no 30 MB wasm; the
  table must move fast per frame). Files are written **snappy** (hyparquet
  decodes it natively; zstd would need hyparquet-compressors).
- **Don't HTTP-range static files on GitHub Pages.** Pages gzips responses, and
  Range + `Content-Encoding: gzip` is incompatible → readers see a bogus parquet
  footer. Full-GET → `arrayBuffer` (see `web/src/roads/road-table.ts`).
- The big `freeways.json` was the init bottleneck (main-thread `JSON.parse`); the
  app loads `freeways.parquet` by default. `emit_web_json.py` still emits the
  legacy JSON for easy A/B revert (`--no-json` / `--json-only` to skip either).

## Notebooks & scripts

- `build_freeway_parquets.ipynb` — pure-local (no network store). NE roads → H3
  → `data/freeways_path.parquet` (seg geometry) + `data/freeway_hexes_r5.parquet`
  (r5 cells with `hrrr_x/hrrr_y`). The canonical geometry build.
- `explore_overture_roads.ipynb` — lonboard viz of the ramp-filtered Overture
  motorways feeding the road-name join.
- `scripts/build_road_table.py` — Overture name + state ETL (above).
- `scripts/emit_web_json.py` — slim the parquets into `web/public/` assets.
- `scripts/verify_lcr.py` / `verify_join.py` / `inspect_gefs_*.py` — verification
  + store introspection (read the zarr via **obstore** in a uv sandbox, fast,
  no fsspec/aiohttp).

Note: several script/dir names still say `gefs` for historical reasons (the store
was GEFS before the HRRR swap). The current store is HRRR; `web/src/gefs/` holds
the HRRR metadata.

## Conventions

- No tests / lint / CI beyond the Pages deploy. Don't invent them unless asked.
- `data/` and generated `*.png` are gitignored.
- Project memory goes in `.claude/memory/MEMORY.md` (gitignored), per the global
  rules — not the auto memory path.
- Running design notes live in `docs/` (`TODO.md` is the active backlog) and
  `NOTES.md`. Read `docs/TODO.md` before starting a new direction.
