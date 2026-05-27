# Plan — build the two parquet files

Goal: produce the static files the browser loads.

- `freeways_path.parquet` — one row per freeway/tollway segment, holds the line
  geometry for the deck.gl `PathLayer`.
- `freeway_hexes_r5.parquet` — one row per unique **res-5** H3 cell the network
  touches, holds the GEFS pixel index so the browser can read hazard per cell.

Decisions already locked (don't relitigate in code):
- Source: **Natural Earth `ne_10m_roads_north_america`** (already EPSG:4326 → no
  reproject). Filter `type ∈ {Freeway, Tollway}` AND `country == "United States"`
  (~2,633 segments).
- H3 **res 5** for the hazard-lookup grid. Lines render, hexes only gate color.
- Plain parquet (no GeoParquet metadata); coords as nested double lists.
- Hazard grid = **GEFS 35-day, 0.25°**, regular lat/lon. v1 caps the time window at
  **lead < 240 h** so a single 0.25° index pair is valid.

Where: a standalone reproducible script `build_parquets.py` (run via `uv run`),
mirroring the filter already in `natural-earth-highways-hex.ipynb`. Outputs to
`data/`.

---

## Step 0 — verify the GEFS grid orientation (do once, before trusting index math)

The `gefs_i/j` arithmetic depends on the store's actual coordinate vectors. Open
the dynamical GEFS Zarr and read off the lon/lat axes:

```python
import xarray as xr
ds = xr.open_zarr(GEFS_URL, consolidated=False)   # source.coop / dynamical GEFS 35-day
print(ds.longitude.values[:3], ds.longitude.values[-3:])  # -180 … 179.75 ? step +0.25
print(ds.latitude.values[:3],  ds.latitude.values[-3:])   # 90 → -90 (descending) or asc?
print(ds.dims)   # confirm (init_time, ensemble, lead_time, latitude, longitude)
```

Record `lon0`, `lat0`, `dlon`, `dlat`, and **whether latitude ascends or
descends** — that sign decides the `gefs_j` formula. Everything below assumes
lon ascending from `lon0=-180` at `+0.25`, lat descending from `lat0=90` at
`-0.25`; fix the formula if Step 0 says otherwise.

---

## Step 1 — load + filter the roads (reuse the notebook)

```python
import geopandas as gpd
url = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_roads_north_america.zip"
gdf = gpd.read_file(url, engine="pyogrio")
gdf = gdf[gdf["type"].isin(["Freeway", "Tollway"]) & (gdf["country"] == "United States")]
gdf = gdf.reset_index(drop=True)
gdf["seg_id"] = gdf.index.astype("int32")
```

Already 4326. Some rows may be MultiLineString — explode so one row = one
LineString: `gdf = gdf.explode(index_parts=False).reset_index(drop=True)` then
re-assign `seg_id`.

---

## Step 2 — extract vertices + assign res-5 cell per segment

```python
import h3, numpy as np

def coords(line):                      # -> [[lon,lat], ...]
    return [[float(x), float(y)] for x, y in line.coords]

paths = gdf.geometry.apply(coords)

def rep_cell(line):                    # representative res-5 cell (midpoint vertex)
    pts = list(line.coords)
    lon, lat = pts[len(pts)//2]
    return h3.latlng_to_cell(lat, lon, 5)   # h3 v4 API, note (lat, lon) order

gdf["h3_r5"] = gdf.geometry.apply(rep_cell)        # string index
```

Note h3 v4: `latlng_to_cell(lat, lon, res)` takes **lat first**. Store `h3_r5` as
the **string** form (BigInt joins in JS are painful and we're not using the H3
deck layer).

Per-vertex upgrade (only if per-segment color jumps look bad): also build
`h3_r5_vtx = [[h3.latlng_to_cell(lat, lon, 5) for lon,lat in p] for p in paths]`
and write it as a `list<string>` column aligned to `path`.

### Alternative: DuckDB h3 polyfill (full corridor, not just a midpoint)

If doing the ETL in DuckDB with the h3 extension, use
`h3_polygon_wkt_to_cells_experimental(wkt, 5, 'overlap')` to get **every** res-5
cell the road crosses (the whole corridor), better than the midpoint cell above.

> ⚠️ **Gotcha (confirmed from experience): buffer the linestring first.** A
> LINESTRING has zero area, so the polygon polyfill returns **no cells at all** for
> a raw line. Apply a slight `ST_Buffer` so the geometry has area overlapping hex
> interiors:
>
> ```sql
> SELECT h3_polygon_wkt_to_cells_experimental(
>          ST_AsText(ST_Buffer(geom, 0.005)),   -- ~few hundred m in degrees @ 4326
>          5, 'overlap') AS cells
> FROM freeways;
> ```
>
> Keep the buffer small (a fraction of a res-5 edge, ~0.005°); with `'overlap'`
> mode that's enough for every crossed cell to register without fattening the
> corridor into neighbors. Tune if cells are missing (too small) or bleeding into
> adjacent rows (too big).

Yields a list of cells per segment — feed both the per-segment join (`h3_r5` =
representative cell) and the hex table (Step 4 = deduped union of all cells).

---

## Step 3 — write `freeways_path.parquet`

Columns: `seg_id:int32`, `path:list<list<double>>`, `h3_r5:string`,
`type:string`, `length_km:double` (`gdf.to_crs(5070).length/1000` for a quick
equal-area length, just for the stats panel — geometry shipped stays 4326).

```python
import pyarrow as pa, pyarrow.parquet as pq
t = pa.table({
    "seg_id":   gdf["seg_id"],
    "path":     pa.array(paths, type=pa.list_(pa.list_(pa.float64()))),
    "h3_r5":    gdf["h3_r5"],
    "type":     gdf["type"],
    "length_km": gdf.to_crs(5070).length / 1000.0,
})
pq.write_table(t, "data/freeways_path.parquet", compression="zstd")
```

---

## Step 4 — build + write `freeway_hexes_r5.parquet`

Unique cells touched by the network, with their centroid and GEFS pixel index.

```python
cells = sorted(set(gdf["h3_r5"]))                 # a few hundred at res 5
lat0, lon0, dlat, dlon = 90.0, -180.0, -0.25, 0.25   # from Step 0; fix signs there

rows = []
for c in cells:
    lat, lon = h3.cell_to_latlng(c)               # centroid
    j = round((lat - lat0) / dlat)                # lat descending -> dlat negative
    i = round((lon - lon0) / dlon)
    rows.append((c, lat, lon, int(i), int(j)))

import pyarrow as pa, pyarrow.parquet as pq
hx = pa.table({
    "h3_r5":  [r[0] for r in rows],
    "lat":    [r[1] for r in rows],
    "lon":    [r[2] for r in rows],
    "gefs_i": pa.array([r[3] for r in rows], pa.int32()),
    "gefs_j": pa.array([r[4] for r in rows], pa.int32()),
})
pq.write_table(hx, "data/freeway_hexes_r5.parquet", compression="zstd")
```

---

## Step 5 — sanity checks before handing to the browser

- Row counts: `freeways_path` ≈ 2,633 (more after explode); `freeway_hexes_r5` a
  few hundred. Every `path.h3_r5` must exist in the hex table (`set` subset check).
- Index bounds: `0 ≤ gefs_i < nlon`, `0 ≤ gefs_j < nlat` for all rows (compare to
  the GEFS dims from Step 0).
- Spot-check one cell: `ds.t2m.isel(longitude=gefs_i, latitude=gefs_j)` lands on
  the centroid's actual lon/lat (within half a cell).
- Plot `paths` with `lonboard`/`matplotlib` — confirm it looks like the US freeway
  network, not garbage.

---

## Output

```
data/
├── freeways_path.parquet        # seg_id, path[[lon,lat]], h3_r5, type, length_km
└── freeway_hexes_r5.parquet     # h3_r5, lat, lon, gefs_i, gefs_j
```

Browser then: load both once, per frame read `hazard[var, member, lead=t,
gefs_j, gefs_i]` per hex row → threshold → score by `h3_r5` → color each path by
its cell's score.

## Open / deferred
- GEFS Zarr URL for Step 0 (source.coop dynamical path) — fill in.
- Per-vertex color (`h3_r5_vtx`) — only if per-segment jumps look bad.
- Crossing lead ≥ 240 h (0.5° grid) — add `gefs_i_05/j_05` later; v1 caps at 240 h.
