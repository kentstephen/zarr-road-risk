import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { GEFS_LEAD_TIME_COUNT, type LcrBand } from "./metadata.js";

/** Map of zarr arrays (one per LCR band). Opened once, reused by both the
 *  raster ZarrLayer (single band at a time) and the LCR side channel. */
export type GefsArrays = Record<LcrBand, zarr.Array<"float32", zarr.Readable>>;

/**
 * Per-tile data: one Texture2DArray for the selected band.
 * Depth = GEFS_LEAD_TIME_COUNT, all leads stacked.
 *
 * Mirrors deck.gl-raster/examples/dynamical-zarr-ecmwf/src/ecmwf/get-tile-data.ts
 * exactly — one band, one chunk per tile.
 */
export type GefsTileData = MinimalTileData & {
  texture: Texture;
  /** Tile origin in pixel coords (top-left), so a JS sampler can subtract. */
  tileX: number;
  tileY: number;
};

export async function getTileData(
  arr: zarr.Array<"float32", zarr.Readable>,
  options: GetTileDataOptions,
): Promise<GefsTileData> {
  const { device, sliceSpec, width, height, signal } = options;

  const chunk = await zarr.get(arr, sliceSpec, { signal });
  const { data } = chunk;

  if (chunk.shape.length !== 3) {
    throw new Error(
      `Expected 3D chunk (lead_time, y, x), got [${chunk.shape.join(", ")}]`,
    );
  }
  if (chunk.shape[0] !== GEFS_LEAD_TIME_COUNT) {
    throw new Error(
      `Expected depth ${GEFS_LEAD_TIME_COUNT}, got ${chunk.shape[0]}`,
    );
  }
  if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
    throw new Error(
      `Tile shape mismatch: expected [${GEFS_LEAD_TIME_COUNT}, ${height}, ${width}], got [${chunk.shape.join(", ")}]`,
    );
  }

  const texture = device.createTexture({
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

  // Spatial slices in the positional sliceSpec — first is latitude (j),
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
    texture,
    width,
    height,
    tileX,
    tileY,
    byteLength: data.byteLength,
  };
}
