"""Emit the two small static JSON files the browser app consumes.

Reads the freeway parquets built by build_freeway_parquets.ipynb and writes:

  web/public/freeways.json   - [{seg_id, path:[[lon,lat],...], h3_r5}, ...]
  web/public/hex_pixels.json - [{h3_r5, gefs_i, gefs_j, lat, lon}, ...]

Run: uv run python scripts/emit_web_json.py
"""

import json
from pathlib import Path

import pyarrow.parquet as pq

DATA = Path("data")
OUT = Path("web/public")
OUT.mkdir(parents=True, exist_ok=True)

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
print(f"wrote {out_roads}  ({len(features)} segments, {out_roads.stat().st_size/1e6:.2f} MB)")

hx = pq.read_table(DATA / "freeway_hexes_r5.parquet").to_pandas()
cells = [
    {
        "h3_r5": r.h3_r5,
        "gefs_i": int(r.gefs_i),
        "gefs_j": int(r.gefs_j),
        "lat": float(r.lat),
        "lon": float(r.lon),
    }
    for r in hx.itertuples(index=False)
]
out_hex = OUT / "hex_pixels.json"
out_hex.write_text(json.dumps(cells, separators=(",", ":")))
print(f"wrote {out_hex}  ({len(cells)} cells, {out_hex.stat().st_size/1e3:.1f} KB)")
