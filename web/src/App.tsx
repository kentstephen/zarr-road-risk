import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import type { Device, Texture } from "@luma.gl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { Map as MaplibreMap } from "react-map-gl/maplibre";
import * as zarr from "zarrita";
import {
  DEFAULT_FIELD_ID,
  FIELD_CHOICES,
  GEFS_GEOZARR_ATTRS,
  GEFS_LEAD_TIME_COUNT,
  GEFS_LEAD_TIME_STEP_HOURS,
  INIT_TIME_ORIGIN,
  initTimeIdxFromDate,
  LCR_BANDS,
  type FieldChoice,
} from "./gefs/metadata.js";
import {
  makeGetTileData,
  type GefsArrays,
  type GefsTileData,
} from "./gefs/get-tile-data.js";
import { makeRenderTile } from "./gefs/render-tile.js";
import { buildSelection } from "./gefs/selection.js";
import { DeckGlOverlay } from "./lib/deckgl-overlay.js";
import type { LcrResult } from "./lcr/compute.js";
import { buildFreewayLayers, buildHexLcr } from "./overlay/freeways.js";
import type { FreewaySegment, HexPixel } from "./overlay/types.js";
const MAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
import { ControlPanel, type LayerToggles } from "./ui/ControlPanel.js";

const ZARR_URL =
  "https://data.source.coop/dynamical/noaa-gefs-forecast-35-day/v0.2.0.zarr";
const ENSEMBLE_MEMBER_IDX = 0;
const BASE_STEP_HOURS = 3;
const INITIAL_FRAME_MS = 140;
// Demo default — a mid-January 2026 forecast init for winter weather context.
const DEFAULT_INIT_DATE = new Date("2026-01-14T00:00:00Z");

type PickInfo = { hex: HexPixel; result: LcrResult } | null;

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [arrs, setArrs] = useState<GefsArrays | null>(null);
  const [initTimeIdx, setInitTimeIdx] = useState(0);
  const [leadTimeIdx, setLeadTimeIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [frameDurationMs, setFrameDurationMs] = useState(INITIAL_FRAME_MS);

  const [fieldId, setFieldId] = useState<string>(DEFAULT_FIELD_ID);
  const field: FieldChoice =
    FIELD_CHOICES.find((f) => f.id === fieldId) ?? FIELD_CHOICES[0]!;
  const [rescaleMin, setRescaleMin] = useState(field.rescaleMin);
  const [rescaleMax, setRescaleMax] = useState(field.rescaleMax);
  // When the band changes, reset the rescale to the band's defaults.
  useEffect(() => {
    setRescaleMin(field.rescaleMin);
    setRescaleMax(field.rescaleMax);
  }, [field.id]);

  const [layers, setLayers] = useState<LayerToggles>({
    showRaster: true,
    showPaths: true,
    showHexes: true,
  });
  const [rasterOpacity, setRasterOpacity] = useState(0.75);

  const [device, setDevice] = useState<Device | null>(null);
  const [colormapImage, setColormapImage] = useState<ImageData | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);

  const [segments, setSegments] = useState<FreewaySegment[]>([]);
  const [hexes, setHexes] = useState<HexPixel[]>([]);
  const [pickInfo, setPickInfo] = useState<PickInfo>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await fetch(colormapsPngUrl);
      const bytes = await resp.arrayBuffer();
      const image = await decodeColormapSprite(bytes);
      if (!cancelled) setColormapImage(image);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!device || !colormapImage) return;
    setColormapTexture(createColormapTexture(device, colormapImage));
  }, [device, colormapImage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const store = await zarr.withConsolidatedMetadata(
        new zarr.FetchStore(ZARR_URL),
        { format: "v3" },
      );
      const root = await zarr.open.v3(store, { kind: "group" });
      const opened = await Promise.all(
        LCR_BANDS.map((b) => zarr.open.v3(root.resolve(b), { kind: "array" })),
      );
      const out = {} as GefsArrays;
      for (let i = 0; i < LCR_BANDS.length; i++) {
        const a = opened[i]!;
        if (!a.is("float32")) {
          throw new Error(`Expected ${LCR_BANDS[i]} float32, got ${a.dtype}`);
        }
        out[LCR_BANDS[i]!] = a;
      }
      if (cancelled) return;
      setArrs(out);
      // Snap to default mid-January 2026 init, clamped to the store range.
      const first = out[LCR_BANDS[0]!];
      const maxIdx = first.shape[0]! - 1;
      const targetIdx = initTimeIdxFromDate(DEFAULT_INIT_DATE, maxIdx);
      setInitTimeIdx(targetIdx);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [segs, hxs] = await Promise.all([
        fetch("freeways.json").then((r) => r.json()),
        fetch("hex_pixels.json").then((r) => r.json()),
      ]);
      if (cancelled) return;
      setSegments(segs as FreewaySegment[]);
      setHexes(hxs as HexPixel[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tilesRef = useRef<Map<string, GefsTileData>>(new Map());
  const [tilesVersion, setTilesVersion] = useState(0);

  // When the init changes, drop the registry (tiles are init-specific).
  useEffect(() => {
    tilesRef.current.clear();
    setTilesVersion((v) => v + 1);
  }, [initTimeIdx]);

  const initTimeCount = arrs ? arrs[LCR_BANDS[0]!].shape[0]! : 0;

  const hexLcr = useMemo(() => {
    if (hexes.length === 0) return new Map<string, LcrResult>();
    const tiles = Array.from(tilesRef.current.values());
    return buildHexLcr(hexes, tiles, leadTimeIdx);
  }, [hexes, leadTimeIdx, tilesVersion]);

  const leadRef = useRef(leadTimeIdx);
  useEffect(() => {
    leadRef.current = leadTimeIdx;
  }, [leadTimeIdx]);
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const cur = leadRef.current;
      const stepH = GEFS_LEAD_TIME_STEP_HOURS[cur] ?? BASE_STEP_HOURS;
      const dwell = frameDurationMs * (stepH / BASE_STEP_HOURS);
      if (now - last >= dwell) {
        setLeadTimeIdx((i) => (i + 1) % GEFS_LEAD_TIME_COUNT);
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, frameDurationMs]);

  const selection = useMemo(
    () =>
      buildSelection({
        initTimeIdx,
        ensembleMemberIdx: ENSEMBLE_MEMBER_IDX,
      }),
    [initTimeIdx],
  );

  const wrappedGetTileData = useMemo(() => {
    if (!arrs) return null;
    const base = makeGetTileData(arrs);
    return async (
      ...args: Parameters<ReturnType<typeof makeGetTileData>>
    ): Promise<GefsTileData> => {
      const data = await base(...args);
      const key = `${data.tileY},${data.tileX}`;
      tilesRef.current.set(key, data);
      setTilesVersion((v) => v + 1);
      return data;
    };
  }, [arrs]);

  const renderTile = useCallback(
    (data: GefsTileData) => {
      if (!colormapTexture) return { renderPipeline: [] };
      return makeRenderTile({
        layerIndex: leadTimeIdx,
        field,
        colormapTexture,
        rescaleMin,
        rescaleMax,
      })(data);
    },
    [leadTimeIdx, colormapTexture, field, rescaleMin, rescaleMax],
  );

  const deckLayers = useMemo(() => {
    const out: unknown[] = [];
    if (arrs && colormapTexture && wrappedGetTileData && layers.showRaster) {
      out.push(
        new ZarrLayer<zarr.Readable, "float32", GefsTileData>({
          id: `gefs-zarr-${initTimeIdx}`,
          node: arrs[LCR_BANDS[0]!] as unknown as zarr.Array<
            "float32",
            zarr.Readable
          >,
          metadata: GEFS_GEOZARR_ATTRS,
          selection,
          getTileData: wrappedGetTileData,
          renderTile,
          maxRequests: 20,
          maxCacheSize: 4,
          opacity: rasterOpacity,
          updateTriggers: {
            renderTile: [leadTimeIdx, field.id, rescaleMin, rescaleMax],
          },
          beforeId: "boundary_county",
        } as never),
      );
    }
    if (segments.length && hexes.length) {
      out.push(
        ...buildFreewayLayers({
          segments,
          hexes,
          hexLcr,
          updateKey: leadTimeIdx,
          showPaths: layers.showPaths,
          showHexes: layers.showHexes,
          onHexPick: (h, r) =>
            setPickInfo(h && r ? { hex: h, result: r } : null),
        }),
      );
    }
    return out;
  }, [
    arrs,
    colormapTexture,
    wrappedGetTileData,
    initTimeIdx,
    selection,
    renderTile,
    segments,
    hexes,
    hexLcr,
    leadTimeIdx,
    field.id,
    rescaleMin,
    rescaleMax,
    layers.showRaster,
    layers.showPaths,
    layers.showHexes,
    rasterOpacity,
  ]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={{ longitude: -96, latitude: 39, zoom: 3.6 }}
        mapStyle={MAP_STYLE_URL}
      >
        <DeckGlOverlay
          layers={deckLayers as never}
          interleaved
          onDeviceInitialized={setDevice}
        />
      </MaplibreMap>
      <ControlPanel
        field={field}
        onFieldChange={setFieldId}
        leadTimeIdx={leadTimeIdx}
        initTimeIdx={initTimeIdx}
        initTimeCount={initTimeCount}
        isPlaying={isPlaying}
        frameDurationMs={frameDurationMs}
        rescaleMin={rescaleMin}
        rescaleMax={rescaleMax}
        layers={layers}
        onInitTimeIdxChange={setInitTimeIdx}
        onLeadTimeIdxChange={setLeadTimeIdx}
        onPlayPauseToggle={() => setIsPlaying((p) => !p)}
        onFrameDurationMsChange={setFrameDurationMs}
        onRescaleChange={(a, b) => {
          setRescaleMin(a);
          setRescaleMax(b);
        }}
        onLayersChange={setLayers}
        rasterOpacity={rasterOpacity}
        onRasterOpacityChange={setRasterOpacity}
        pick={pickInfo}
        onClosePick={() => setPickInfo(null)}
      />
    </div>
  );
}

// Avoid unused-var warning on INIT_TIME_ORIGIN re-export consumers.
void INIT_TIME_ORIGIN;
