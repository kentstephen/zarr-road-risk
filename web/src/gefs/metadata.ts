import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";

/**
 * Hardcoded GeoZarr-compliant attrs for the dynamical NOAA GEFS 35-day store.
 *
 * Grid: 721 lat (90 -> -90 step -0.25) × 1440 lon (-180 -> 179.75 step 0.25).
 * CRS: WMO spherical ellipsoid in source; rendered as EPSG:4326.
 */
export const GEFS_GEOZARR_ATTRS = {
  "spatial:dimensions": ["latitude", "longitude"],
  "spatial:transform": [0.25, 0, -180, 0, -0.25, 90],
  "spatial:shape": [721, 1440],
  "proj:code": "EPSG:4326",
} as const;

export const GEFS_NON_SPATIAL_DIMS = [
  "init_time",
  "ensemble_member",
  "lead_time",
] as const;

/**
 * Lead-time schedule (hours): 3-hourly 0..240, 6-hourly 246..840.
 * 81 + 100 = 181 entries; matches the lead_time dim length.
 */
export const GEFS_LEAD_TIME_HOURS: readonly number[] = (() => {
  const hours: number[] = [];
  for (let h = 0; h <= 240; h += 3) hours.push(h);
  for (let h = 246; h <= 840; h += 6) hours.push(h);
  return hours;
})();

export const GEFS_LEAD_TIME_COUNT = GEFS_LEAD_TIME_HOURS.length;

/**
 * Lead-time chunk size on disk (verified via scripts/inspect_gefs_chunks.py).
 * Slicing the lead_time dim to this size cuts the per-tile fetch count from
 * 3 lead-chunks (all 181 leads) down to 1.
 */
export const GEFS_LEAD_CHUNK_SIZE = 64;

/** Window of lead indices [start, end) that contains `leadIdx`. */
export function leadChunkWindow(leadIdx: number): { start: number; end: number } {
  const start = Math.floor(leadIdx / GEFS_LEAD_CHUNK_SIZE) * GEFS_LEAD_CHUNK_SIZE;
  const end = Math.min(start + GEFS_LEAD_CHUNK_SIZE, GEFS_LEAD_TIME_COUNT);
  return { start, end };
}

export const GEFS_LEAD_TIME_STEP_HOURS: readonly number[] = (() => {
  const steps: number[] = [];
  for (let i = 0; i < GEFS_LEAD_TIME_HOURS.length - 1; i++) {
    steps.push(GEFS_LEAD_TIME_HOURS[i + 1]! - GEFS_LEAD_TIME_HOURS[i]!);
  }
  steps.push(steps[steps.length - 1] ?? 3);
  return steps;
})();

/** Grid origin & step for closed-form pixel index ((lon+180)/0.25, (90-lat)/0.25). */
export const GEFS_GRID = {
  lonOrigin: -180,
  latOrigin: 90,
  step: 0.25,
  width: 1440,
  height: 721,
} as const;

/** Variables sampled; order is fixed and matches the GPU shader binding order. */
export const LCR_BANDS = [
  "temperature_2m",
  "precipitation_surface",
  "categorical_snow_surface",
  "categorical_freezing_rain_surface",
  "categorical_ice_pellets_surface",
  "wind_u_10m",
  "wind_v_10m",
  "total_cloud_cover_atmosphere",
] as const;

export type LcrBand = (typeof LCR_BANDS)[number];

/**
 * UTC midnight of init_time[0] in the store. Each index advances by 24 h.
 * Confirmed via `scripts/inspect_gefs_zarr.py` (range 2020-10-01..2026-05-28).
 */
export const INIT_TIME_ORIGIN = new Date("2020-10-01T00:00:00Z");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function dateFromInitTimeIdx(idx: number): Date {
  return new Date(INIT_TIME_ORIGIN.getTime() + idx * MS_PER_DAY);
}

export function initTimeIdxFromDate(date: Date, maxIdx: number): number {
  const dayDiff = Math.round(
    (date.getTime() - INIT_TIME_ORIGIN.getTime()) / MS_PER_DAY,
  );
  return Math.max(0, Math.min(maxIdx, dayDiff));
}

/** YYYY-MM-DD (UTC) for an <input type="date">. */
export function isoDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Field choices the user can render as the continuous background raster.
 * Each entry pins its own colormap + rescale range + LCR-shader bandMode.
 */
export type FieldChoice = {
  /** Zarr variable name (the array opened as ZarrLayer.node). */
  id: LcrBand;
  label: string;
  /** Multiply raw zarr value by this to get display units (UI + rescale). */
  displayScale: number;
  /** Rescale min/max in DISPLAY units. */
  rescaleMin: number;
  rescaleMax: number;
  colormapIndex: number;
  reversed: boolean;
  unit: string;
  description: string;
};

export const FIELD_CHOICES: FieldChoice[] = [
  {
    id: "total_cloud_cover_atmosphere",
    label: "Cloud cover",
    displayScale: 1,
    rescaleMin: 0,
    rescaleMax: 100,
    colormapIndex: COLORMAP_INDEX.blues,
    reversed: false,
    unit: "%",
    description: "Total cloud cover.",
  },
  {
    id: "precipitation_surface",
    label: "Precipitation rate",
    displayScale: 3600, // kg/m²/s -> mm/h
    rescaleMin: 0,
    rescaleMax: 2,
    colormapIndex: COLORMAP_INDEX.blues,
    reversed: false,
    unit: "mm/h",
    description: "Surface precipitation rate — the storm itself.",
  },
  {
    id: "temperature_2m",
    label: "Temperature 2 m",
    displayScale: 1,
    // Symmetric around 0 °C so the diverging midpoint sits at freezing.
    rescaleMin: -40,
    rescaleMax: 40,
    // Diverging purple→white→orange (no red — Stephen has reduced red sensitivity).
    // `puor` ships orange→white→purple; reverse it so cold=purple, hot=orange.
    colormapIndex: COLORMAP_INDEX.puor,
    reversed: true,
    unit: "°C",
    description: "2 m air temperature.",
  },
];

export const DEFAULT_FIELD_ID: LcrBand = "total_cloud_cover_atmosphere";
