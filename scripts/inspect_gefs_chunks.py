"""Confirm GEFS variable chunk shapes + estimate viewport tile counts.

Goal: hard numbers on (a) the on-disk chunk shape for each LCR band, (b) how
many spatial chunks the default CONUS viewport spans, (c) the lead-chunks-per
spatial-tile multiplier. Inputs to the web/ load-speed work — DON'T optimize
before this prints.

Run:

    uv run --no-project \
        --with xarray --with zarr --with obstore --with numpy \
        scripts/inspect_gefs_chunks.py
"""

import numpy as np
import xarray as xr
import zarr
from obstore.store import HTTPStore
from zarr.storage import ObjectStore

URL = "https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr"

LCR_BANDS = [
    "temperature_2m",
    "precipitation_surface",
    "categorical_snow_surface",
    "categorical_freezing_rain_surface",
    "categorical_ice_pellets_surface",
    "wind_u_10m",
    "wind_v_10m",
    "total_cloud_cover_atmosphere",
]

# Default viewport in web/src/App.tsx: longitude=-96, latitude=39, zoom=3.6.
# Approximate the visible bbox at z3.6 on a typical 1600x900 viewport.
# CONUS-ish: lon [-130, -62], lat [22, 52]. Native grid is 0.25° (4 px/deg).
VIEWPORT_LON = (-130.0, -62.0)
VIEWPORT_LAT = (22.0, 52.0)
GRID_STEP = 0.25
GRID_W = 1440
GRID_H = 721

print(f"=== opening {URL} ===")
store = ObjectStore(HTTPStore.from_url(URL), read_only=True)
root = zarr.open_group(store, mode="r")

print("\n=== chunk shapes by band ===")
chunks_by_band: dict[str, tuple[int, ...]] = {}
shape_by_band: dict[str, tuple[int, ...]] = {}
for band in LCR_BANDS:
    arr = root[band]
    chunks_by_band[band] = tuple(arr.chunks)
    shape_by_band[band] = tuple(arr.shape)
    print(f"  {band}")
    print(f"    shape:  {arr.shape}")
    print(f"    chunks: {arr.chunks}")
    print(f"    dtype:  {arr.dtype}")

assumed = (1, 31, 64, 17, 16)
print(f"\n=== assumption check ===")
print(f"  side-channel.ts comment assumes (init, ens, lead, lat, lon) = {assumed}")
first = next(iter(chunks_by_band.values()))
print(f"  actual (first band)                                   = {first}")
print(f"  match: {first == assumed}")

print("\n=== viewport tile-count estimate ===")
print(f"  viewport bbox: lon {VIEWPORT_LON}, lat {VIEWPORT_LAT}")

# Pixel-coord bbox in the source grid (lon: -180 origin, lat: 90 origin descending).
i_min = int(np.floor((VIEWPORT_LON[0] - (-180.0)) / GRID_STEP))
i_max = int(np.ceil((VIEWPORT_LON[1] - (-180.0)) / GRID_STEP))
j_min = int(np.floor((90.0 - VIEWPORT_LAT[1]) / GRID_STEP))
j_max = int(np.ceil((90.0 - VIEWPORT_LAT[0]) / GRID_STEP))
px_w = i_max - i_min
px_h = j_max - j_min
print(f"  pixels: cols {i_min}..{i_max} ({px_w}), rows {j_min}..{j_max} ({px_h})")

# Spatial chunks the viewport intersects.
chunk_h = first[3]
chunk_w = first[4]
ch_row_min = j_min // chunk_h
ch_row_max = (j_max - 1) // chunk_h
ch_col_min = i_min // chunk_w
ch_col_max = (i_max - 1) // chunk_w
n_rows = ch_row_max - ch_row_min + 1
n_cols = ch_col_max - ch_col_min + 1
n_spatial_chunks = n_rows * n_cols
print(f"  spatial chunks: {chunk_h}x{chunk_w} → {n_rows} rows x {n_cols} cols = {n_spatial_chunks} chunks")

# Lead-time multiplier.
n_leads = shape_by_band[LCR_BANDS[0]][2]
lead_chunk = first[2]
lead_chunks_per_tile = int(np.ceil(n_leads / lead_chunk))
print(f"  leads: {n_leads}, lead-chunk size {lead_chunk} → {lead_chunks_per_tile} lead-chunks per spatial tile")

print(f"\n=== total HTTP fetches for one viewport, one band, all leads ===")
print(f"  {n_spatial_chunks} spatial tiles x {lead_chunks_per_tile} lead-chunks = {n_spatial_chunks * lead_chunks_per_tile} fetches")

print(f"\n=== compare to ECMWF example (same Dynamical host, smaller frame budget) ===")
print(f"  ECMWF: 85 leads, 1 lead-chunk per tile -> 1x multiplier")
print(f"  GEFS:  {n_leads} leads, {lead_chunks_per_tile} lead-chunks per tile -> {lead_chunks_per_tile}x multiplier")
