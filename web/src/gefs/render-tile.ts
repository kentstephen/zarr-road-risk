import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { SampleTexture2DArray } from "../gpu/sample-texture-2d-array.js";
import type { FieldChoice } from "./metadata.js";
import type { GefsTileData } from "./get-tile-data.js";

export type MakeRenderTileArgs = {
  layerIndex: number;
  field: FieldChoice;
  colormapTexture: Texture;
  rescaleMin?: number;
  rescaleMax?: number;
};

/**
 * Pipeline (matches the ECMWF example): sample the band texture at the
 * current lead, LinearRescale to [0,1], Colormap to RGBA.
 *
 * Per-band scalar transforms (prate → mm/h, wind → mph, °C→°F) are folded
 * into the rescaleMin/rescaleMax we choose for each field, since the GPU
 * sees the raw value from the zarr (kg/m²/s, m/s, °C).
 */
export function makeRenderTile(args: MakeRenderTileArgs) {
  const { layerIndex, field, colormapTexture, rescaleMin, rescaleMax } = args;
  return function renderTile(data: GefsTileData): RenderTileResult {
    return {
      renderPipeline: [
        {
          module: SampleTexture2DArray,
          props: { dataTex: data.texture, layerIndex },
        },
        {
          // rescale min/max are in DISPLAY units; divide by displayScale to
          // bring them back into the raw zarr units that the GPU samples.
          module: LinearRescale,
          props: {
            rescaleMin: (rescaleMin ?? field.rescaleMin) / field.displayScale,
            rescaleMax: (rescaleMax ?? field.rescaleMax) / field.displayScale,
          },
        },
        {
          module: Colormap,
          props: {
            colormapTexture,
            colormapIndex: field.colormapIndex,
            reversed: field.reversed,
          },
        },
      ],
    };
  };
}
