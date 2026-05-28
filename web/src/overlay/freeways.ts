import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PathLayer } from "@deck.gl/layers";
import { computeLcr, lcrColor, type LcrResult } from "../lcr/compute.js";
import type { GefsTileData } from "../gefs/get-tile-data.js";
import { LCR_BANDS, type LcrBand } from "../gefs/metadata.js";
import type { FreewaySegment, HexPixel } from "./types.js";

/**
 * Build the per-hex LCR map for the current animation frame.
 *
 * Scans the currently-cached ZarrLayer tiles for any tile that covers a hex
 * pixel's (gefs_i, gefs_j), samples all 8 bands at the (lead, j-tileY, i-tileX)
 * cell of the CPU-side `pixels` arrays, and runs the same LCR ladder as the
 * GPU shader. Returns h3_r5 -> LcrResult.
 *
 * Hexes whose pixel falls outside any cached tile are simply absent from the
 * result, matching the lazy-tile behavior of the raster — vector layers
 * display "no data" for those cells.
 */
export function buildHexLcr(
  hexes: HexPixel[],
  tiles: readonly GefsTileData[],
  leadIdx: number,
): Map<string, LcrResult> {
  const out = new Map<string, LcrResult>();
  if (tiles.length === 0) return out;

  for (const hex of hexes) {
    const tile = findTileFor(tiles, hex.gefs_i, hex.gefs_j);
    if (!tile) continue;
    const lx = hex.gefs_i - tile.tileX;
    const ly = hex.gefs_j - tile.tileY;
    const cellsPerLayer = tile.width * tile.height;
    const cellIdx = leadIdx * cellsPerLayer + ly * tile.width + lx;
    const sample = {} as Record<LcrBand, number>;
    for (const band of LCR_BANDS) {
      const arr = tile.pixels[band];
      sample[band] = arr[cellIdx] ?? NaN;
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

function findTileFor(
  tiles: readonly GefsTileData[],
  i: number,
  j: number,
): GefsTileData | null {
  for (const t of tiles) {
    if (
      i >= t.tileX &&
      i < t.tileX + t.width &&
      j >= t.tileY &&
      j < t.tileY + t.height
    ) {
      return t;
    }
  }
  return null;
}

export type FreewayLayerProps = {
  segments: FreewaySegment[];
  hexes: HexPixel[];
  hexLcr: Map<string, LcrResult>;
  /** Optional update trigger; pass leadIdx so deck.gl rebuilds accessors per frame. */
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
      getWidth: 2,
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
