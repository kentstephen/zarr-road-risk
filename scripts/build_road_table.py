"""Build the enriched road table: our r5 freeway hexes + Overture road names + state.

Output: data/road_table.parquet, one row per hex cell that carries a freeway:

    h3_r5      string   (join key; matches freeway_hexes_r5.parquet)
    lat,lon    double   (cell centroid, carried from the hex table)
    hrrr_x/y   int32    (HRRR grid index, carried from the hex table — live LCR sample)
    road_name  string   (Overture names.primary of the motorway covering the cell;
                         falls back to "Freeway in <County>, <ST>" when no named
                         motorway covers the cell — see _label_unnamed)
    road_id    string   (Overture GERS id of that motorway; null for fallback labels)
    state      string   (Overture division_area admin-level-1 name, 2-letter code)
    country    string   (ISO country code from the admin-1 region)
    county     string   (Overture county the cell sits in, by majority vote of its
                         r7 children — see attach_county)

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
import pandas as pd
import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import LineString, MultiLineString

from overturemaps.core import get_latest_release

DATA = Path("data")
HEXES = DATA / "freeway_hexes_r5.parquet"
MOTORWAYS = DATA / "overture_motorways.parquet"
ADMIN1 = DATA / "overture_admin1.parquet"
COUNTIES = DATA / "overture_counties.parquet"
OUT = DATA / "road_table.parquet"

R5 = 5
# Densify step (m) before mapping vertices to r5 cells. Matches the HRRR pixel
# pitch / the hex notebook; r5 edge ~8.5 km so 3 km never skips a cell.
DENSIFY_M = 3000

# Sub-resolution used to assign a county to each r5 cell. An r5 cell (~8.5 km
# edge) can straddle a county/state line, so a single centroid PIP is ambiguous
# at borders. We sample each r5 cell at its r8 children (343 sub-cells, ~0.5 km
# edge), PIP each child, then roll back up to the r5 parent by majority vote
# (attach_county).
COUNTY_VOTE_RES = 8

# Overture admin-1 region names -> USPS two-letter codes (US-only dataset).
STATE_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
    "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE",
    "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH",
    "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
    "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX",
    "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}


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


def fetch_counties(bbox, release, refetch=False) -> None:
    if _cache_ok(COUNTIES) and not refetch:
        print(f"[county] cached {COUNTIES} ({pq.read_metadata(COUNTIES).num_rows} rows)")
        return
    minx, miny, maxx, maxy = bbox
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*"
    print(f"[county] querying Overture {release} within {bbox} ...")
    con = _duck()
    con.execute(
        f"""
        COPY (
          SELECT names.primary AS county,
                 ST_AsWKB(geometry) AS geometry_wkb
          FROM read_parquet('{src}', filename=true, hive_partitioning=1)
          WHERE subtype = 'county'
            AND bbox.xmin <= {maxx} AND bbox.xmax >= {minx}
            AND bbox.ymin <= {maxy} AND bbox.ymax >= {miny}
        ) TO '{COUNTIES}' (FORMAT parquet);
        """
    )
    con.close()
    print(f"[county] wrote {COUNTIES} ({pq.read_metadata(COUNTIES).num_rows} rows)")


def _iter_lines(geom):
    if isinstance(geom, LineString):
        yield geom
    elif isinstance(geom, MultiLineString):
        yield from geom.geoms


def build_cell_road() -> pd.DataFrame:
    """cell -> (road_name, road_id) keeping the longest road that touches each cell.

    Densify is vectorized (project -> segmentize -> back to lon/lat) the same way
    build_freeway_parquets.ipynb does it — much faster than per-point interpolate.
    """
    mw = pq.read_table(MOTORWAYS).to_pandas()
    mw = mw[mw.road_name.notna()].reset_index(drop=True)
    print(f"[join] {len(mw)} named motorways")

    geoms = gpd.GeoSeries.from_wkb(mw.geometry_wkb.values, crs="EPSG:4326")
    proj = geoms.to_crs(5070)                       # equal-area, metres
    lengths = proj.length.to_numpy()                # tiebreak: longest road wins
    dense = proj.segmentize(DENSIFY_M).to_crs("EPSG:4326")

    names = mw.road_name.to_numpy()
    ids = mw.road_id.to_numpy()
    rows: list[tuple[str, str, str, float]] = []
    for g, name, rid, length in zip(dense.values, names, ids, lengths):
        seen: set[str] = set()
        for line in _iter_lines(g):
            for lon, lat in line.coords:
                c = h3.latlng_to_cell(lat, lon, R5)
                if c not in seen:
                    seen.add(c)
                    rows.append((c, name, rid, length))
    cr = pd.DataFrame(rows, columns=["h3_r5", "road_name", "road_id", "length"])
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
    # Full region name -> USPS two-letter code; unmapped (non-US) -> NaN.
    joined["state"] = joined["state"].map(STATE_ABBR)
    return hexes.merge(joined, on="h3_r5", how="left")


def attach_county(hexes: pd.DataFrame, cells: pd.Series) -> pd.Series:
    """County name per r5 cell, by majority vote of its r8 children.

    `cells` is the (small) set of r5 cells that need a county — in practice the
    handful of freeway hexes no named motorway covered. We fan each out to its
    r8 children, point-in-polygon each child centroid against Overture county
    polygons, then roll back up to the r5 parent (the "parent at the end" step)
    by taking the most common county among the children. Returns a Series of
    county name indexed by h3_r5 (cells with no county hit are absent).
    """
    cells = pd.Index(cells.unique())
    if len(cells) == 0:
        return pd.Series(dtype="object", name="county")

    cty = pq.read_table(COUNTIES).to_pandas()
    cty["geometry"] = cty.geometry_wkb.map(lambda b: wkb.loads(bytes(b)))
    cty_gdf = gpd.GeoDataFrame(cty[["county"]], geometry=cty.geometry, crs="EPSG:4326")

    parent: list[str] = []
    clat: list[float] = []
    clon: list[float] = []
    for c in cells:
        for ch in h3.cell_to_children(c, COUNTY_VOTE_RES):
            lat, lon = h3.cell_to_latlng(ch)
            parent.append(c)
            clat.append(lat)
            clon.append(lon)
    print(f"[county] voting {len(cells)} unnamed cells x r{COUNTY_VOTE_RES} = {len(parent)} pts")

    pts = gpd.GeoDataFrame(
        {"h3_r5": parent},
        geometry=gpd.points_from_xy(clon, clat),
        crs="EPSG:4326",
    )
    hit = gpd.sjoin(pts, cty_gdf, how="inner", predicate="within")
    votes = hit.groupby("h3_r5")["county"].agg(lambda s: s.mode().iat[0])
    votes.name = "county"
    return votes


def _label_unnamed(road_name, county, state):
    """Keep an existing road name; otherwise synthesize a county fallback label.

    e.g. "Freeway in Johnson County, KS". Overture US county names already carry
    the type suffix ("County"/"Parish"/"Borough"), so we don't append one. With
    no county at all, leave it null (the app shows "(unnamed)").
    """
    if pd.notna(road_name):
        return road_name
    if pd.isna(county) or not county:
        return None
    label = f"Freeway in {county}"
    if pd.notna(state) and state:
        label += f", {state}"
    return label


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
    fetch_counties(bbox, release, args.refetch)

    hexes = pq.read_table(HEXES).to_pandas()
    cell_road = build_cell_road()
    hexes = hexes.merge(cell_road, on="h3_r5", how="left")
    hexes = attach_state(hexes)

    # County fallback name for the few cells no named motorway covered.
    unnamed = hexes.loc[hexes.road_name.isna(), "h3_r5"]
    county = attach_county(hexes, unnamed)
    hexes = hexes.merge(county, on="h3_r5", how="left")
    hexes["road_name"] = [
        _label_unnamed(rn, ct, st)
        for rn, ct, st in zip(hexes.road_name, hexes.county, hexes.state)
    ]

    n_named = hexes.road_name.notna().sum()
    n_state = hexes.state.notna().sum()
    n_county = hexes.county.notna().sum()
    print(
        f"[out] {len(hexes)} hexes  | {n_named} with road_name  "
        f"| {n_state} with state  | {n_county} unnamed-cell counties"
    )
    print(hexes.head(10).to_string())

    hexes.to_parquet(OUT, index=False)
    print(f"[out] wrote {OUT} ({OUT.stat().st_size/1e3:.1f} KB)")

    # Also drop a copy where the browser app fetches it (served by Vite).
    web_out = Path("web/public/road_table.parquet")
    if web_out.parent.exists():
        hexes.to_parquet(web_out, index=False)
        print(f"[out] wrote {web_out} ({web_out.stat().st_size/1e3:.1f} KB)")


if __name__ == "__main__":
    main()
