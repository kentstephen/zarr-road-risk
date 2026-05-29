import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { FilterRange } from "../gpu/filter-range.js";
import { SampleTexture2DArray } from "../gpu/sample-texture-2d-array.js";
import type { FieldChoice } from "./metadata.js";
import type { HrrrTileData } from "./get-tile-data.js";

export type MakeRenderTileArgs = {
  /** Lower lead layer (floor of the continuous playhead). */
  loLayer: number;
  /** Upper lead layer ((loLayer + 1) wrapped at the loop boundary). */
  hiLayer: number;
  /** Blend 0..1 between loLayer and hiLayer (fract of the playhead). */
  leadFrac: number;
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
  const { loLayer, hiLayer, leadFrac, field, colormapTexture, rescaleMin, rescaleMax } =
    args;
  return function renderTile(data: HrrrTileData): RenderTileResult {
    // Discard pixels at/below the field's "dead value" (in raw zarr units).
    // hideAtOrBelow is in DISPLAY units; divide by displayScale to convert.
    // We use `filterMin = threshold + epsilon` so the threshold itself is
    // also discarded (FilterRange is inclusive on the bound).
    const filterMinDisplay = field.hideAtOrBelow;
    const useFilter = filterMinDisplay !== undefined;
    const filterMinRaw = useFilter
      ? filterMinDisplay / field.displayScale + 1e-7
      : Number.NEGATIVE_INFINITY;
    return {
      renderPipeline: [
        {
          module: SampleTexture2DArray,
          props: { dataTex: data.texture, loLayer, hiLayer, leadFrac },
        },
        ...(useFilter
          ? [
              {
                module: FilterRange,
                props: {
                  filterMin: filterMinRaw,
                  filterMax: Number.POSITIVE_INFINITY,
                },
              },
            ]
          : []),
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
