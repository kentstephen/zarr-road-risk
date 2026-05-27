"""Inspect the dynamical GEFS 35-day zarr metadata (no project deps touched).

Reads over HTTP via obstore (Rust object store) wrapped in zarr's ObjectStore —
no fsspec/aiohttp. Run in an ephemeral uv sandbox:

    uv run --no-project \
        --with xarray --with zarr --with obstore --with numpy \
        scripts/inspect_gefs_zarr.py

Prints dims, coordinate axes (lon/lat origin + step), lead_time schedule, the
variable list, and a few key attrs — everything needed to confirm the GRID
constants baked into build_freeway_parquets.ipynb.
"""

import numpy as np
import xarray as xr
from obstore.store import HTTPStore
from zarr.storage import ObjectStore

URL = "https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr"

store = ObjectStore(HTTPStore.from_url(URL), read_only=True)
ds = xr.open_zarr(store, consolidated=True)

print("=== dims ===")
for k, v in ds.sizes.items():
    print(f"  {k}: {v}")

print("\n=== coordinate axes ===")
for name in ("longitude", "latitude"):
    if name in ds.coords:
        a = ds[name].values
        step = float(a[1] - a[0]) if a.size > 1 else float("nan")
        print(f"  {name}: {a.size} pts | {a[0]} -> {a[-1]} | step {step}")

if "lead_time" in ds.coords:
    lt = ds["lead_time"].values
    print(f"\n=== lead_time === ({lt.size} steps)")
    print("  first:", lt[:6])
    print("  last: ", lt[-6:])

if "init_time" in ds.coords:
    it = ds["init_time"].values
    print(f"\n=== init_time === ({it.size})")
    print("  range:", it.min(), "->", it.max())

if "ensemble_member" in ds.coords:
    print(f"\n=== ensemble_member === {ds['ensemble_member'].size}")

print("\n=== data variables ===")
for v in ds.data_vars:
    print(f"  {v}: {ds[v].dims} {dict(list(ds[v].attrs.items())[:4])}")

print("\n=== global attrs (subset) ===")
for k in list(ds.attrs)[:15]:
    print(f"  {k}: {ds.attrs[k]}")
