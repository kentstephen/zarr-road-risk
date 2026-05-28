import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import type { LcrBand } from "./metadata.js";

/** Map of zarr arrays (one per LCR band). Opened once, reused by both the
 *  raster ZarrLayer (single band at a time) and the LCR side channel. */
export type GefsArrays = Record<LcrBand, zarr.Array<"float32", zarr.Readable>>;

/**
 * Per-tile data: one Texture2DArray for the selected band, depth = number
 * of leads in the current lead-time window (one on-disk chunk worth).
 */
export type GefsTileData = MinimalTileData & {
  texture: Texture;
  /** Tile origin in pixel coords (top-left), so a JS sampler can subtract. */
  tileX: number;
  tileY: number;
};

/**
 * Build a `getTileData` callback bound to a specific lead-time window depth.
 * The ZarrLayer will hand us a chunk shaped (depth, height, width); we
 * upload that into a Texture2DArray.
 *
 * Mirrors deck.gl-raster/examples/dynamical-zarr-ecmwf/src/ecmwf/get-tile-data.ts,
 * except depth is the window length rather than a fixed dataset-wide count.
 */
export function makeGetTileData(depth: number) {
  return async function getTileData(
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
    if (chunk.shape[0] !== depth) {
      throw new Error(
        `Expected depth ${depth}, got ${chunk.shape[0]}`,
      );
    }
    if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
      throw new Error(
        `Tile shape mismatch: expected [${depth}, ${height}, ${width}], got [${chunk.shape.join(", ")}]`,
      );
    }

    const texture = device.createTexture({
      dimension: "2d-array",
      format: "r32float",
      width,
      height,
      depth,
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
    // sliceSpec is [init, ens, lead-slice, lat-slice, lon-slice]: the two
    // spatial slices are the last two, lat first then lon.
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
  };
}
