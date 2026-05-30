import {
  Checkbox,
  HStack,
  IconButton,
  Input,
  Link,
  Slider,
  Stack,
  Text,
} from "@chakra-ui/react";
import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import {
  CollecticonCirclePause,
  CollecticonCirclePlay,
} from "@devseed-ui/collecticons-chakra";
import {
  ColormapPreview,
  Field,
  HelpTooltip,
  ControlPanel as SharedControlPanel,
} from "../components/index.js";
import {
  dateFromInitTimeIdx,
  HRRR_LEAD_TIME_COUNT as GEFS_LEAD_TIME_COUNT,
  HRRR_LEAD_TIME_HOURS as GEFS_LEAD_TIME_HOURS,
  INIT_TIME_ORIGIN,
  initTimeIdxFromDate,
  isoDateString,
  type FieldChoice,
} from "../gefs/metadata.js";
import type { LcrResult } from "../lcr/compute.js";
import type { HexPixel } from "../overlay/types.js";

const COLORMAP_ROW_COUNT = Object.keys(COLORMAP_INDEX).length;

export type LayerToggles = {
  showRaster: boolean;
  showPaths: boolean;
  showHexes: boolean;
};

export type ControlPanelProps = {
  field: FieldChoice;
  onFieldChange: (id: string) => void;

  leadTimeIdx: number;
  initTimeIdx: number;
  initTimeCount: number;
  isPlaying: boolean;
  frameDurationMs: number;

  rescaleMin: number;
  rescaleMax: number;

  layers: LayerToggles;
  rasterOpacity: number;

  onInitTimeIdxChange: (idx: number) => void;
  onLeadTimeIdxChange: (idx: number) => void;
  onPlayPauseToggle: () => void;
  onFrameDurationMsChange: (ms: number) => void;
  onRescaleChange: (min: number, max: number) => void;
  onLayersChange: (next: LayerToggles) => void;
  onRasterOpacityChange: (v: number) => void;

  pick: { hex: HexPixel; result: LcrResult } | null;
  onClosePick: () => void;
};

export function ControlPanel(props: ControlPanelProps) {
  const {
    field,
    leadTimeIdx,
    initTimeIdx,
    initTimeCount,
    isPlaying,
    frameDurationMs,
    layers,
    rasterOpacity,
    pick,
  } = props;
  const hours = GEFS_LEAD_TIME_HOURS[leadTimeIdx] ?? 0;
  const validUTC = dateFromInitTimeIdx(initTimeIdx);
  validUTC.setUTCHours(validUTC.getUTCHours() + hours);
  const validStr = `${isoDateString(validUTC)} ${String(validUTC.getUTCHours()).padStart(2, "0")}:00Z`;

  return (
    <SharedControlPanel
      title="HRRR LCR · US Freeways"
      position="top-left"
      width="440px"
      sourceHref="https://github.com/kentstephen/zarr-road-risk"
    >
      <Stack gap="2.5">
        <Text fontSize="xs" color="gray.600" lineHeight="1.5">
          Freeways colored by an{" "}
          <Text as="span" fontWeight="semibold">
            LCR-Inspired Road Risk
          </Text>{" "}
          score, a forecast-derived estimate of{" "}
          <Link
            href="https://icyroadsafety.com/lcr/"
            target="_blank"
            rel="noopener noreferrer"
            color="orange.600"
            textDecoration="underline"
          >
            Loss-of-Control Risk
          </Link>
          , computed live in the browser.
        </Text>
        <Text fontSize="xs" color="gray.500" lineHeight="1.5">
          Data:{" "}
          <Link
            href="https://source.coop/dynamical/noaa-hrrr-forecast-48-hour"
            target="_blank"
            rel="noopener noreferrer"
            color="orange.600"
            textDecoration="underline"
          >
            NOAA HRRR 48-hour forecast
          </Link>{" "}
          (Zarr v3) |{" "}
          <Link
            href="https://dynamical.org"
            target="_blank"
            rel="noopener noreferrer"
            color="orange.600"
            textDecoration="underline"
          >
            Dynamical
          </Link>{" "}
          |{" "}
          <Link
            href="https://source.coop"
            target="_blank"
            rel="noopener noreferrer"
            color="orange.600"
            textDecoration="underline"
          >
            source.coop
          </Link>
        </Text>

        <Text fontSize="xs" color="gray.600" lineHeight="1.5">
          <Text as="span" fontWeight="medium">
            Cloud-cover backdrop
          </Text>{" "}
          (atmospheric context).
        </Text>

        <Field label="Forecast init (UTC)">
          <Input
            type="date"
            size="sm"
            min={isoDateString(INIT_TIME_ORIGIN)}
            max={
              initTimeCount > 0
                ? isoDateString(dateFromInitTimeIdx(initTimeCount - 1))
                : undefined
            }
            value={isoDateString(dateFromInitTimeIdx(initTimeIdx))}
            disabled={initTimeCount === 0}
            onChange={(e) =>
              props.onInitTimeIdxChange(
                initTimeIdxFromDate(
                  new Date(`${e.target.value}T00:00:00Z`),
                  Math.max(0, initTimeCount - 1),
                ),
              )
            }
          />
          <Text mt="1" fontSize="xs" color="gray.500">
            Opens on the 14 Jan 2026 winter storm. Pick any date back to 13 Jul
            2018.
          </Text>
          {initTimeCount > 0 && initTimeIdx < initTimeCount - 1 ? (
            <Link
              mt="1"
              fontSize="xs"
              color="orange.600"
              cursor="pointer"
              textDecoration="none"
              _hover={{ textDecoration: "none" }}
              onClick={() => props.onInitTimeIdxChange(initTimeCount - 1)}
            >
              →&nbsp;
              <Text as="span" textDecoration="underline">
                Jump to current forecast
              </Text>
            </Link>
          ) : (
            <Text mt="1" fontSize="xs" color="gray.400">
              Showing the latest forecast
            </Text>
          )}
        </Field>

        <Field
          label={
            <HStack gap="1">
              <Text as="span">
                Lead: +
                <Text as="span" display="inline-block" minW="3ch" textAlign="right">
                  {hours}
                </Text>{" "}
                h · {validStr}
              </Text>
              <HelpTooltip label="Lead-time resolution">
                3-hourly +0..+240 h, then 6-hourly +246..+840 h (181 frames).
                6 h steps dwell 2× longer for constant simulated-time pacing.
              </HelpTooltip>
            </HStack>
          }
        >
          <HStack gap="2" width="full">
            <IconButton
              aria-label={isPlaying ? "Pause" : "Play"}
              size="lg"
              fontSize="3xl"
              variant="ghost"
              flexShrink={0}
              onClick={props.onPlayPauseToggle}
            >
              {isPlaying ? <CollecticonCirclePause /> : <CollecticonCirclePlay />}
            </IconButton>
            <Slider.Root
              size="sm"
              flex="1"
              minW="0"
              min={0}
              max={GEFS_LEAD_TIME_COUNT - 1}
              value={[leadTimeIdx]}
              aria-label={["Lead time step"]}
              onValueChange={(details) =>
                props.onLeadTimeIdxChange(details.value[0])
              }
              onDoubleClick={() => props.onLeadTimeIdxChange(0)}
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumb index={0}>
                  <Slider.HiddenInput />
                </Slider.Thumb>
              </Slider.Control>
            </Slider.Root>
          </HStack>
          <Text mt="1" fontSize="xs" color="gray.500">
            Press{" "}
            <Text
              as="kbd"
              px="1"
              fontSize="0.7em"
              fontFamily="mono"
              borderWidth="1px"
              borderColor="gray.300"
              borderRadius="sm"
              bg="gray.50"
            >
              Space
            </Text>{" "}
            to pause / play.
          </Text>
        </Field>

        <Field label={<Text as="span">3 h dwell: {frameDurationMs} ms</Text>}>
          <Slider.Root
            size="sm"
            width="full"
            min={50}
            max={400}
            step={10}
            value={[frameDurationMs]}
            aria-label={["Frame duration (ms)"]}
            onValueChange={(details) =>
              props.onFrameDurationMsChange(details.value[0])
            }
            onDoubleClick={() => props.onFrameDurationMsChange(140)}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumb index={0}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
          </Slider.Root>
        </Field>

        <ColormapPreview
          spriteUrl={colormapsPngUrl}
          rowCount={COLORMAP_ROW_COUNT}
          rowIndex={field.colormapIndex}
          reversed={field.reversed}
          label={field.label + " · " + field.unit}
        />

        <Field
          label={
            <Text as="span">
              Raster opacity: {Math.round(rasterOpacity * 100)}%
            </Text>
          }
        >
          <Slider.Root
            size="sm"
            width="full"
            min={0}
            max={1}
            step={0.01}
            value={[rasterOpacity]}
            aria-label={["Raster opacity"]}
            onValueChange={(d) => props.onRasterOpacityChange(d.value[0])}
            onDoubleClick={() => props.onRasterOpacityChange(0.5)}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumb index={0}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
          </Slider.Root>
        </Field>

        <Stack gap="1">
          <Text fontSize="xs" color="gray.500" textTransform="uppercase" letterSpacing="0.08em">
            Layers
          </Text>
          <Checkbox.Root
            checked={layers.showRaster}
            onCheckedChange={(d) =>
              props.onLayersChange({ ...layers, showRaster: d.checked === true })
            }
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>Field raster</Checkbox.Label>
          </Checkbox.Root>
          <Checkbox.Root
            checked={layers.showPaths}
            onCheckedChange={(d) =>
              props.onLayersChange({ ...layers, showPaths: d.checked === true })
            }
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>Freeway paths (LCR colored)</Checkbox.Label>
          </Checkbox.Root>
          <Checkbox.Root
            checked={layers.showHexes}
            onCheckedChange={(d) =>
              props.onLayersChange({ ...layers, showHexes: d.checked === true })
            }
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>Hex pick targets</Checkbox.Label>
          </Checkbox.Root>
        </Stack>

        {pick && (
          <Stack
            mt="1"
            pt="2"
            borderTopWidth="1px"
            borderColor="gray.200"
            gap="1"
          >
            <HStack justify="space-between">
              <Text fontWeight="600" fontSize="sm">
                LCR {pick.result.lcr.toFixed(1)} / 12
              </Text>
              <Text
                as="button"
                fontSize="xs"
                color="gray.500"
                onClick={props.onClosePick}
              >
                close
              </Text>
            </HStack>
            <Text fontSize="xs" color="gray.600">
              {pick.result.factors.length
                ? pick.result.factors.join(", ")
                : "no winter hazard"}
            </Text>
            <Text fontSize="xs" color="gray.600">
              QPF{" "}
              {Number.isFinite(pick.result.qpfMmH) ? pick.result.qpfMmH.toFixed(2) : "n/a"} mm/h · wind{" "}
              {Number.isFinite(pick.result.windMph) ? pick.result.windMph.toFixed(0) : "n/a"} mph
            </Text>
            <Text fontSize="xs" color="gray.500">
              ({pick.hex.lat.toFixed(2)}, {pick.hex.lon.toFixed(2)}) · h3 {pick.hex.h3_r5}
            </Text>
          </Stack>
        )}
      </Stack>
    </SharedControlPanel>
  );
}
