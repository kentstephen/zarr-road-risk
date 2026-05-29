import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";

/**
 * GeoZarr metadata for the dynamical NOAA HRRR 48-hour forecast store.
 *
 * The store is a Lambert Conformal Conic grid on a sphere R=6371229 m
 * (central meridian -97.5, latitude of origin 38.5, both standard parallels
 * 38.5). ZarrLayer reprojects to web-mercator on the fly via proj4 + the
 * WKT in `proj:wkt2`.
 *
 * Affine convention used by `@developmentseed/affine` (this repo):
 *   x_out = a*col + b*row + c
 *   y_out = d*col + e*row + f
 * HRRR GeoTransform (from `spatial_ref/zarr.json`):
 *   x0 = -2699020.142521929, dx = 3000, y0 = 1588193.847443335, dy = -3000
 *
 * Shape: 1059 (y) × 1799 (x).
 */
const HRRR_WKT = `PROJCS["unnamed",GEOGCS["Coordinate System imported from GRIB file",DATUM["unnamed",SPHEROID["Sphere",6371229,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",38.5],PARAMETER["central_meridian",-97.5],PARAMETER["standard_parallel_1",38.5],PARAMETER["standard_parallel_2",38.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["Metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]`;

export const HRRR_GEOZARR_ATTRS = {
  "spatial:dimensions": ["y", "x"],
  "spatial:transform": [3000, 0, -2699020.142521929, 0, -3000, 1588193.847443335],
  "spatial:shape": [1059, 1799],
  "proj:wkt2": HRRR_WKT,
} as const;

/** Source-store dim order on the variable arrays: (init_time, lead_time, y, x). */
export const HRRR_NON_SPATIAL_DIMS = ["init_time", "lead_time"] as const;

/** Inner Lambert grid (matches `spatial_ref/zarr.json` GeoTransform). */
export const HRRR_GRID = {
  x0: -2699020.142521929,
  dx: 3000,
  width: 1799,
  y0: 1588193.847443335,
  dy: -3000,
  height: 1059,
} as const;

/** Lead-time schedule (hours): 49 hourly steps, 0..48. */
export const HRRR_LEAD_TIME_HOURS: readonly number[] = Array.from(
  { length: 49 },
  (_, i) => i,
);
export const HRRR_LEAD_TIME_COUNT = HRRR_LEAD_TIME_HOURS.length;

/** Constant 1 h dwell — kept as an array to match the GEFS-era pacing hook. */
export const HRRR_LEAD_TIME_STEP_HOURS: readonly number[] = HRRR_LEAD_TIME_HOURS.map(
  () => 1,
);

/** HRRR inits every 6 h since 2018-07-13 12:00 UTC (from root `time_resolution`). */
export const INIT_TIME_ORIGIN = new Date("2018-07-13T12:00:00Z");
const MS_PER_INIT_STEP = 6 * 60 * 60 * 1000;

export function dateFromInitTimeIdx(idx: number): Date {
  return new Date(INIT_TIME_ORIGIN.getTime() + idx * MS_PER_INIT_STEP);
}

export function initTimeIdxFromDate(date: Date, maxIdx: number): number {
  const stepDiff = Math.round(
    (date.getTime() - INIT_TIME_ORIGIN.getTime()) / MS_PER_INIT_STEP,
  );
  return Math.max(0, Math.min(maxIdx, stepDiff));
}

/** YYYY-MM-DD (UTC) for an <input type="date">. */
export function isoDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Variables sampled; order is fixed and matches the side-channel band binding. */
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

export type FieldChoice = {
  id: LcrBand;
  label: string;
  displayScale: number;
  rescaleMin: number;
  rescaleMax: number;
  colormapIndex: number;
  reversed: boolean;
  unit: string;
  description: string;
  /**
   * Display-unit floor: pixels at or below this value are discarded (fully
   * transparent), so the basemap shows through "dead" zero areas. Leave
   * undefined for fields where the natural floor is meaningful (e.g.
   * temperature, where 0 °C is freezing — not dead space).
   */
  hideAtOrBelow?: number;
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
    hideAtOrBelow: 0, // hide clear-sky pixels (basemap shows through)
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
    description: "Surface precipitation rate.",
    hideAtOrBelow: 0, // hide no-precip pixels
  },
  {
    id: "temperature_2m",
    label: "Temperature 2 m",
    displayScale: 1,
    rescaleMin: -40,
    rescaleMax: 40,
    colormapIndex: COLORMAP_INDEX.puor,
    reversed: true,
    unit: "°C",
    description: "2 m air temperature.",
  },
];

export const DEFAULT_FIELD_ID: LcrBand = "total_cloud_cover_atmosphere";
