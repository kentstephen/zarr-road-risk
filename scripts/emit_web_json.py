"""Emit the static vector files the browser app consumes.

Reads the freeway parquets built by build_freeway_parquets.ipynb and writes
both PARQUET (read in-browser via hyparquet, like road_table.parquet) and the
legacy JSON (kept for easy A/B revert) into web/public/:

  freeways.parquet / freeways.json     - {seg_id, path:[[lon,lat],...], h3_r5}
  hex_pixels.parquet / hex_pixels.json - {h3_r5, hrrr_x, hrrr_y, lat, lon}

Parquet is the default the app loads; the 17 MB freeways.json was the init
bottleneck (raw JSON.parse on the main thread). Pass --json-only to skip
parquet, or --no-json to skip the legacy JSON.

Run: uv run python scripts/emit_web_json.py
"""

import argparse
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

DATA = Path("data")
OUT = Path("web/public")

# SNAPPY (not ZSTD): hyparquet decodes snappy natively, matching how
# road_table.parquet is written/read. ZSTD would need hyparquet-compressors.
COMPRESSION = "snappy"


def emit_parquet() -> None:
    # Slim the source tables to the columns the browser uses. Downcast the
    # nested path coords to float32 (~10cm precision is ample for display and
    # halves the column) — snappy compresses less than zstd, so this offsets it.
    roads = pq.read_table(DATA / "freeways_path.parquet").select(
        ["seg_id", "h3_r5", "path"]
    )
    path_f32 = pc.cast(roads["path"], pa.list_(pa.list_(pa.float32())))
    roads = roads.set_column(
        roads.schema.get_field_index("path"), "path", path_f32
    )
    pq.write_table(roads, OUT / "freeways.parquet", compression=COMPRESSION)
    sz = (OUT / "freeways.parquet").stat().st_size / 1e6
    print(f"wrote {OUT/'freeways.parquet'}  ({roads.num_rows} segments, {sz:.2f} MB)")

    hx = pq.read_table(DATA / "freeway_hexes_r5.parquet").select(
        ["h3_r5", "hrrr_x", "hrrr_y", "lat", "lon"]
    )
    pq.write_table(hx, OUT / "hex_pixels.parquet", compression=COMPRESSION)
    sz = (OUT / "hex_pixels.parquet").stat().st_size / 1e3
    print(f"wrote {OUT/'hex_pixels.parquet'}  ({hx.num_rows} cells, {sz:.1f} KB)")


def emit_json() -> None:
    roads = pq.read_table(DATA / "freeways_path.parquet").to_pandas()
    features = [
        {
            "seg_id": int(r.seg_id),
            "h3_r5": r.h3_r5,
            # path is list-of-lists already; ensure JSON-serializable floats.
            "path": [[float(x), float(y)] for x, y in r.path],
        }
        for r in roads.itertuples(index=False)
    ]
    out_roads = OUT / "freeways.json"
    out_roads.write_text(json.dumps(features, separators=(",", ":")))
    print(
        f"wrote {out_roads}  ({len(features)} segments, "
        f"{out_roads.stat().st_size/1e6:.2f} MB)"
    )

    hx = pq.read_table(DATA / "freeway_hexes_r5.parquet").to_pandas()
    cells = [
        {
            "h3_r5": r.h3_r5,
            "hrrr_x": int(r.hrrr_x),
            "hrrr_y": int(r.hrrr_y),
            "lat": float(r.lat),
            "lon": float(r.lon),
        }
        for r in hx.itertuples(index=False)
    ]
    out_hex = OUT / "hex_pixels.json"
    out_hex.write_text(json.dumps(cells, separators=(",", ":")))
    print(
        f"wrote {out_hex}  ({len(cells)} cells, "
        f"{out_hex.stat().st_size/1e3:.1f} KB)"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json-only", action="store_true", help="skip parquet")
    ap.add_argument("--no-json", action="store_true", help="skip legacy JSON")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.json_only:
        emit_parquet()
    if not args.no_json:
        emit_json()


if __name__ == "__main__":
    main()
