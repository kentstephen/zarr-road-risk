"""LCR (Loss-of-Control Risk) ground-truth: GEFS bands -> per-hex LCR -> PNG.

Reads 8 input bands from the live GEFS 35-day store for the latest init,
ensemble member 0, one lead. Computes LCR (0-12, forecast mode, no surprise
+3) per res-5 freeway hex via the published ladder from
https://icyroadsafety.com/lcr/. Renders data/verify_lcr.png so the JS/GPU
implementation in web/ has a fixed target to match.

Run (uv sandbox for obstore; rest are project deps):

    uv run --with obstore python scripts/verify_lcr.py [LEAD_IDX]
"""

import sys
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
LEAD_IDX = int(sys.argv[1]) if len(sys.argv) > 1 else 0
DATA = Path("data")

BANDS = [
    "temperature_2m",                  # degC
    "precipitation_surface",           # kg m-2 s-1 (prate)
    "categorical_snow_surface",        # 0/1
    "categorical_freezing_rain_surface",
    "categorical_ice_pellets_surface",
    "wind_u_10m",                      # m s-1
    "wind_v_10m",
    "total_cloud_cover_atmosphere",    # percent
]


def lcr_score(tC, prate, csnow, cfrzr, cicep, u10, v10, tcc):
    """Vectorized LCR ladder (forecast mode). Inputs are np arrays, same shape.

    Returns: lcr (0..12 float), and a tiny dict of which factors fired
    (for the in-browser breakdown tooltip parity check).
    """
    tF = tC * 9.0 / 5.0 + 32.0
    qpf = prate * 3600.0          # kg/m2/s -> mm/h (1 kg/m2 ~ 1 mm)
    wmph = np.sqrt(u10 * u10 + v10 * v10) * 2.2369363

    # Activation: a recognized wintry precip type with non-zero rate.
    active = ((csnow > 0.5) | (cfrzr > 0.5) | (cicep > 0.5)) & (qpf > 0.0)
    # Snow gate at 38F, other types at 36F (used to suppress flagged-but-warm pixels).
    snow_only = (csnow > 0.5) & ~((cfrzr > 0.5) | (cicep > 0.5))
    temp_ok = np.where(snow_only, tF <= 38.0, tF <= 36.0)
    active &= temp_ok

    base = np.zeros_like(tF, dtype=np.float32)

    # Freezing rain dominates if flagged.
    fr = (cfrzr > 0.5)
    base = np.where(fr, np.where(qpf >= 2.0, 10.0, 8.0), base)

    # Ice pellets next.
    ip = (cicep > 0.5) & ~fr
    base = np.where(ip, np.where(qpf >= 2.0, 7.0, 5.0), base)

    # Snow.
    sn = (csnow > 0.5) & ~fr & ~ip
    snow_score = np.where(qpf >= 5.0, 8.0,
                  np.where(qpf >= 2.0, 5.0,
                   np.where(qpf >= 0.5, 3.0, 1.0)))
    base = np.where(sn, snow_score, base)

    lcr = base.copy()
    # Below freezing bumps risk.
    lcr += np.where(tF <= 32.0, 1.0, 0.0)
    # Critical icing band: 20-30F (the worst — too cold for salt, just warm enough to refreeze).
    lcr += np.where((tF >= 20.0) & (tF <= 30.0), 1.0, 0.0)
    # High wind on already-bad surface.
    lcr += np.where((wmph > 20.0) & (lcr >= 5.0), 1.0, 0.0)
    # Sunny-cap: low cloud, above hard-cold -> sun helps.
    sunny_cap = (tcc < 10.0) & (tF > 25.0)
    lcr = np.where(sunny_cap, np.minimum(lcr, 3.0), lcr)
    # Snow-only cap (drivers expect snow; salt + tires).
    lcr = np.where(sn, np.minimum(lcr, 7.0), lcr)

    # Gate.
    lcr = np.where(active, lcr, 0.0)
    lcr = np.clip(lcr, 0.0, 12.0)
    return lcr.astype(np.float32)


# --- load static parquets ----------------------------------------------------
roads = pq.read_table(DATA / "freeways_path.parquet").to_pandas()
geom = [LineString(p) for p in roads["path"]]
gdf = gpd.GeoDataFrame(roads.drop(columns="path"), geometry=geom, crs=4326)

hx = pq.read_table(DATA / "freeway_hexes_r5.parquet").to_pandas()
print(f"loaded {len(gdf)} road segments, {len(hx)} res-5 hexes")

# --- read the 8 fields -------------------------------------------------------
store = ObjectStore(HTTPStore.from_url(URL), read_only=True)
ds = xr.open_zarr(store, consolidated=True)
init = ds["init_time"].values[-1]
print(f"init={np.datetime_as_string(init, unit='h')} lead_idx={LEAD_IDX}")

# Clip to a CONUS window before .load() so we only fetch ~105 chunks per
# variable instead of ~3900 (chunks are (lat=17, lon=16)). The freeway hexes
# all sit inside this window.
J_MIN, J_MAX = int(hx["gefs_j"].min()) - 2, int(hx["gefs_j"].max()) + 3
I_MIN, I_MAX = int(hx["gefs_i"].min()) - 2, int(hx["gefs_i"].max()) + 3
print(f"CONUS window: j={J_MIN}..{J_MAX} i={I_MIN}..{I_MAX}")

vals = {}
for name in BANDS:
    arr = (
        ds[name]
        .isel(init_time=-1, ensemble_member=0, lead_time=LEAD_IDX,
              latitude=slice(J_MIN, J_MAX), longitude=slice(I_MIN, I_MAX))
        .load().values
    )
    js = hx["gefs_j"].values - J_MIN
    is_ = hx["gefs_i"].values - I_MIN
    vals[name] = arr[js, is_]
    print(f"  {name}: shape={arr.shape} hex-sample min={vals[name].min():.3f} max={vals[name].max():.3f}", flush=True)

lcr = lcr_score(
    vals["temperature_2m"],
    vals["precipitation_surface"],
    vals["categorical_snow_surface"],
    vals["categorical_freezing_rain_surface"],
    vals["categorical_ice_pellets_surface"],
    vals["wind_u_10m"],
    vals["wind_v_10m"],
    vals["total_cloud_cover_atmosphere"],
)

# --- sanity ------------------------------------------------------------------
print(f"\nLCR: min={lcr.min():.2f} max={lcr.max():.2f} mean={lcr.mean():.3f}")
print(f"  hexes LCR>=1: {(lcr >= 1).sum()} / {len(lcr)}")
print(f"  hexes LCR>=5: {(lcr >= 5).sum()}")
assert lcr.min() >= 0 and lcr.max() <= 12

# --- join to roads and render -----------------------------------------------
score = dict(zip(hx["h3_r5"], lcr))
gdf["lcr"] = gdf["h3_r5"].map(score)
print(f"segments with LCR>=1: {(gdf['lcr'] >= 1).sum()} / {len(gdf)}")

fig, ax = plt.subplots(figsize=(12, 7), facecolor="#0b0f14")
ax.set_facecolor("#0b0f14")
# Background: all freeways in dim grey.
gdf.plot(ax=ax, color="#2a3340", linewidth=0.4)
# Hazardous: colored on top.
haz = gdf[gdf["lcr"] >= 1].sort_values("lcr")
if len(haz):
    haz.plot(ax=ax, column="lcr", cmap="magma_r", linewidth=1.0,
             vmin=0, vmax=12, legend=True,
             legend_kwds={"label": "LCR (0..12)", "shrink": 0.5})
ax.set_title(f"US freeways · LCR · init {np.datetime_as_string(init, unit='h')} · +{LEAD_IDX*3} h · member 0",
             color="white")
ax.set_axis_off()
out = DATA / "verify_lcr.png"
fig.savefig(out, dpi=140, bbox_inches="tight", facecolor=fig.get_facecolor())
print(f"wrote {out}")

# --- export the per-hex LCR table so the JS side can compare ----------------
hx_out = hx[["h3_r5", "gefs_i", "gefs_j"]].copy()
hx_out["lcr"] = lcr
for name in BANDS:
    hx_out[name] = vals[name]
csv = DATA / f"verify_lcr_lead{LEAD_IDX:03d}.csv"
hx_out.to_csv(csv, index=False)
print(f"wrote {csv} (per-hex inputs + LCR for parity tests)")
