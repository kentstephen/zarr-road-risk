import * as zarr from "zarrita";
import type { HrrrArrays } from "../gefs/get-tile-data.js";
import { HRRR_GRID, LCR_BANDS, type LcrBand } from "../gefs/metadata.js";
import type { HexPixel } from "../overlay/types.js";

/**
 * Side-channel cache: for each spatial shard that covers at least one
 * freeway hex, holds a Record<LcrBand, Float32Array> of length
 * (lead × shardH × shardW) — the per-band pixel block used by the JS LCR
 * sampler.
 *
 * Keyed by `${chunkRow},${chunkCol}` — chunkRow = floor(y/shardH),
 * chunkCol = floor(x/shardW).
 */
export type LcrChunkCache = Map<string, ChunkEntry>;

export type ChunkEntry = {
  chunkRow: number;
  chunkCol: number;
  rowStart: number;
  colStart: number;
  width: number;
  height: number;
  pixels: Record<LcrBand, Float32Array>;
};

export type LcrSideChannelOptions = {
  arrs: HrrrArrays;
  hexes: readonly HexPixel[];
  initTimeIdx: number;
  signal: AbortSignal;
  onChunkLoaded: (entry: ChunkEntry) => void;
};

/**
 * Compute the unique shards needed to cover all hex pixels and fetch the
 * 8 LCR bands for each. Each band's array shape is (init, lead, y, x) with
 * inner shard ~(1, 49, 265, 300). We pin init and slice the lead dim
 * wide-open so all 49 leads come back in one fetch per shard.
 *
 * Each shard fires its `onChunkLoaded` callback as soon as all 8 bands are
 * back so the road overlay lights up progressively, not all-at-once.
 */
export async function runLcrSideChannel(
  opts: LcrSideChannelOptions,
): Promise<void> {
  const { arrs, hexes, initTimeIdx, signal, onChunkLoaded } = opts;

  // Probe inner-shard shape from any one band (all bands share it).
  const probe = arrs[LCR_BANDS[0]!];
  // zarrita exposes the OUTER chunk grid; HRRR's outer chunk is the whole
  // grid in one piece, so we'd over-fetch wildly if we used it. Use the
  // inner shard shape from the sharding codec instead — hardcoded because
  // zarrita doesn't surface it on the Array. Verified via the store's
  // `temperature_2m/zarr.json`: inner shard = (1, 49, 265, 300).
  const shardH = 265;
  const shardW = 300;
  void probe;

  // Unique (chunkRow, chunkCol) pairs covering all hex pixels.
  const unique = new Map<string, { chunkRow: number; chunkCol: number }>();
  for (const h of hexes) {
    const chunkRow = Math.floor(h.hrrr_y / shardH);
    const chunkCol = Math.floor(h.hrrr_x / shardW);
    const k = `${chunkRow},${chunkCol}`;
    if (!unique.has(k)) unique.set(k, { chunkRow, chunkCol });
  }

  // Concurrency: 3 shards at a time (~24 in-flight requests with 8 bands).
  const concurrency = 3;
  const queue = Array.from(unique.values());
  const workers: Promise<void>[] = [];
  const inflight = { i: 0 };

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (!signal.aborted) {
          const idx = inflight.i++;
          if (idx >= queue.length) return;
          const { chunkRow, chunkCol } = queue[idx]!;
          await fetchChunk({
            arrs,
            chunkRow,
            chunkCol,
            shardH,
            shardW,
            initTimeIdx,
            signal,
            onChunkLoaded,
          });
        }
      })(),
    );
  }
  await Promise.all(workers);
}

async function fetchChunk(args: {
  arrs: HrrrArrays;
  chunkRow: number;
  chunkCol: number;
  shardH: number;
  shardW: number;
  initTimeIdx: number;
  signal: AbortSignal;
  onChunkLoaded: (entry: ChunkEntry) => void;
}): Promise<void> {
  const {
    arrs,
    chunkRow,
    chunkCol,
    shardH,
    shardW,
    initTimeIdx,
    signal,
    onChunkLoaded,
  } = args;

  const rowStart = chunkRow * shardH;
  const rowEnd = Math.min(rowStart + shardH, HRRR_GRID.height);
  const colStart = chunkCol * shardW;
  const colEnd = Math.min(colStart + shardW, HRRR_GRID.width);
  const height = rowEnd - rowStart;
  const width = colEnd - colStart;

  // 8 bands in parallel; dim order = (init, lead, y, x)
  const slices = [
    initTimeIdx,
    null,
    zarr.slice(rowStart, rowEnd),
    zarr.slice(colStart, colEnd),
  ];

  const pixels = {} as Record<LcrBand, Float32Array>;
  await Promise.all(
    LCR_BANDS.map(async (band) => {
      const out = await zarr.get(arrs[band], slices, { signal });
      pixels[band] = out.data as Float32Array;
    }),
  );

  if (signal.aborted) return;
  onChunkLoaded({
    chunkRow,
    chunkCol,
    rowStart,
    colStart,
    width,
    height,
    pixels,
  });
}
