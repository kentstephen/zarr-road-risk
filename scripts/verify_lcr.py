"""LCR (Loss-of-Control Risk) ground-truth: HRRR bands -> per-hex LCR -> PNG.

Reads 8 input bands from the live NOAA HRRR 48-hour forecast store (the same
store the web app reads), for the init the app defaults to (14 Jan 2026 00Z),
one lead. Computes LCR (0-12, forecast mode) per res-5 freeway hex via the
ladder from https://icyroadsafety.com/lcr/. Renders data/verify_lcr.png and a
per-hex CSV so the JS/GPU implementation in web/ has a fixed target to match.

`lcr_score` here is the byte-for-byte twin of web/src/lcr/compute.ts.

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

# Same store + default init as the web app (web/src/App.tsx).
URL = "https://data.source.coop/dynamical/noaa-hrrr-forecast-48-hour/v0.1.0.zarr"
INIT_DATE = np.datetime64("2026-01-14T00:00")
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

    Byte-for-byte twin of web/src/lcr/compute.ts `computeLcr`.
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

# Pick the init the app defaults to (nearest available).
init_da = ds.sel(init_time=INIT_DATE, method="nearest")["init_time"]
init = init_da.values
print(f"requested init={np.datetime_as_string(INIT_DATE, unit='h')} "
      f"-> using {np.datetime_as_string(init, unit='h')}  lead_idx={LEAD_IDX} (+{LEAD_IDX} h)")

# Pointwise sample at each hex's (hrrr_y, hrrr_x). Vectorized .isel fetches only
# the spatial shards covering the freeway hexes (same set the app's side channel
# pulls), not the whole CONUS grid.
ys = xr.DataArray(hx["hrrr_y"].to_numpy(), dims="hex")
xs = xr.DataArray(hx["hrrr_x"].to_numpy(), dims="hex")

vals = {}
for name in BANDS:
    pts = (
        ds[name]
        .sel(init_time=INIT_DATE, method="nearest")
        .isel(lead_time=LEAD_IDX)
        .isel(y=ys, x=xs)
        .load()
        .values
    )
    vals[name] = np.asarray(pts, dtype=np.float64)
    v = vals[name]
    print(f"  {name}: hex-sample min={np.nanmin(v):.3f} max={np.nanmax(v):.3f} "
          f"mean={np.nanmean(v):.3f}", flush=True)

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
ax.set_title(
    f"US freeways · LCR · HRRR init {np.datetime_as_string(init, unit='h')} · +{LEAD_IDX} h",
    color="white",
)
ax.set_axis_off()
out = DATA / "verify_lcr.png"
fig.savefig(out, dpi=140, bbox_inches="tight", facecolor=fig.get_facecolor())
print(f"wrote {out}")

# --- export the per-hex LCR table so the JS side can compare ----------------
hx_out = hx[["h3_r5", "hrrr_x", "hrrr_y"]].copy()
hx_out["lcr"] = lcr
for name in BANDS:
    hx_out[name] = vals[name]
csv = DATA / f"verify_lcr_lead{LEAD_IDX:03d}.csv"
hx_out.to_csv(csv, index=False)
print(f"wrote {csv} (per-hex inputs + LCR for parity tests)")
