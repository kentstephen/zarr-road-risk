# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Visualize and explore the `patchwork-maps/ctrees` Arraylake repo (Earthmover) via its Icechunk-backed Zarr v3 store. The project is a thin scratchpad on top of the Arraylake Python client — not a library.

## Environment

- Python >= 3.12, managed by `uv` (see `pyproject.toml`, `.python-version`).
- The venv lives at `.venv/`. The user has been activating it with `source .venv/bin/activate` — prefer `uv run <cmd>` in scripts so activation state doesn't matter.
- Core deps: `arraylake`, `icechunk`, `zarr` (v3), `xarray`, `matplotlib`, `numpy`, `ipykernel`.

## Notebooks

- `ctrees-above-ground-biomass-data-access.ipynb` — verbatim copy of the CTrees Colab tutorial (the canonical upstream pattern). Don't modify; it's a reference.
- `explore.ipynb` — schema walk + small-window / coarsened overview viz.
- `cheshire.ipynb` — cell-for-cell clone of the Colab, clipped to Cheshire County, NH (FIPS 33005) via TIGER/Line 2024, plus a facet grid (26 panels) + `ipywidgets` slider at the end.

## Data idioms (from the CTrees Colab — do not reinvent)

- Data is native **EPSG:4326**. No reprojection.
- Clip: `ds.agb.sel(x=slice(minx, maxx), y=slice(maxy, miny)) / ds.agb.attrs["agb_scale_factor"]`. The y slice is `maxy → miny` (y descends).
- Scale: divide by `agb_scale_factor` (=10) before plotting.
- Nodata `-9999`: `da.where(da != -9999).where(da > 0, 0)`.
- Polygon clip: `.rio.clip(geom, crs="EPSG:4326", drop=True)` after bbox `.sel()`.

## Commands

- Install / sync deps: `uv sync`
- Add a dep: `uv add <pkg>`
- Open a notebook: `uv run jupyter lab explore.ipynb` (or `cheshire.ipynb`, or VS Code / Cursor with the `ctrees-earthmover` kernel)
- Register the Jupyter kernel (already done; rerun after `uv sync` if it breaks): `uv run python -m ipykernel install --user --name ctrees-earthmover --display-name "ctrees-earthmover"`
- Quick REPL with deps loaded: `uv run python`

## Auth

`arraylake.Client()` reads credentials from the local Arraylake config (usually seeded by `arraylake auth login` in the user's shell, or an `ARRAYLAKE_TOKEN` env var). If `Client()` raises an auth error, have the user run `! arraylake auth login` in this session so the token lands in the right place — don't try to guess a token.

## Architecture

Work happens in `explore.ipynb`. The data-access pattern (first cell) is fixed:

```python
from arraylake import Client
import zarr

client = Client()
repo = client.get_repo("patchwork-maps/ctrees")
session = repo.writable_session("main")        # icechunk session
root = zarr.open_group(session.store, zarr_format=3)
```

Key points when extending this:

- `session.store` is an Icechunk Zarr v3 store. Anything that accepts a zarr store works: `xr.open_zarr(session.store, consolidated=False, ...)`, `zarr.open_group(...)`, etc. Always pass `consolidated=False` — Icechunk does not use consolidated metadata.
- Keep the user's original snippet as-is: `session = repo.writable_session("main")`. The notebook works against it for reads. Don't swap it for `readonly_session` unless the user asks.
- The repo name is namespaced: `<org>/<repo>`. In this project that's `patchwork-maps/ctrees`. Kept in the notebook's first cell as `REPO`.
- Zarr v3 trees can be nested groups. Start any exploration with `root.tree()` / `list(root.group_keys())` / `list(root.array_keys())` before assuming a structure.

## Visualization notes

- `xarray.DataArray.plot()` picks a sensible plotter based on dims (1D → line, 2D → pcolormesh). For 3D+ data, slice down to 2D first (`main.py` does this by taking index 0 along leading dims as a placeholder — revisit per-variable once the schema is known).
- `matplotlib` is configured for file output (`savefig`) rather than an interactive backend, since the user runs from a terminal. If you need interactive plots, the user will say so — don't switch backends silently.

## Repository conventions

- No tests, lint, or CI are set up. Don't invent them unless asked.
- This is a personal exploration project — prefer short scripts / notebooks over framework-style abstractions.
- Generated images (`preview.png` and other `*.png` in root) are gitignored.
