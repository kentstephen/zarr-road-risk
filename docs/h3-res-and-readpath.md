# H3 resolution, linestrings vs hexes, and the read path

Answers to the four things you asked, written out so you can read it away from the
terminal. Context: freeway/tollway layer (~2,633 segments, US), hazard from the
dynamical.org **NOAA GEFS 35-day** Zarr.

---

## 1. Resolution of the NOAA GEFS Zarr (the hazard grid)

From the dynamical.org catalog page for **NOAA GEFS forecast, 35-day**:

| property | value |
|----------|-------|
| spatial res | **0.25° (~20–28 km)** for lead 0–240 h, then **0.5° (~40–55 km)** for 243–840 h |
| grid | **regular lat/lon**, −90→90 lat, −180→179.75 lon |
| ensemble | 31 members |
| horizon | 840 h = **35 days** |
| time step | 3-hourly (0–240 h), 6-hourly (243–840 h); new run every 24 h at 00 UTC |
| dims | `init_time × ensemble × lead_time × lat × lon` |
| variables | 22 (2 m temp + max/min, precip by type, 10 m / 100 m wind, MSLP, radiation, RH, cloud, geopotential, precipitable water) |

**The number that drives everything below:** the hazard field only carries real
detail at **~0.25° ≈ 28 km**. At 40°N that cell is ~21 km (E–W) × ~28 km (N–S)
≈ **600 km²** of area. In H3 terms that's between **res 4 (1,770 km²) and res 5
(253 km²)** — i.e. one GEFS cell ≈ a couple of res-5 hexes, **≈ ~150 res-7
hexes**. Below res 5 the *weather* signal is fake detail; it only repeats.

Regular lat/lon means the pixel for any point is closed-form arithmetic
(`i = round((lon−lon0)/0.25)`, `j = round((lat−lat0)/0.25)`) — no spatial join
needed to read the hazard. (HRRR would be Lambert-conformal and need a reproject;
GEFS does not.)

---

## 2. What H3 resolution to use for the freeways

Two different scales are in play, and that's the whole point:

- **Hazard** has no detail below ~res 5.
- **The freeway ribbon** (the thing you color) wants to *look like a road*, so it
  wants to be finer than the hazard.

That mismatch is fine — it's exactly the justification from the plan ("fine res is
justified only because the colored signal is infrastructure, not weather"). Many
adjacent fine hexes share one hazard value; the detail you see is *where the
freeway is*, not fake weather precision.

H3 reference (average cell):

| res | edge | area | role for this layer |
|-----|------|------|---------------------|
| 4 | ~26 km | 1,770 km² | ≈ GEFS cell — too coarse to read as a road |
| 5 | ~9.9 km | 253 km² | ≈ hazard granularity; coarse ribbon |
| **7** | **~1.4 km** | **5.2 km²** | **recommended working res — reads as a road ribbon, modest payload** |
| 8 | ~0.53 km | 0.74 km² | tight zoom detail; ~3–4× the cells |

**Recommendation: build the freeway ribbon at res 7.** A polyfill of the freeway
lines at res 7 gives a chain of ~1.4 km cells that reads clearly as a highway
corridor at CONUS-to-state zoom. Add **res 8 only if** you want crisp detail when
zoomed into a metro — and only then is tiling worth it. You do **not** need the
res 5/6/7/8 ladder from the original plan; that ladder was for *area-covering*
road-density / building layers. A freeway-only ribbon is sparse — res 7 (optionally
+8) is enough.

Rough payload sanity: even if US freeway/tollway linework totals ~100,000 km, a
res-7 polyfill is on the order of ~10⁵ cells → single-digit MB as zstd
GeoArrow/parquet. Ship it whole; no tiling at res 7.

---

## 3. Hexes vs linestrings — do you still use the lines?

You're committed to hexes. The linestrings can play one of three roles; pick
deliberately:

- **Hexes do everything (simplest).** Polyfill freeway lines → res-7 cells once,
  offline. Those cells are *both* the render geometry (GeoArrow H3 layer) *and* the
  hazard key. Drop the linestrings after the polyfill. Cleanest data model, one
  primitive on the map.

- **Hybrid: lines render, hexes/pixels do the join.** Keep the linestrings for a
  `PathLayer` (actual road shape, which reads better than a hex chain), and use the
  hexes — or just the GEFS pixel index — only to look up the hazard value per
  segment. More honest-looking roads; two geometries to carry.

- **Lines only (no hexes at all).** The thing we discussed last round: with 2,633
  segments you can skip H3 entirely and pre-join each segment to its GEFS pixel.
  You've decided against this, but note it's still the lightest option if the hex
  *look* turns out not to matter.

The linestrings are never *required* once you've polyfilled — their only remaining
job is nicer rendering. Decide whether the hex-chain look is acceptable; if yes,
option 1 and you can discard the lines.

---

## 4. Read path: static GeoParquet vs DataFusion at runtime

**At this data size, read precomputed GeoParquet/GeoArrow. Do not run DataFusion at
runtime.**

Why:

- The infra layer is **2,633 segments / ~10⁵ hexes** — a single small file. There is
  nothing to query at runtime; you load it once and render. A query engine in the
  hot path buys you nothing here and adds weight (and, in the browser, the plan
  explicitly bans a WASM query engine — runtime "just loads static
  GeoArrow/parquet").
- The hazard is the only thing that changes per frame, and that's a Zarr
  range-read + threshold, not a SQL query.

**Where DataFusion *does* earn its place: the offline precompute (ETL), not
runtime.** Use it (or DuckDB native) once to: filter Overture/Natural Earth →
freeway+tollway+US, reproject if needed, H3-polyfill the lines to res 7, and write
`freeways_conus_r7.parquet`. DataFusion is a fine ETL engine (and has H3/Sedona
spatial extensions); it's just the wrong tool to sit in the render loop.

Switch to a runtime query engine only if you later scale to *all roads* or
*buildings* CONUS-wide with per-viewport filtering — i.e. when the data no longer
fits "load whole, render." Freeways alone never hit that.

### Net recommended shape

```
offline (once):
  Natural Earth / Overture  → filter (Freeway|Tollway, US) → reproject to 4326
    → H3 polyfill @ res 7 → freeways_conus_r7.parquet   (hex_id, [geometry])

runtime (per frame t):
  GEFS Zarr [var, member, lead=t]  →  value at each hex centroid
    (closed-form lat/lon → pixel index; precompute the index per hex)
    → threshold → color/light the hex
  load freeways_conus_r7.parquet ONCE; no query engine
```

---

## Open decisions left for you

- Res 7 only, or res 7 + res 8 for metro zoom?
- Hexes-only render (discard lines) vs lines render + hex/pixel join?
- Which hazard variable + threshold first (2 m temp? 10 m wind? precip?).
- Hazard reduction per hex: ensemble mean, or "% members over threshold" (softer,
  more honest at GEFS spread)?

Sources:
- [dynamical.org — NOAA GEFS forecast, 35 day](https://dynamical.org/catalog/noaa-gefs-forecast-35-day/)
- [source.coop — NOAA GEFS forecast 35-day](https://source.coop/dynamical/noaa-gefs-forecast-35-day)
