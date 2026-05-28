import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { FieldShader } from "../gpu/field.js";
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
 * Pipeline: FieldShader writes the band's scalar into color.r,
 * LinearRescale maps [rescaleMin, rescaleMax] -> [0, 1], Colormap turns it
 * into RGBA via the band's colormap.
 */
export function makeRenderTile(args: MakeRenderTileArgs) {
  const { layerIndex, field, colormapTexture, rescaleMin, rescaleMax } = args;
  return function renderTile(data: GefsTileData): RenderTileResult {
    return {
      renderPipeline: [
        {
          module: FieldShader,
          props: {
            layerIndex,
            bandMode: field.bandMode,
            tempTex: data.textures.temperature_2m,
            prateTex: data.textures.precipitation_surface,
            csnowTex: data.textures.categorical_snow_surface,
            cfrzrTex: data.textures.categorical_freezing_rain_surface,
            cicepTex: data.textures.categorical_ice_pellets_surface,
            uTex: data.textures.wind_u_10m,
            vTex: data.textures.wind_v_10m,
            tccTex: data.textures.total_cloud_cover_atmosphere,
          },
        },
        {
          module: LinearRescale,
          props: {
            rescaleMin: rescaleMin ?? field.rescaleMin,
            rescaleMax: rescaleMax ?? field.rescaleMax,
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
