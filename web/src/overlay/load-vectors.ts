/**
 * Freeway + hex-pixel vector data, read from parquet in the browser via
 * hyparquet (columnar, no JSON.parse of a 17 MB string on the main thread).
 *
 * Built by scripts/emit_web_json.py. Same full-GET pattern as
 * roads/road-table.ts — NOT HTTP-range, because GitHub Pages gzips the
 * response and Range + Content-Encoding: gzip is incompatible.
 */

import { parquetReadObjects } from "hyparquet";
import type { FreewaySegment, HexPixel } from "./types.js";

async function fetchParquetRows(
  url: string,
  columns: string[],
): Promise<Record<string, unknown>[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  const file = await res.arrayBuffer();
  return parquetReadObjects({ file, columns });
}

export async function loadFreeways(
  url = `${import.meta.env.BASE_URL}freeways.parquet`,
): Promise<FreewaySegment[]> {
  const rows = await fetchParquetRows(url, ["seg_id", "h3_r5", "path"]);
  return rows.map((r) => ({
    seg_id: Number(r.seg_id),
    h3_r5: String(r.h3_r5),
    // hyparquet returns the nested list<list<float>> as [[lon,lat],...].
    path: r.path as [number, number][],
  }));
}

export async function loadHexPixels(
  url = `${import.meta.env.BASE_URL}hex_pixels.parquet`,
): Promise<HexPixel[]> {
  const rows = await fetchParquetRows(url, [
    "h3_r5",
    "hrrr_x",
    "hrrr_y",
    "lat",
    "lon",
  ]);
  return rows.map((r) => ({
    h3_r5: String(r.h3_r5),
    hrrr_x: Number(r.hrrr_x),
    hrrr_y: Number(r.hrrr_y),
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}
