import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md(
        r"""
        # Overture motorways → CONUS extract

        Step 1 of the zarr-road-risk preprocessing: pull **motorways** for CONUS
        from the latest Overture release, preview them, and write a GeoParquet the
        browser app (`web/`) will eventually consume.

        - Source: Overture `theme=transportation / type=segment`, public S3 bucket
          (`overturemaps-us-west-2`), anonymous read via DuckDB `httpfs`.
        - Filter: `subtype = 'road' AND class = 'motorway'`, intersecting the CONUS bbox.
        - The S3 scan is a couple of minutes, so it's gated behind a button.

        **Next step (separate notebook):** H3-polyfill these lines into a contiguous
        cell ribbon (res 7/8) to dissolve the uneven-segment problem and get uniform
        gradual coloring. Needs `uv add h3`.
        """
    )
    return


@app.cell
def _():
    # --- config ---
    RELEASE = "2026-05-20.0"  # latest Overture release (verified 2026-05)
    SRC = (
        f"s3://overturemaps-us-west-2/release/{RELEASE}"
        "/theme=transportation/type=segment/*"
    )
    # CONUS bounding box (lon/lat, EPSG:4326)
    W, S, E, N = -125.0, 24.5, -66.5, 49.5
    return E, N, RELEASE, S, SRC, W


@app.cell
def _(RELEASE, mo):
    run = mo.ui.run_button(label=f"Fetch CONUS motorways from Overture {RELEASE}")
    mo.md(f"{run} *(~1–3 min; scans the S3 partition with bbox pushdown)*")
    return (run,)


@app.cell
def _(E, N, S, SRC, W, mo, run):
    import time

    import duckdb

    mo.stop(not run.value, mo.md("⬆️ Click the button to fetch."))

    con = duckdb.connect()
    con.execute(
        "INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; "
        "SET s3_region='us-west-2';"
    )

    # geometry is stored as WKB; bbox is a struct → cheap spatial predicate pushdown.
    sql = f"""
        SELECT
            id,
            names.primary AS name,
            class,
            geometry AS wkb
        FROM read_parquet('{SRC}', hive_partitioning=1)
        WHERE subtype = 'road' AND class = 'motorway'
          AND bbox.xmin <= {E} AND bbox.xmax >= {W}
          AND bbox.ymin <= {N} AND bbox.ymax >= {S}
    """
    _t = time.time()
    df = con.execute(sql).df()
    fetch_secs = time.time() - _t
    return df, fetch_secs


@app.cell
def _(df, fetch_secs, mo):
    import geopandas as gpd

    gdf = gpd.GeoDataFrame(
        df.drop(columns="wkb"),
        geometry=gpd.GeoSeries.from_wkb(df["wkb"]),
        crs="EPSG:4326",
    )
    mo.md(
        f"""
        Fetched **{len(gdf):,}** motorway segments in {fetch_secs:.0f}s.
        Named: **{gdf['name'].notna().sum():,}** · unique names:
        **{gdf['name'].nunique():,}**.
        """
    )
    return (gdf,)


@app.cell
def _(gdf):
    from lonboard import Map, PathLayer

    layer = PathLayer.from_geopandas(
        gdf,
        get_color=[220, 40, 40],
        width_min_pixels=1.2,
    )
    Map(layer)
    return


@app.cell
def _(RELEASE, gdf, mo):
    from pathlib import Path

    out = Path("data") / f"motorways_conus_{RELEASE}.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out)  # GeoParquet
    mo.md(f"Wrote **{out}** ({out.stat().st_size / 1e6:.1f} MB).")
    return


if __name__ == "__main__":
    app.run()
