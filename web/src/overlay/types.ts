export type FreewaySegment = {
  seg_id: number;
  h3_r5: string;
  path: [number, number][];
};

export type HexPixel = {
  h3_r5: string;
  gefs_i: number;
  gefs_j: number;
  lat: number;
  lon: number;
};
