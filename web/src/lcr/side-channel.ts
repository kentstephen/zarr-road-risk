import * as zarr from "zarrita";
import type { GefsArrays } from "../gefs/get-tile-data.js";
import { GEFS_GRID, LCR_BANDS, type LcrBand } from "../gefs/metadata.js";
import type { HexPixel } from "../overlay/types.js";

/**
 * Side-channel cache: for each spatial chunk that covers at least one
 * freeway hex, holds a Record<LcrBand, Float32Array> of length
 * (lead × chunkH × chunkW) — the same data the raster layer would have
 * cached if we still did the 8-band fetch.
 *
 * Keyed by `${chunkRow},${chunkCol}` — chunkRow = floor(lat/chunkH),
 * chunkCol = floor(lon/chunkW).
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
  arrs: GefsArrays;
  hexes: readonly HexPixel[];
  initTimeIdx: number;
  ensembleMemberIdx: number;
  signal: AbortSignal;
  onChunkLoaded: (entry: ChunkEntry) => void;
};

/**
 * Compute the unique chunks needed to cover all hex pixels and fetch the
 * 8 LCR bands for each. Each band's array shape is (init, ens, lead, lat, lon)
 * with chunking ~(1, 31, 64, 17, 16). We pin init + ens and slice the lead
 * dim wide-open so we get all 181 leads per chunk.
 *
 * Each chunk fires its `onChunkLoaded` callback as soon as all 8 bands are
 * back so the road overlay can light up progressively, not all-at-once.
 */
export async function runLcrSideChannel(
  opts: LcrSideChannelOptions,
): Promise<void> {
  const { arrs, hexes, initTimeIdx, ensembleMemberIdx, signal, onChunkLoaded } =
    opts;

  // Probe chunk shape from any one band (all bands share it).
  const probe = arrs[LCR_BANDS[0]!];
  const chunks = probe.chunks;
  if (chunks.length !== 5) {
    throw new Error(`Expected 5D chunks, got ${chunks.length}`);
  }
  const chunkH = chunks[3]!;
  const chunkW = chunks[4]!;

  // Unique (chunkRow, chunkCol) pairs covering all hex pixels.
  const unique = new Map<string, { chunkRow: number; chunkCol: number }>();
  for (const h of hexes) {
    const chunkRow = Math.floor(h.gefs_j / chunkH);
    const chunkCol = Math.floor(h.gefs_i / chunkW);
    const k = `${chunkRow},${chunkCol}`;
    if (!unique.has(k)) unique.set(k, { chunkRow, chunkCol });
  }

  // Concurrency: 3 chunks at a time (~24 in-flight requests with 8 bands).
  // Keeps the raster ZarrLayer's network budget intact — its tiles take
  // priority because they're what the user is staring at.
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
            chunkH,
            chunkW,
            initTimeIdx,
            ensembleMemberIdx,
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
  arrs: GefsArrays;
  chunkRow: number;
  chunkCol: number;
  chunkH: number;
  chunkW: number;
  initTimeIdx: number;
  ensembleMemberIdx: number;
  signal: AbortSignal;
  onChunkLoaded: (entry: ChunkEntry) => void;
}): Promise<void> {
  const {
    arrs,
    chunkRow,
    chunkCol,
    chunkH,
    chunkW,
    initTimeIdx,
    ensembleMemberIdx,
    signal,
    onChunkLoaded,
  } = args;

  const rowStart = chunkRow * chunkH;
  const rowEnd = Math.min(rowStart + chunkH, GEFS_GRID.height);
  const colStart = chunkCol * chunkW;
  const colEnd = Math.min(colStart + chunkW, GEFS_GRID.width);
  const height = rowEnd - rowStart;
  const width = colEnd - colStart;

  // 8 bands in parallel; dim order = (init, ens, lead, lat, lon)
  const slices = [
    initTimeIdx,
    ensembleMemberIdx,
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
