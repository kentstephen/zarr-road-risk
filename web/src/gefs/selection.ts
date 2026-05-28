import type * as zarr from "zarrita";

export type BuildSelectionArgs = {
  initTimeIdx: number;
  ensembleMemberIdx: number;
};

/**
 * GEFS selection: pin init_time + ensemble_member, keep lead_time (animation).
 * Dim order in the source store is (init_time, ensemble_member, lead_time, lat, lon).
 */
export function buildSelection(
  args: BuildSelectionArgs,
): Record<string, number | zarr.Slice | null> {
  return {
    init_time: args.initTimeIdx,
    ensemble_member: args.ensembleMemberIdx,
    lead_time: null,
  };
}
