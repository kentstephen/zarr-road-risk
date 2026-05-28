import * as zarr from "zarrita";

export type BuildSelectionArgs = {
  initTimeIdx: number;
  ensembleMemberIdx: number;
  /** Lead-time window [start, end) — slice to exactly one on-disk chunk. */
  leadStart: number;
  leadEnd: number;
};

/**
 * GEFS selection: pin init_time + ensemble_member, slice lead_time to one
 * on-disk chunk (64 leads). Dim order in the source store is
 * (init_time, ensemble_member, lead_time, lat, lon).
 *
 * Slicing the lead dim to a single chunk is the main win — instead of
 * 3 lead-chunks per spatial tile (full 181-lead anim), we fetch 1.
 */
export function buildSelection(
  args: BuildSelectionArgs,
): Record<string, number | zarr.Slice | null> {
  return {
    init_time: args.initTimeIdx,
    ensemble_member: args.ensembleMemberIdx,
    lead_time: zarr.slice(args.leadStart, args.leadEnd),
  };
}
