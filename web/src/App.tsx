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
  HRRR_GEOZARR_ATTRS,
  HRRR_LEAD_TIME_COUNT,
  HRRR_LEAD_TIME_STEP_HOURS,
  initTimeIdxFromDate,
  LCR_BANDS,
  type FieldChoice,
  type LcrBand,
} from "./gefs/metadata.js";
import {
  getTileData,
  type HrrrArrays,
  type HrrrTileData,
} from "./gefs/get-tile-data.js";
import { makeRenderTile } from "./gefs/render-tile.js";
import { buildSelection } from "./gefs/selection.js";
import { DeckGlOverlay } from "./lib/deckgl-overlay.js";
import type { LcrResult } from "./lcr/compute.js";
import { runLcrSideChannel, type ChunkEntry } from "./lcr/side-channel.js";
import { buildFreewayLayers, buildHexLcr } from "./overlay/freeways.js";
import type { FreewaySegment, HexPixel } from "./overlay/types.js";
import { ControlPanel, type LayerToggles } from "./ui/ControlPanel.js";

const MAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const ZARR_URL =
  "https://data.source.coop/dynamical/noaa-hrrr-forecast-48-hour/v0.1.0.zarr";
const BASE_STEP_HOURS = 1;
const INITIAL_FRAME_MS = 140;
const DEFAULT_INIT_DATE = new Date("2026-01-14T00:00:00Z");

type PickInfo = { hex: HexPixel; result: LcrResult } | null;

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [arrs, setArrs] = useState<HrrrArrays | null>(null);
  const [initTimeIdx, setInitTimeIdx] = useState(0);
  const [leadTimeIdx, setLeadTimeIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [frameDurationMs, setFrameDurationMs] = useState(INITIAL_FRAME_MS);

  const [fieldId, setFieldId] = useState<LcrBand>(DEFAULT_FIELD_ID);
  const field: FieldChoice =
    FIELD_CHOICES.find((f) => f.id === fieldId) ?? FIELD_CHOICES[0]!;
  const [rescaleMin, setRescaleMin] = useState(field.rescaleMin);
  const [rescaleMax, setRescaleMax] = useState(field.rescaleMax);
  useEffect(() => {
    setRescaleMin(field.rescaleMin);
    setRescaleMax(field.rescaleMax);
  }, [field.id]);

  const [layers, setLayers] = useState<LayerToggles>({
    showRaster: true,
    showPaths: true,
    showHexes: false,
  });
  const [rasterOpacity, setRasterOpacity] = useState(0.5);

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

  // Open all 8 zarr arrays (cheap metadata-only). Raster uses one at a time;
  // LCR side channel uses all 8 to fetch hex-shard values in the background.
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
      const out = {} as HrrrArrays;
      for (let i = 0; i < LCR_BANDS.length; i++) {
        const a = opened[i]!;
        if (!a.is("float32")) {
          throw new Error(`Expected ${LCR_BANDS[i]} float32, got ${a.dtype}`);
        }
        out[LCR_BANDS[i]!] = a;
      }
      if (cancelled) return;
      setArrs(out);
      const maxIdx = out[LCR_BANDS[0]!].shape[0]! - 1;
      setInitTimeIdx(initTimeIdxFromDate(DEFAULT_INIT_DATE, maxIdx));
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

  // ---- LCR side channel: fetch the 8 bands ONLY for shards covering hexes.
  // Runs whenever (init, hexes, arrs) change. Each shard lands in
  // lcrChunksRef as soon as its 8 bands are back; we bump `chunksVersion`
  // so the per-frame `hexLcr` recomputes.
  const lcrChunksRef = useRef<Map<string, ChunkEntry>>(new Map());
  const [chunksVersion, setChunksVersion] = useState(0);

  useEffect(() => {
    if (!arrs || hexes.length === 0) return;
    lcrChunksRef.current.clear();
    setChunksVersion((v) => v + 1);
    const ctrl = new AbortController();
    // Delay 1.2 s so the raster ZarrLayer gets first crack at the network
    // budget. The user sees the raster fill in, then roads colorize.
    const timer = setTimeout(() => {
      runLcrSideChannel({
        arrs,
        hexes,
        initTimeIdx,
        signal: ctrl.signal,
        onChunkLoaded: (entry) => {
          lcrChunksRef.current.set(
            `${entry.chunkRow},${entry.chunkCol}`,
            entry,
          );
          setChunksVersion((v) => v + 1);
        },
      }).catch((err) => {
        if (!ctrl.signal.aborted) console.error("LCR side channel failed", err);
      });
    }, 1200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [arrs, hexes, initTimeIdx]);

  const initTimeCount = arrs ? arrs[LCR_BANDS[0]!].shape[0]! : 0;

  const hexLcr = useMemo(() => {
    if (hexes.length === 0) return new Map<string, LcrResult>();
    return buildHexLcr(hexes, lcrChunksRef.current, leadTimeIdx);
  }, [hexes, leadTimeIdx, chunksVersion]);

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
      const stepH = HRRR_LEAD_TIME_STEP_HOURS[cur] ?? BASE_STEP_HOURS;
      const dwell = frameDurationMs * (stepH / BASE_STEP_HOURS);
      if (now - last >= dwell) {
        setLeadTimeIdx((i) => (i + 1) % HRRR_LEAD_TIME_COUNT);
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, frameDurationMs]);

  // HRRR shard already covers all 49 leads; no lead-window slicing needed.
  const selection = useMemo(
    () => buildSelection({ initTimeIdx }),
    [initTimeIdx],
  );

  const renderTile = useCallback(
    (data: HrrrTileData) => {
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
    if (arrs && colormapTexture && layers.showRaster) {
      out.push(
        new ZarrLayer<zarr.Readable, "float32", HrrrTileData>({
          id: `hrrr-zarr-${initTimeIdx}-${field.id}`,
          node: arrs[field.id] as unknown as zarr.Array<
            "float32",
            zarr.Readable
          >,
          metadata: HRRR_GEOZARR_ATTRS,
          selection,
          getTileData,
          renderTile,
          // source.coop supports HTTP/2 multiplexing.
          maxRequests: 20,
          maxCacheSize: 10,
          opacity: rasterOpacity,
          updateTriggers: {
            renderTile: [leadTimeIdx, field.id, rescaleMin, rescaleMax],
          },
          // positron-gl-style stack: water fill is at index 9, boundary_county
          // at index 7 — so beforeId="boundary_county" inadvertently put the
          // raster below water. aeroway-runway (index 11) is the first layer
          // above water_shadow, which lands the raster above water polygons
          // (clouds visible over oceans + lakes) but below roads / labels.
          beforeId: "aeroway-runway",
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
        onFieldChange={(id) => setFieldId(id as LcrBand)}
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
