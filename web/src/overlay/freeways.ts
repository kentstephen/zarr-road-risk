import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PathLayer } from "@deck.gl/layers";
import { computeLcr, lcrColor, type LcrResult } from "../lcr/compute.js";
import type { ChunkEntry } from "../lcr/side-channel.js";
import { LCR_BANDS, type LcrBand } from "../gefs/metadata.js";
import type { FreewaySegment, HexPixel } from "./types.js";

/**
 * Build the per-hex LCR map for the current animation frame, sampling the
 * side-channel chunk cache at each hex pixel.
 *
 * Hexes whose chunk isn't loaded yet are absent from the result — the path
 * layer falls back to silver for those.
 */
export function buildHexLcr(
  hexes: HexPixel[],
  chunks: ReadonlyMap<string, ChunkEntry>,
  leadIdx: number,
): Map<string, LcrResult> {
  const out = new Map<string, LcrResult>();
  if (chunks.size === 0) return out;

  // Determine chunk grid step from any one entry.
  const first = chunks.values().next().value as ChunkEntry | undefined;
  if (!first) return out;
  const chunkH = first.height;
  const chunkW = first.width;

  for (const hex of hexes) {
    const chunkRow = Math.floor(hex.hrrr_y / chunkH);
    const chunkCol = Math.floor(hex.hrrr_x / chunkW);
    const entry = chunks.get(`${chunkRow},${chunkCol}`);
    if (!entry) continue;
    const lx = hex.hrrr_x - entry.colStart;
    const ly = hex.hrrr_y - entry.rowStart;
    const cellsPerLayer = entry.width * entry.height;
    const cellIdx = leadIdx * cellsPerLayer + ly * entry.width + lx;
    const sample = {} as Record<LcrBand, number>;
    for (const band of LCR_BANDS) {
      sample[band] = entry.pixels[band][cellIdx] ?? NaN;
    }
    const result = computeLcr({
      tC: sample.temperature_2m,
      prate: sample.precipitation_surface,
      csnow: sample.categorical_snow_surface,
      cfrzr: sample.categorical_freezing_rain_surface,
      cicep: sample.categorical_ice_pellets_surface,
      u10: sample.wind_u_10m,
      v10: sample.wind_v_10m,
      tcc: sample.total_cloud_cover_atmosphere,
    });
    out.set(hex.h3_r5, result);
  }
  return out;
}

export type FreewayLayerProps = {
  segments: FreewaySegment[];
  hexes: HexPixel[];
  hexLcr: Map<string, LcrResult>;
  updateKey: number;
  onHexPick?: (h: HexPixel | null, lcr: LcrResult | undefined) => void;
  showPaths?: boolean;
  showHexes?: boolean;
};

export function buildFreewayLayers(props: FreewayLayerProps) {
  const {
    segments,
    hexes,
    hexLcr,
    updateKey,
    onHexPick,
    showPaths = true,
    showHexes = true,
  } = props;
  const segColor = (s: FreewaySegment): [number, number, number, number] => {
    const lcr = hexLcr.get(s.h3_r5)?.lcr ?? 0;
    return lcrColor(lcr);
  };
  return [
    new PathLayer<FreewaySegment>({
      id: "freeway-paths",
      visible: showPaths,
      data: segments,
      getPath: (s) => s.path,
      getColor: segColor,
      getWidth: 1,
      widthUnits: "pixels",
      widthMinPixels: 1,
      jointRounded: true,
      capRounded: true,
      parameters: { depthCompare: "always" } as never,
      updateTriggers: { getColor: updateKey },
    }),
    new H3HexagonLayer<HexPixel>({
      id: "freeway-hex-pick",
      visible: showHexes,
      data: hexes,
      getHexagon: (h) => h.h3_r5,
      getFillColor: (h) => {
        const r = hexLcr.get(h.h3_r5);
        if (!r || r.lcr <= 0) return [0, 0, 0, 0];
        const c = lcrColor(r.lcr);
        return [c[0], c[1], c[2], 80];
      },
      filled: true,
      stroked: false,
      extruded: false,
      pickable: true,
      onClick: (info) => {
        if (!onHexPick) return;
        const obj = (info.object as HexPixel | null) ?? null;
        onHexPick(obj, obj ? hexLcr.get(obj.h3_r5) : undefined);
      },
      updateTriggers: { getFillColor: updateKey },
    }),
  ];
}
