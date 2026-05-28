import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Field shader: samples the 8 bound LCR-input Texture2DArrays and writes a
 * single scalar to color.r based on `bandMode`:
 *   0 = LCR composite (0..12)
 *   1 = temperature_2m (degC)
 *   2 = precipitation rate (mm/h)
 *   3 = 10 m wind speed (mph)
 *   4 = total cloud cover (percent)
 *
 * Downstream LinearRescale + Colormap convert the scalar to RGBA.
 */
export type FieldShaderProps = {
  layerIndex: number;
  bandMode: number;
  tempTex: Texture;
  prateTex: Texture;
  csnowTex: Texture;
  cfrzrTex: Texture;
  cicepTex: Texture;
  uTex: Texture;
  vTex: Texture;
  tccTex: Texture;
};

const MODULE_NAME = "field";

export const FieldShader = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float layerIndex;
  float bandMode;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": `
precision highp sampler2DArray;
uniform sampler2DArray tempTex;
uniform sampler2DArray prateTex;
uniform sampler2DArray csnowTex;
uniform sampler2DArray cfrzrTex;
uniform sampler2DArray cicepTex;
uniform sampler2DArray uTex;
uniform sampler2DArray vTex;
uniform sampler2DArray tccTex;
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float L = ${MODULE_NAME}.layerIndex;
      int mode = int(${MODULE_NAME}.bandMode + 0.5);
      vec3 uvw = vec3(geometry.uv, L);

      // Always read temp + wind (cheap) so missing-data discard is consistent
      // across modes. Other bands sampled lazily-ish (compiler will hoist).
      float tC = texture(tempTex, uvw).r;
      float u  = texture(uTex,    uvw).r;
      float v  = texture(vTex,    uvw).r;
      if (isnan(tC) || isnan(u) || isnan(v)) discard;

      float scalar = 0.0;

      if (mode == 1) {
        scalar = tC;
      } else if (mode == 2) {
        float prate = texture(prateTex, uvw).r;
        if (isnan(prate)) prate = 0.0;
        scalar = prate * 3600.0;
      } else if (mode == 3) {
        scalar = sqrt(u*u + v*v) * 2.2369363;
      } else if (mode == 4) {
        float tcc = texture(tccTex, uvw).r;
        if (isnan(tcc)) tcc = 0.0;
        scalar = tcc;
      } else {
        // mode 0: LCR composite.
        float prate = texture(prateTex, uvw).r;
        float csn   = texture(csnowTex, uvw).r;
        float cfz   = texture(cfrzrTex, uvw).r;
        float cip   = texture(cicepTex, uvw).r;
        float tcc   = texture(tccTex,   uvw).r;
        if (isnan(prate)) prate = 0.0;
        if (isnan(csn)) csn = 0.0;
        if (isnan(cfz)) cfz = 0.0;
        if (isnan(cip)) cip = 0.0;
        if (isnan(tcc)) tcc = 50.0;

        float tF   = tC * 1.8 + 32.0;
        float qpf  = prate * 3600.0;
        float wmph = sqrt(u*u + v*v) * 2.2369363;

        float fr   = step(0.5, cfz);
        float ip   = step(0.5, cip) * (1.0 - fr);
        float sn   = step(0.5, csn) * (1.0 - fr) * (1.0 - step(0.5, cip));
        float anyP = step(0.5, max(csn, max(cfz, cip)));

        float gateT = mix(step(tF, 36.0), step(tF, 38.0), sn);
        float act = anyP * step(0.00001, qpf) * gateT;

        float frScore = mix(8.0, 10.0, step(2.0, qpf));
        float ipScore = mix(5.0,  7.0, step(2.0, qpf));
        float snScore = mix(
                          mix(1.0, 3.0, step(0.5, qpf)),
                          mix(5.0, 8.0, step(5.0, qpf)),
                          step(2.0, qpf));
        float base = fr * frScore + ip * ipScore + sn * snScore;

        float lcr = base;
        lcr += step(tF, 32.0);
        lcr += step(20.0, tF) * step(tF, 30.0);
        lcr += step(20.001, wmph) * step(5.0, lcr);

        float sunny = step(tcc, 9.9999) * step(25.001, tF);
        lcr = mix(lcr, min(lcr, 3.0), sunny);
        lcr = mix(lcr, min(lcr, 7.0), sn);

        lcr *= act;
        scalar = clamp(lcr, 0.0, 12.0);
      }

      color = vec4(scalar, scalar, scalar, 1.0);
    `,
  },
  uniformTypes: {
    layerIndex: "f32",
    bandMode: "f32",
  },
  getUniforms: (props: Partial<FieldShaderProps>) => {
    return {
      layerIndex: props.layerIndex ?? 0,
      bandMode: props.bandMode ?? 0,
      tempTex: props.tempTex,
      prateTex: props.prateTex,
      csnowTex: props.csnowTex,
      cfrzrTex: props.cfrzrTex,
      cicepTex: props.cicepTex,
      uTex: props.uTex,
      vTex: props.vTex,
      tccTex: props.tccTex,
    };
  },
} as const satisfies ShaderModule<FieldShaderProps>;
