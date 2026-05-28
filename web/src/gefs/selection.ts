import * as zarr from "zarrita";

export type BuildSelectionArgs = {
  initTimeIdx: number;
};

/**
 * HRRR selection: pin init_time, keep the full lead_time dim (49 hourly
 * leads). Dim order in the source store is (init_time, lead_time, y, x).
 *
 * One spatial shard `(1, 49, 265, 300)` already contains all 49 leads, so
 * no lead-window slicing is needed — a single fetch per viewport tile
 * delivers the entire animation.
 */
export function buildSelection(
  args: BuildSelectionArgs,
): Record<string, number | zarr.Slice | null> {
  return {
    init_time: args.initTimeIdx,
    lead_time: null,
  };
}
