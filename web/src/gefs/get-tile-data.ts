import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { GEFS_LEAD_TIME_COUNT, LCR_BANDS, type LcrBand } from "./metadata.js";

/**
 * Per-tile data: one Texture2DArray per LCR input band, depth = 181 leads.
 * Bands share the chunk grid, so a single sliceSpec works for all.
 *
 * `pixels` keeps a CPU-side copy of the same chunk data, keyed by band, so
 * the JS LCR pipeline can sample at hex (gefs_i, gefs_j) without re-reading
 * the store. Sized `depth*height*width` per band.
 */
export type GefsTileData = MinimalTileData & {
  textures: Record<LcrBand, Texture>;
  pixels: Record<LcrBand, Float32Array>;
  /** Tile origin in pixel coords (top-left), so JS samplers can subtract. */
  tileX: number;
  tileY: number;
};

export type GefsArrays = Record<LcrBand, zarr.Array<"float32", zarr.Readable>>;

/**
 * Factory that closes over the per-band zarr arrays and returns a
 * getTileData compatible with @developmentseed/deck.gl-zarr's ZarrLayer.
 *
 * On each tile, fetches the same sliceSpec from all 8 bands in parallel and
 * uploads each as an r32float 2d-array texture (depth = lead_time count).
 */
export function makeGetTileData(arrs: GefsArrays) {
  return async function getTileData(
    _arr: zarr.Array<"float32", zarr.Readable>,
    options: GetTileDataOptions,
  ): Promise<GefsTileData> {
    const { device, sliceSpec, width, height, signal } = options;

    const chunks = await Promise.all(
      LCR_BANDS.map((b) => zarr.get(arrs[b], sliceSpec, { signal })),
    );

    // Use the first chunk to validate the shape; all bands share the grid.
    const first = chunks[0]!;
    if (first.shape.length !== 3) {
      throw new Error(
        `Expected 3D chunk (lead_time, y, x), got [${first.shape.join(", ")}]`,
      );
    }
    if (first.shape[0] !== GEFS_LEAD_TIME_COUNT) {
      throw new Error(
        `Expected depth ${GEFS_LEAD_TIME_COUNT}, got ${first.shape[0]}`,
      );
    }
    if (first.shape[1] !== height || first.shape[2] !== width) {
      throw new Error(
        `Tile shape mismatch: expected [${GEFS_LEAD_TIME_COUNT}, ${height}, ${width}], got [${first.shape.join(", ")}]`,
      );
    }

    const textures: Partial<Record<LcrBand, Texture>> = {};
    const pixels: Partial<Record<LcrBand, Float32Array>> = {};
    let totalBytes = 0;
    for (let i = 0; i < LCR_BANDS.length; i++) {
      const band = LCR_BANDS[i]!;
      const chunk = chunks[i]!;
      const data = chunk.data as Float32Array;
      textures[band] = device.createTexture({
        dimension: "2d-array",
        format: "r32float",
        width,
        height,
        depth: GEFS_LEAD_TIME_COUNT,
        mipLevels: 1,
        data,
        sampler: {
          minFilter: "nearest",
          magFilter: "nearest",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        },
      });
      pixels[band] = data;
      totalBytes += data.byteLength;
    }

    // sliceSpec is positional (one entry per array dim). The two spatial
    // dims (latitude, longitude — in that order) are sliced; the rest are
    // number|null from the user-supplied selection. Extract the two
    // slice-valued entries; the first encountered is latitude (j), the
    // second is longitude (i).
    const slices: { start: number }[] = [];
    for (const s of sliceSpec) {
      if (s && typeof s === "object" && "start" in s) {
        slices.push(s as { start: number });
      }
    }
    const tileY = slices[0]?.start ?? 0;
    const tileX = slices[1]?.start ?? 0;

    return {
      textures: textures as Record<LcrBand, Texture>,
      pixels: pixels as Record<LcrBand, Float32Array>,
      tileX,
      tileY,
      width,
      height,
      byteLength: totalBytes,
    };
  };
}

