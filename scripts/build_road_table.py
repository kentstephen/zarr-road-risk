"""Build the enriched road table: our r5 freeway hexes + Overture road names + state.

Output: data/road_table.parquet, one row per hex cell that carries a freeway:

    h3_r5      string   (join key; matches freeway_hexes_r5.parquet)
    lat,lon    double   (cell centroid, carried from the hex table)
    hrrr_x/y   int32    (HRRR grid index, carried from the hex table — live LCR sample)
    road_name  string   (Overture names.primary of the motorway covering the cell)
    road_id    string   (Overture GERS id of that motorway)
    state      string   (Overture division_area admin-level-1 name)
    country    string   (ISO country code from the admin-1 region)

This is the artifact the browser reads via hyparquet AND the CLI reads via duckdb:

    duckdb -c "SELECT state, count(*) FROM 'data/road_table.parquet'
               WHERE road_name IS NOT NULL GROUP BY state ORDER BY 2 DESC"

Join method (see docs/TODO.md): H3 columnar. Each Overture motorway LineString is
densified to ~1 km points and mapped to r5 cells (r5 edge ~8 km, so 1 km sampling
never skips a cell along a line). cell -> road_name is the longest road touching
that cell. state/country come from a point-in-polygon of the cell centroid against
Overture admin-1 regions. If coverage is poor, fall back to a spatial sjoin on the
NE segment geometries (TODO option 2).

Stages cache to data/ so re-runs are cheap. Force a refetch with --refetch.

Run: uv run python scripts/build_road_table.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import LineString, MultiLineString

from overturemaps.core import get_latest_release

DATA = Path("data")
HEXES = DATA / "freeway_hexes_r5.parquet"
MOTORWAYS = DATA / "overture_motorways.parquet"
ADMIN1 = DATA / "overture_admin1.parquet"
OUT = DATA / "road_table.parquet"

R5 = 5
# r5 edge ~8.5 km; sample lines every ~1 km in degrees (~0.009 deg lat).
SAMPLE_STEP_DEG = 0.009


def _cache_ok(path: Path) -> bool:
    """True if path is a non-empty, readable parquet."""
    try:
        return path.exists() and path.stat().st_size > 0 and pq.read_metadata(path).num_rows >= 0
    except Exception:
        return False


def _duck() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET s3_region='us-west-2';")
    return con


def hex_bbox() -> tuple[float, float, float, float]:
    """(minx, miny, maxx, maxy) over all freeway hexes, padded slightly."""
    df = pq.read_table(HEXES, columns=["lon", "lat"]).to_pandas()
    pad = 0.5
    return (
        float(df.lon.min()) - pad,
        float(df.lat.min()) - pad,
        float(df.lon.max()) + pad,
        float(df.lat.max()) + pad,
    )


def fetch_motorways(bbox, release, refetch=False) -> None:
    if _cache_ok(MOTORWAYS) and not refetch:
        print(f"[motorways] cached {MOTORWAYS} ({pq.read_metadata(MOTORWAYS).num_rows} rows)")
        return
    minx, miny, maxx, maxy = bbox
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*"
    print(f"[motorways] querying Overture {release} within {bbox} ...")
    con = _duck()
    con.execute(
        f"""
        COPY (
          SELECT id AS road_id,
                 names.primary AS road_name,
                 ST_AsWKB(geometry) AS geometry_wkb
          FROM read_parquet('{src}', filename=true, hive_partitioning=1)
          WHERE subtype = 'road' AND class = 'motorway'
            -- drop ramps: road_flags is a geometrically-scoped struct array,
            -- each element has a values[] list that may contain 'is_link'.
            AND NOT coalesce(
                  list_contains(
                    flatten(list_transform(road_flags, f -> f.values)),
                    'is_link'),
                  false)
            AND bbox.xmin BETWEEN {minx} AND {maxx}
            AND bbox.ymin BETWEEN {miny} AND {maxy}
        ) TO '{MOTORWAYS}' (FORMAT parquet);
        """
    )
    con.close()
    print(f"[motorways] wrote {MOTORWAYS} ({pq.read_metadata(MOTORWAYS).num_rows} rows)")


def fetch_admin1(bbox, release, refetch=False) -> None:
    if _cache_ok(ADMIN1) and not refetch:
        print(f"[admin1] cached {ADMIN1} ({pq.read_metadata(ADMIN1).num_rows} rows)")
        return
    minx, miny, maxx, maxy = bbox
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*"
    print(f"[admin1] querying Overture {release} within {bbox} ...")
    con = _duck()
    con.execute(
        f"""
        COPY (
          SELECT names.primary AS state,
                 country,
                 ST_AsWKB(geometry) AS geometry_wkb
          FROM read_parquet('{src}', filename=true, hive_partitioning=1)
          WHERE subtype = 'region'
            AND bbox.xmin <= {maxx} AND bbox.xmax >= {minx}
            AND bbox.ymin <= {maxy} AND bbox.ymax >= {miny}
        ) TO '{ADMIN1}' (FORMAT parquet);
        """
    )
    con.close()
    print(f"[admin1] wrote {ADMIN1} ({pq.read_metadata(ADMIN1).num_rows} rows)")


def _iter_lines(geom):
    if isinstance(geom, LineString):
        yield geom
    elif isinstance(geom, MultiLineString):
        yield from geom.geoms


def cells_for_line(geom) -> set[str]:
    """r5 cells touched by a (Multi)LineString, via ~1 km point sampling."""
    cells: set[str] = set()
    for line in _iter_lines(geom):
        n = max(2, int(line.length / SAMPLE_STEP_DEG) + 1)
        for d in np.linspace(0.0, line.length, n):
            pt = line.interpolate(d)
            cells.add(h3.latlng_to_cell(pt.y, pt.x, R5))
    return cells


def build_cell_road() -> pd.DataFrame:
    """cell -> (road_name, road_id) keeping the longest road that touches each cell."""
    mw = pq.read_table(MOTORWAYS).to_pandas()
    mw = mw[mw.road_name.notna()].reset_index(drop=True)
    print(f"[join] {len(mw)} named motorways")
    rows: list[tuple[str, str, str, float]] = []
    for r in mw.itertuples(index=False):
        geom = wkb.loads(bytes(r.geometry_wkb))
        length = geom.length
        for cell in cells_for_line(geom):
            rows.append((cell, r.road_name, r.road_id, length))
    cr = pd.DataFrame(rows, columns=["h3_r5", "road_name", "road_id", "length"])
    # longest road wins each cell
    cr = cr.sort_values("length", ascending=False).drop_duplicates("h3_r5")
    print(f"[join] {len(cr)} cells covered by a named motorway")
    return cr[["h3_r5", "road_name", "road_id"]]


def attach_state(hexes: pd.DataFrame) -> pd.DataFrame:
    """Point-in-polygon cell centroids against Overture admin-1 regions."""
    adm = pq.read_table(ADMIN1).to_pandas()
    adm["geometry"] = adm.geometry_wkb.map(lambda b: wkb.loads(bytes(b)))
    adm_gdf = gpd.GeoDataFrame(adm[["state", "country"]], geometry=adm.geometry, crs="EPSG:4326")
    pts = gpd.GeoDataFrame(
        hexes[["h3_r5"]],
        geometry=gpd.points_from_xy(hexes.lon, hexes.lat),
        crs="EPSG:4326",
    )
    joined = gpd.sjoin(pts, adm_gdf, how="left", predicate="within")
    joined = joined.drop_duplicates("h3_r5")[["h3_r5", "state", "country"]]
    return hexes.merge(joined, on="h3_r5", how="left")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refetch", action="store_true", help="re-pull Overture even if cached")
    ap.add_argument("--release", default=None, help="Overture release (default: latest)")
    args = ap.parse_args()

    release = args.release or get_latest_release()
    bbox = hex_bbox()
    print(f"release={release}  bbox={bbox}")

    fetch_motorways(bbox, release, args.refetch)
    fetch_admin1(bbox, release, args.refetch)

    hexes = pq.read_table(HEXES).to_pandas()
    cell_road = build_cell_road()
    hexes = hexes.merge(cell_road, on="h3_r5", how="left")
    hexes = attach_state(hexes)

    n_named = hexes.road_name.notna().sum()
    n_state = hexes.state.notna().sum()
    print(f"[out] {len(hexes)} hexes  | {n_named} with road_name  | {n_state} with state")
    print(hexes.head(10).to_string())

    hexes.to_parquet(OUT, index=False)
    print(f"[out] wrote {OUT} ({OUT.stat().st_size/1e3:.1f} KB)")


if __name__ == "__main__":
    main()
