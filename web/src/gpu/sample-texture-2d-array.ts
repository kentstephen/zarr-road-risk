import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

export type SampleTexture2DArrayProps = {
  dataTex: Texture;
  /** Lower lead layer (floor of the continuous playhead). */
  loLayer: number;
  /** Upper lead layer ((loLayer + 1) wrapped to 0 at the loop boundary). */
  hiLayer: number;
  /** Blend factor 0..1 between loLayer and hiLayer (fract of the playhead). */
  leadFrac: number;
};

const MODULE_NAME = "sampleTexture2DArray";

/**
 * Samples a sampler2DArray at two consecutive lead layers and mixes them by
 * `leadFrac`, so the animation tweens continuously instead of snapping
 * frame-to-frame (Anthony Lukach's firesmoke Pm25Layer technique — here we
 * mix two LAYERS of one texture rather than two separate textures).
 *
 * Sampling/discard otherwise matches deck.gl-raster/examples/
 * dynamical-zarr-ecmwf. NaN handling: HRRR uses NaN as nodata and we discard
 * it; when only one of the two samples is NaN (e.g. a coastline pixel that
 * appears/disappears between leads) we fall back to the finite one rather
 * than letting `mix` propagate NaN and flicker the edge.
 */
export const SampleTexture2DArray = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float loLayer;
  float hiLayer;
  float leadFrac;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": `
precision highp sampler2DArray;
uniform sampler2DArray dataTex;
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float vA = texture(dataTex, vec3(geometry.uv, ${MODULE_NAME}.loLayer)).r;
      float vB = texture(dataTex, vec3(geometry.uv, ${MODULE_NAME}.hiLayer)).r;
      bool aNan = isnan(vA);
      bool bNan = isnan(vB);
      if (aNan && bNan) discard;
      float v = aNan ? vB : (bNan ? vA : mix(vA, vB, ${MODULE_NAME}.leadFrac));
      color = vec4(v, v, v, 1.0);
    `,
  },
  uniformTypes: {
    loLayer: "f32",
    hiLayer: "f32",
    leadFrac: "f32",
  },
  getUniforms: (props: Partial<SampleTexture2DArrayProps>) => ({
    loLayer: props.loLayer ?? 0,
    hiLayer: props.hiLayer ?? props.loLayer ?? 0,
    leadFrac: props.leadFrac ?? 0,
    dataTex: props.dataTex,
  }),
} as const satisfies ShaderModule<SampleTexture2DArrayProps>;
