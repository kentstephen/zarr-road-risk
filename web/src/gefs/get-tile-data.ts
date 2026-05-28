import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { HRRR_LEAD_TIME_COUNT, type LcrBand } from "./metadata.js";

/** Map of zarr arrays (one per LCR band). Opened once, reused by both the
 *  raster ZarrLayer (single band at a time) and the LCR side channel. */
export type HrrrArrays = Record<LcrBand, zarr.Array<"float32", zarr.Readable>>;

/** Per-tile data: a Texture2DArray with all 49 leads for one spatial shard. */
export type HrrrTileData = MinimalTileData & {
  texture: Texture;
  /** Tile origin in pixel coords (top-left), for any future JS sampler. */
  tileX: number;
  tileY: number;
};

/**
 * Slice one spatial shard of an HRRR variable array and upload as a
 * Texture2DArray (one layer per lead_time). Mirrors the ECMWF example's
 * `getTileData` — depth is fixed at HRRR_LEAD_TIME_COUNT because the shard
 * already bundles all 49 leads.
 */
export async function getTileData(
  arr: zarr.Array<"float32", zarr.Readable>,
  options: GetTileDataOptions,
): Promise<HrrrTileData> {
  const { device, sliceSpec, width, height, signal } = options;

  const chunk = await zarr.get(arr, sliceSpec, { signal });
  const { data } = chunk;

  if (chunk.shape.length !== 3) {
    throw new Error(
      `Expected 3D chunk (lead_time, y, x), got [${chunk.shape.join(", ")}]`,
    );
  }
  if (chunk.shape[0] !== HRRR_LEAD_TIME_COUNT) {
    throw new Error(
      `Expected depth ${HRRR_LEAD_TIME_COUNT}, got ${chunk.shape[0]}`,
    );
  }
  if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
    throw new Error(
      `Tile shape mismatch: expected [${HRRR_LEAD_TIME_COUNT}, ${height}, ${width}], got [${chunk.shape.join(", ")}]`,
    );
  }

  const texture = device.createTexture({
    dimension: "2d-array",
    format: "r32float",
    width,
    height,
    depth: HRRR_LEAD_TIME_COUNT,
    mipLevels: 1,
    data,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });

  const slices: { start: number }[] = [];
  for (const s of sliceSpec) {
    if (s && typeof s === "object" && "start" in s) {
      slices.push(s as { start: number });
    }
  }
  // sliceSpec is [init, lead-slice, y-slice, x-slice]: the two spatial
  // slices are the last two, y first then x.
  const spatialSlices = slices.slice(-2);
  const tileY = spatialSlices[0]?.start ?? 0;
  const tileX = spatialSlices[1]?.start ?? 0;

  return {
    texture,
    width,
    height,
    tileX,
    tileY,
    byteLength: data.byteLength,
  };
}
