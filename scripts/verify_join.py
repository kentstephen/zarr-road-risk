"""End-to-end verification: GEFS hazard -> hex pixel -> freeway color.

Proves the data pipeline is sound BEFORE any browser work:
  1. read one GEFS 2D field over HTTP (obstore, ~4 MB, latest init, member 0),
  2. sample each res-5 hex two independent ways and assert they match
     (xarray nearest-by-lat/lon  ==  baked gefs_i/j integer index),
  3. join hazard to freeways by h3_r5, threshold, and save a colored PNG.

Run (uv sandbox for obstore; rest are project deps):

    uv run --with obstore python scripts/verify_join.py

Outputs data/verify_join.png and prints PASS/FAIL checks.
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import geopandas as gpd
import numpy as np
import pyarrow.parquet as pq
import xarray as xr
from obstore.store import HTTPStore
from shapely import LineString
from zarr.storage import ObjectStore

URL = "https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr"
VAR = "temperature_2m"     # degC
LEAD_IDX = 0               # +0 h (latest analysis); any 0..180 works
FREEZE_C = 0.0             # demo threshold: roads at/below freezing
DATA = Path("data")

# --- load the static parquets ------------------------------------------------
roads = pq.read_table(DATA / "freeways_path.parquet").to_pandas()
geom = [LineString(p) for p in roads["path"]]
gdf = gpd.GeoDataFrame(roads.drop(columns="path"), geometry=geom, crs=4326)

hx = pq.read_table(DATA / "freeway_hexes_r5.parquet").to_pandas()
print(f"loaded {len(gdf)} road segments, {len(hx)} res-5 hexes")

# --- read ONE 2D hazard field (latest forecast, member 0, chosen lead) -------
store = ObjectStore(HTTPStore.from_url(URL), read_only=True)
ds = xr.open_zarr(store, consolidated=True)
init = ds["init_time"].values[-1]
field = ds[VAR].isel(init_time=-1, ensemble_member=0, lead_time=LEAD_IDX).load()
print(f"read {VAR}: init={np.datetime_as_string(init, unit='h')} "
      f"lead_idx={LEAD_IDX} shape={field.shape}")

# --- sample each hex two ways, assert identical ------------------------------
c = dict(dims="cell")
v_sel = field.sel(latitude=xr.DataArray(hx["lat"].values, **c),
                  longitude=xr.DataArray(hx["lon"].values, **c),
                  method="nearest").values
v_idx = field.values[hx["gefs_j"].values, hx["gefs_i"].values]

checks = []
def check(name, ok):
    checks.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")

print("verification:")
check("baked gefs_i/j == xarray nearest lookup", np.allclose(v_sel, v_idx, equal_nan=True))
check(f"{VAR} values physically plausible (-70..60 C)",
      np.isfinite(v_idx).all() and float(v_idx.min()) > -70 and float(v_idx.max()) < 60)

# --- join hazard to roads by h3_r5 -------------------------------------------
score = dict(zip(hx["h3_r5"], v_idx))
gdf["tC"] = gdf["h3_r5"].map(score)
check("every road segment got a hazard value", gdf["tC"].notna().all())

n_below = int((gdf["tC"] <= FREEZE_C).sum())
print(f"segments at/below {FREEZE_C} C: {n_below} / {len(gdf)}")

# --- render proof ------------------------------------------------------------
fig, ax = plt.subplots(figsize=(12, 7))
gdf.plot(ax=ax, column="tC", cmap="coolwarm_r", linewidth=0.6,
         legend=True, legend_kwds={"label": f"{VAR} (C)", "shrink": 0.5})
ax.set_title(f"US freeways colored by GEFS {VAR}  "
             f"(init {np.datetime_as_string(init, unit='h')}, +{LEAD_IDX*3} h, member 0)")
ax.set_axis_off()
out = DATA / "verify_join.png"
fig.savefig(out, dpi=130, bbox_inches="tight")
print(f"wrote {out}")

print("\nRESULT:", "ALL PASS — good to go" if all(checks) else "FAILED — see above")
