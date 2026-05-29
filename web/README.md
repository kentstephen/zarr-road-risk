# web — HRRR LCR road-risk viewer

Browser viewer for live HRRR forecast rasters + freeway Low-Confidence-Road
(LCR) hazard scoring, built on `@developmentseed/deck.gl-raster` + MapLibre.

## Run

```sh
npm install
npm run dev
```

The dev server defaults to **port 3000** (set in `vite.config`). To run on a
different port — e.g. if 3000 is already taken — pass `--port`:

```sh
npm run dev -- --port 5371
```

Other scripts:

```sh
npm run build       # production build -> dist/
npm run preview     # serve the built dist/
npm run typecheck   # tsc --noEmit
```

## Data

The app reads:

- Live HRRR forecast zarr (Dynamical) for the raster + LCR side channel.
- `public/freeways.json` / `public/hex_pixels.json` — freeway geometry + the
  r5 hex grid, emitted by `scripts/emit_web_json.py` from the parquets in
  `../data/`.
