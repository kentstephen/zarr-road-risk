"""Fetch Overture motorways for the freeway-hex bbox and plot them to a PNG.

Lets us eyeball the Overture road geometry/coverage before running the H3 join
in build_road_table.py. Reuses that script's bbox + fetch so the cached
data/overture_motorways.parquet is shared.

Run: uv run python scripts/preview_motorways.py
Output: motorways_preview.png (gitignored)
"""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pyarrow.parquet as pq
from shapely import wkb

from overturemaps.core import get_latest_release
from build_road_table import MOTORWAYS, fetch_motorways, hex_bbox

OUT = Path("motorways_preview.png")


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--refetch", action="store_true", help="re-pull Overture even if cached")
    args = ap.parse_args()

    bbox = hex_bbox()
    release = get_latest_release()
    print(f"release={release}  bbox={bbox}")
    fetch_motorways(bbox, release, refetch=args.refetch)

    df = pq.read_table(MOTORWAYS).to_pandas()
    print(f"{len(df)} motorway segments  |  {df.road_name.notna().sum()} with names.primary")
    print(df[["road_id", "road_name"]].head(15).to_string())

    geom = df.geometry_wkb.map(lambda b: wkb.loads(bytes(b)))
    gdf = gpd.GeoDataFrame(df[["road_name"]], geometry=geom, crs="EPSG:4326")

    fig, ax = plt.subplots(figsize=(16, 9))
    gdf.plot(ax=ax, linewidth=0.4, color="#d2691e")
    ax.set_title(f"Overture motorways — {len(gdf)} segments ({release})")
    ax.set_xlim(bbox[0], bbox[2])
    ax.set_ylim(bbox[1], bbox[3])
    ax.set_aspect("equal")
    fig.savefig(OUT, dpi=120, bbox_inches="tight")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
