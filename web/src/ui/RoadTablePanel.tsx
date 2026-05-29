import { Box, chakra, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";
import { lcrColor } from "../lcr/compute.js";
import type { StateGroup } from "../roads/road-table.js";

export type RoadTablePanelProps = {
  groups: StateGroup[];
  /** Road lookup loaded yet? Drives the empty/loading copy. */
  ready: boolean;
  /** Whether the body starts expanded. Defaults to `true`. */
  defaultOpen?: boolean;
};

const rgba = (c: [number, number, number, number]) =>
  `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;

/**
 * Right-side live table of freeways currently under a Loss-of-Control Risk
 * (LCR) hazard, grouped by state (two-letter, alphabetical). Rows appear as
 * the map highlights light up and collapse out once they clear — it reads the
 * same per-frame `hexLcr` the freeway layer renders from.
 */
export function RoadTablePanel({
  groups,
  ready,
  defaultOpen = true,
}: RoadTablePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const total = groups.reduce((n, g) => n + g.roads.length, 0);
  return (
    <Box
      position="absolute"
      top="20px"
      right="20px"
      width="280px"
      maxHeight="calc(100% - 40px)"
      overflowY="auto"
      bg="white"
      color="gray.800"
      borderRadius="lg"
      boxShadow="0 2px 8px rgba(0, 0, 0, 0.1)"
      p="4"
      pointerEvents="auto"
      zIndex={1000}
    >
      <chakra.button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        width="100%"
        textAlign="left"
        cursor="pointer"
        userSelect="none"
        bg="transparent"
        border="none"
        p="0"
        m="0"
      >
        <Heading as="h2" size="md">
          Affected roads
        </Heading>
        <chakra.span
          fontSize="xs"
          transition="transform 0.2s"
          transform={open ? "rotate(0deg)" : "rotate(-90deg)"}
        >
          ▼
        </chakra.span>
      </chakra.button>
      <Text fontSize="xs" color="gray.500" mt="1">
        {!ready
          ? "loading road table…"
          : total === 0
            ? "no roads under hazard this frame"
            : `${total} road${total === 1 ? "" : "s"} in ${groups.length} state${
                groups.length === 1 ? "" : "s"
              }`}
      </Text>
      <Text fontSize="xs" color="gray.500" mt="1">
        LCR score (0–12)
      </Text>

      {open ? (
        <Stack gap="3" mt="3" fontSize="sm">
        {groups.map((g) => (
          <Box key={g.state}>
            <Heading
              as="h3"
              size="xs"
              color="gray.600"
              borderBottomWidth="1px"
              borderColor="gray.200"
              pb="1"
              mb="1"
            >
              {g.state}
            </Heading>
            <Stack gap="1">
              {g.roads.map((r) => (
                <Flex key={r.name} align="center" gap="2">
                  <Box
                    flex="none"
                    width="10px"
                    height="10px"
                    borderRadius="full"
                    bg={rgba(lcrColor(r.lcr))}
                  />
                  <Text flex="1" lineClamp={1} title={r.name}>
                    {r.name}
                  </Text>
                  <Text flex="none" color="gray.500" fontVariantNumeric="tabular-nums">
                    {r.lcr}
                  </Text>
                </Flex>
              ))}
            </Stack>
          </Box>
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}
