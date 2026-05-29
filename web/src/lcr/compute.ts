/**
 * Plain-JS twin of web/src/gpu/lcr.ts and scripts/verify_lcr.py `lcr_score`.
 *
 * Single source of truth for the per-hex LCR used to color the freeway
 * PathLayer + H3HexagonLayer, and to populate the picking tooltip.
 */

export type LcrInputs = {
  tC: number;
  prate: number;
  csnow: number;
  cfrzr: number;
  cicep: number;
  u10: number;
  v10: number;
  tcc: number;
};

export type LcrFactor =
  | "freezing-rain"
  | "ice-pellets"
  | "snow"
  | "below-freezing"
  | "critical-icing-band"
  | "high-wind"
  | "sunny-cap"
  | "snow-cap";

export type LcrResult = {
  lcr: number;
  factors: LcrFactor[];
  active: boolean;
  qpfMmH: number;
  windMph: number;
  tempF: number;
};

const C_TO_F = (c: number) => c * 1.8 + 32;
const MS_TO_MPH = 2.2369363;

/** Compute LCR (0..12) for a single pixel. Mirrors the GLSL implementation. */
export function computeLcr(x: LcrInputs): LcrResult {
  const factors: LcrFactor[] = [];
  // Treat NaN inputs as "no data" => inactive, 0.
  if (
    !Number.isFinite(x.tC) ||
    !Number.isFinite(x.prate) ||
    !Number.isFinite(x.csnow) ||
    !Number.isFinite(x.cfrzr) ||
    !Number.isFinite(x.cicep) ||
    !Number.isFinite(x.u10) ||
    !Number.isFinite(x.v10) ||
    !Number.isFinite(x.tcc)
  ) {
    return {
      lcr: 0,
      factors,
      active: false,
      qpfMmH: NaN,
      windMph: NaN,
      tempF: NaN,
    };
  }
  const tF = C_TO_F(x.tC);
  const qpf = x.prate * 3600;
  const wmph = Math.hypot(x.u10, x.v10) * MS_TO_MPH;

  const fr = x.cfrzr > 0.5;
  const ip = !fr && x.cicep > 0.5;
  const sn = !fr && !ip && x.csnow > 0.5;
  const anyP = fr || ip || sn;
  const gateT = sn ? tF <= 38 : tF <= 36;
  const active = anyP && qpf > 0 && gateT;

  let lcr = 0;
  if (fr) {
    lcr = qpf >= 2 ? 10 : 8;
    factors.push("freezing-rain");
  } else if (ip) {
    lcr = qpf >= 2 ? 7 : 5;
    factors.push("ice-pellets");
  } else if (sn) {
    lcr = qpf >= 5 ? 8 : qpf >= 2 ? 5 : qpf >= 0.5 ? 3 : 1;
    factors.push("snow");
  }

  if (tF <= 32) {
    lcr += 1;
    factors.push("below-freezing");
  }
  if (tF >= 20 && tF <= 30) {
    lcr += 1;
    factors.push("critical-icing-band");
  }
  if (wmph > 20 && lcr >= 5) {
    lcr += 1;
    factors.push("high-wind");
  }
  if (x.tcc < 10 && tF > 25) {
    const capped = Math.min(lcr, 3);
    if (capped < lcr) factors.push("sunny-cap");
    lcr = capped;
  }
  if (sn) {
    const capped = Math.min(lcr, 7);
    if (capped < lcr) factors.push("snow-cap");
    lcr = capped;
  }

  if (!active) lcr = 0;
  lcr = Math.max(0, Math.min(12, lcr));

  return { lcr, factors, active, qpfMmH: qpf, windMph: wmph, tempF: tF };
}

/**
 * LCR -> RGBA hazard ramp.
 * No-hazard baseline is silver at very low alpha so it recedes into the
 * basemap and highlighted segments dominate.
 * Affected roads ramp by hue only — light orange at low LCR, deepening to
 * burnt orange at the top — all at full opacity.
 * Deliberately no red — Stephen has reduced red sensitivity.
 */
export function lcrColor(lcr: number): [number, number, number, number] {
  if (!(lcr > 0)) return [165, 170, 178, 38]; // silver baseline, recede hard
  const t = Math.max(0, Math.min(1, lcr / 12));
  const stops: [number, [number, number, number]][] = [
    [0.0, [255, 175, 60]],
    [0.5, [240, 120, 25]],
    [1.0, [170, 65, 5]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    if (t <= t1) {
      const [t0, c0] = stops[i - 1]!;
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
        255,
      ];
    }
  }
  return [170, 65, 5, 255];
}
