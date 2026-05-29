/**
 * Road-name + state lookup, read from `road_table.parquet` in the browser via
 * hyparquet (columnar, no SQL engine). Built by scripts/build_road_table.py.
 *
 * The same parquet is queryable on the CLI:
 *   duckdb -c "SELECT state, count(*) FROM 'road_table.parquet'
 *              WHERE road_name IS NOT NULL GROUP BY state ORDER BY 2 DESC"
 */

import { parquetReadObjects } from "hyparquet";
import type { LcrResult } from "../lcr/compute.js";

export type RoadInfo = { roadName: string | null; state: string | null };

/** h3_r5 -> { roadName, state }. Cells with no Overture match are absent. */
export async function loadRoadTable(
  url = `${import.meta.env.BASE_URL}road_table.parquet`,
): Promise<Map<string, RoadInfo>> {
  // Fetch the whole file (~295 KB) rather than HTTP-range it. GitHub Pages
  // gzips the response, and Range + Content-Encoding: gzip is incompatible
  // (ranges index the compressed stream, the browser hands back decompressed
  // bytes) — which makes range-based readers see a bogus footer. A full GET
  // decompresses cleanly; an ArrayBuffer satisfies hyparquet's AsyncBuffer.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`road table fetch failed ${res.status}`);
  const file = await res.arrayBuffer();
  const rows = await parquetReadObjects({
    file,
    columns: ["h3_r5", "road_name", "state"],
  });
  const out = new Map<string, RoadInfo>();
  for (const r of rows) {
    out.set(String(r.h3_r5), {
      roadName: r.road_name == null ? null : String(r.road_name),
      state: r.state == null ? null : String(r.state),
    });
  }
  return out;
}

export const UNNAMED_ROAD = "(unnamed)";
export const UNKNOWN_STATE = "—";

export type AffectedRoad = { name: string; lcr: number };
export type StateGroup = { state: string; roads: AffectedRoad[] };

/**
 * Roads currently lit up (LCR > 0) for the active frame, grouped by state
 * (two-letter code, alphabetical). Within a state, one row per road keeping
 * the worst LCR, sorted by severity. Hexes with no road name collapse into a
 * single `(unnamed)` row for their state; hexes with no state fall under `—`.
 *
 * Derived purely from the live `hexLcr` map — a road appears when its hexes
 * light up and drops out of the result once they go quiet.
 */
export function affectedByState(
  hexLcr: ReadonlyMap<string, LcrResult>,
  lookup: ReadonlyMap<string, RoadInfo>,
): StateGroup[] {
  const states = new Map<string, Map<string, number>>();
  for (const [h3, res] of hexLcr) {
    if (!(res.lcr > 0)) continue;
    const info = lookup.get(h3);
    const state = info?.state ?? UNKNOWN_STATE;
    const name = info?.roadName ?? UNNAMED_ROAD;
    let roads = states.get(state);
    if (!roads) {
      roads = new Map();
      states.set(state, roads);
    }
    roads.set(name, Math.max(roads.get(name) ?? 0, res.lcr));
  }
  return [...states.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, roads]) => ({
      state,
      roads: [...roads.entries()]
        .map(([name, lcr]) => ({ name, lcr }))
        .sort((a, b) => b.lcr - a.lcr || a.name.localeCompare(b.name)),
    }));
}
