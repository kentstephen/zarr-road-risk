export type FreewaySegment = {
  seg_id: number;
  h3_r5: string;
  path: [number, number][];
};

export type HexPixel = {
  h3_r5: string;
  hrrr_x: number;
  hrrr_y: number;
  lat: number;
  lon: number;
};
