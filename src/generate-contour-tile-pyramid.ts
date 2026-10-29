#!/usr/bin/env node

import { Command } from "commander";
import { mkdir, existsSync } from "fs";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "fs/promises";
import mlcontour from "maplibre-contour";
import {
  extractZXYFromUrlTrim,
  createImageDecoder,
  getOptionsForZoom,
  noDataBlob,
  NO_DATA_MIME,
} from "./mlcontour-adapter.js";
import {
  collectMaskValue,
  collectMaskRange,
  type MaskRange,
} from "./mask-options.js";
import {
  getPMtilesTile,
  openPMtiles,
  pmtilesTester,
} from "./pmtiles-adapter.js";
// Import MBTiles adapter functions, tester, AND the metadata structure from openMBTiles
import {
  openMBTiles,
  getMBTilesTile,
  mbtilesTester,
} from "./mbtiles-adapter.js";

import { getChildren } from "@mapbox/tilebelt";
import path from "path";
import { sortTilesForCache } from "./tile-order.js";
import type { Encoding } from "../node_modules/maplibre-contour/dist/types.d.ts";
import { type PMTiles } from "pmtiles";

type Tile = [number, number, number];

const program = new Command();
program
  .name("generate-countour-tile-pyramid")
  .description(
    "Generates a pyramid of contour tiles from a source DEM using the mlcontour library.",
  )
  .requiredOption("--x <number>", "The X coordinate of the tile.")
  .requiredOption("--y <number>", "The Y coordinate of the tile.")
  .requiredOption("--z <number>", "The Z coordinate of the tile.")
  .requiredOption(
    "--demUrl <string>",
    "The URL of the DEM source (e.g., 'pmtiles://...', 'mbtiles://...', or a tile URL pattern like 'http://example.com/{z}/{x}/{y}').",
  )
  .option(
    "--encoding <string>",
    "The encoding of the source DEM tiles (e.g., 'terrarium', 'mapbox').",
    (value) => {
      if (value !== "mapbox" && value !== "terrarium") {
        throw new Error(
          "Invalid value for --encoding, must be 'mapbox' or 'terrarium'",
        );
      }
      return value;
    },
    "mapbox", // default value
  )
  .option(
    "--sourceMaxZoom <number>",
    "The maximum zoom level of the source DEM.",
    "8", // default value as a string
  )
  .option("--increment <number>", "The contour increment value to extract.")
  .option(
    "--outputMaxZoom <number>",
    "The maximum zoom level of the output tile pyramid.",
    "8", // default value as a string
  )
  .requiredOption(
    "--outputDir <string>",
    "The output directory where tiles will be stored.",
  )
  .option(
    "--demTimeout <seconds>",
    "Seconds to wait for a DEM tile before giving up on it.",
    "120",
  )
  // --- No-data masks ---
  .option(
    "--maskValue <number>",
    "A height (metres) that means no data. Repeat for several.",
    collectMaskValue,
    [] as number[],
  )
  .option(
    "--maskRange <low,high>",
    "A band of heights (metres) that means no data, like -10001,-9999. Repeat for several.",
    collectMaskRange,
    [] as MaskRange[],
  )
  // --- Deprecated: missing DEM tiles are now no data, not a flat blank tile ---
  .option("--blankTileNoDataValue <number>", "Deprecated and ignored.")
  .option("--blankTileSize <number>", "Deprecated and ignored.")
  .option("--blankTileFormat <string>", "Deprecated and ignored.")
  .option("-v, --verbose", "Enable verbose output.")
  .parse(process.argv);

const options = program.opts();
const {
  x,
  y,
  z,
  demUrl,
  encoding,
  blankTileNoDataValue,
  sourceMaxZoom,
  increment,
  outputMaxZoom,
  outputDir,
  blankTileSize,
  blankTileFormat,
  maskValue,
  maskRange,
  demTimeout,
  verbose, // Capture the verbose option
} = options;

const numX = Number(x);
const numY = Number(y);
const numZ = Number(z);
const numsourceMaxZoom = Number(sourceMaxZoom);
const numIncrement = Number(increment);
const numoutputMaxZoom = Number(outputMaxZoom);

if (
  blankTileNoDataValue !== undefined ||
  blankTileSize !== undefined ||
  blankTileFormat !== undefined
) {
  console.warn(
    "--blankTileNoDataValue, --blankTileSize and --blankTileFormat are ignored: a missing DEM tile is now treated as no data, and no contours are drawn there.",
  );
}

const decodeImage = createImageDecoder({
  values: maskValue,
  ranges: maskRange,
});

// --------------------------------------------------
// mlcontour options/defaults
// --------------------------------------------------

const contourOptions = {
  multiplier: 1,
  ...(numIncrement
    ? { levels: [numIncrement] }
    : {
        thresholds: {
          1: [600, 3000],
          4: [300, 1500],
          8: [150, 750],
          9: [80, 400],
          10: [40, 200],
          11: [20, 100],
          12: [10, 50],
          14: [5, 25],
          16: [1, 5],
        },
      }),
  contourLayer: "contours",
  elevationKey: "ele",
  levelKey: "level",
  extent: 4096,
  buffer: 1,
};

// --------------------------------------------------
// Functions for Tile Pyramid Generation
// --------------------------------------------------

function getAllTiles(tile: Tile, outputMaxZoom: number): Tile[] {
  let allTiles: Tile[] = [tile];

  function getTileList(currentTile: Tile) {
    const children: Tile[] = getChildren(currentTile).filter(
      (child) => child[2] <= outputMaxZoom,
    );

    allTiles = allTiles.concat(children);

    for (const childTile of children) {
      const childZoom = childTile[2];
      if (childZoom < outputMaxZoom) {
        getTileList(childTile);
      }
    }
  }

  getTileList(tile);
  return allTiles;
}

// --------------------------------------------------
// Tile Fetching Adapters (Initialization and Fetcher Definitions)
// --------------------------------------------------

let pmtilesSource: PMTiles | undefined;
// mbtilesSource now correctly stores the result of openMBTiles
let mbtilesSource: { handle: any; metadata?: { format?: string } } | undefined;

interface TileFetcherResult {
  data: Blob | undefined;
  mimeType: string | undefined; // MIME type of the fetched/generated data
  expires: undefined;
  cacheControl: undefined;
}

interface TileFetcher {
  (url: string, abortController: AbortController): Promise<TileFetcherResult>;
}

// Source tiles known to be missing, as "z/x/y". A missing tile is no data
// rather than an error; this is how processTile tells that the tile it is
// drawing has no ground under it, in which case there is nothing to write.
const missingDemTiles = new Set<string>();

function missingTile(url: string, zxy: { z: number; x: number; y: number }) {
  missingDemTiles.add(`${zxy.z}/${zxy.x}/${zxy.y}`);
  if (verbose) {
    console.log(
      `[Fetcher] DEM tile not found for ${url} (z:${zxy.z}, x:${zxy.x}, y:${zxy.y}). Treating as no data.`,
    );
  }
  return {
    data: noDataBlob(),
    mimeType: NO_DATA_MIME,
    expires: undefined,
    cacheControl: undefined,
  };
}

const pmtilesFetcher: TileFetcher = async (
  url: string,
  _abortController: AbortController,
) => {
  if (!pmtilesSource) {
    throw new Error("PMTiles not initialized.");
  }

  const zxy = extractZXYFromUrlTrim(url);
  if (!zxy) {
    throw new Error(`Could not extract zxy from ${url}`);
  }

  if (verbose) {
    console.log(
      `[Fetcher] Fetching PMTiles: ${url} for ZXY: ${zxy.z}-${zxy.x}-${zxy.y}`,
    );
  }

  const { data: zxyTileData, mimeType: pmtilesMimeType } = await getPMtilesTile(
    pmtilesSource,
    zxy.z,
    zxy.x,
    zxy.y,
  );

  if (!zxyTileData) {
    return missingTile(url, zxy);
  }

  const mimeType = pmtilesMimeType || "image/png";
  return {
    data: new Blob([zxyTileData], { type: mimeType }),
    mimeType: mimeType,
    expires: undefined,
    cacheControl: undefined,
  };
};

const mbtilesFetcher: TileFetcher = async (
  url: string,
  _abortController: AbortController,
) => {
  if (!mbtilesSource) {
    throw new Error("MBTiles not initialized.");
  }

  const zxy = extractZXYFromUrlTrim(url);
  if (!zxy) {
    throw new Error(`Could not extract zxy from ${url}`);
  }

  if (verbose) {
    console.log(
      `[Fetcher] Fetching MBTiles: ${url} for ZXY: ${zxy.z}-${zxy.x}-${zxy.y}`,
    );
  }

  const tileData = await getMBTilesTile(
    mbtilesSource.handle,
    zxy.z,
    zxy.x,
    zxy.y,
  );

  if (!tileData || !tileData.data) {
    return missingTile(url, zxy);
  }

  const blobType = tileData.contentType || "image/png";
  return {
    data: new Blob([tileData.data], { type: blobType }),
    mimeType: blobType,
    expires: undefined,
    cacheControl: undefined,
  };
};

// Tile server URL pattern. A 404 is a tile the server does not have, which is
// no data; anything else that is not a success is a real failure.
const httpFetcher: TileFetcher = async (
  url: string,
  abortController: AbortController,
) => {
  const zxy = extractZXYFromUrlTrim(url);
  if (!zxy) {
    throw new Error(`Could not extract zxy from ${url}`);
  }

  if (verbose) {
    console.log(`[Fetcher] Fetching: ${url}`);
  }

  const response = await fetch(url, { signal: abortController.signal });
  if (response.status === 404) {
    return missingTile(url, zxy);
  }
  if (!response.ok) {
    throw new Error(`Bad response ${response.status} for ${url}`);
  }

  const blob = await response.blob();
  return {
    data: blob,
    mimeType: blob.type || undefined,
    expires: undefined,
    cacheControl: undefined,
  };
};

// --------------------------------------------------
// DEM Manager Setup
// --------------------------------------------------

let currentFetcher: TileFetcher | undefined;
let demUrlPattern: string | undefined;

async function initializeSources() {
  if (pmtilesTester.test(demUrl)) {
    const pmtilesPath = demUrl.replace(pmtilesTester, "");
    if (verbose) {
      console.log(`[Init] Initializing PMTiles from: ${pmtilesPath}`);
    }
    pmtilesSource = openPMtiles(pmtilesPath);
    currentFetcher = pmtilesFetcher;
    demUrlPattern = "/{z}/{x}/{y}"; // This pattern is used by mlcontour's manager
  } else if (mbtilesTester.test(demUrl)) {
    const mbtilesPath = demUrl.replace(mbtilesTester, "");
    if (!existsSync(mbtilesPath)) {
      console.error(`MBTiles file not found at: ${mbtilesPath}`);
      process.exit(1);
    }
    if (verbose) {
      console.log(`[Init] Initializing MBTiles from: ${mbtilesPath}`);
    }
    // Await the result of openMBTiles because it's now asynchronous
    mbtilesSource = await openMBTiles(mbtilesPath); // This returns { handle, metadata }
    currentFetcher = mbtilesFetcher;
    demUrlPattern = "/{z}/{x}/{y}"; // This pattern is used by mlcontour's manager
  } else {
    if (verbose) {
      console.log(`[Init] Using URL pattern: ${demUrl}`);
    }
    demUrlPattern = demUrl;
    currentFetcher = httpFetcher; // Direct tile server URL pattern
  }
}

// Call the initialization function and wait for it to complete
await initializeSources();

const demManagerOptions = {
  cacheSize: 100,
  encoding: encoding as Encoding,
  maxzoom: numsourceMaxZoom,
  timeoutMs: Number(demTimeout) * 1000,
  decodeImage,
  demUrlPattern: demUrlPattern, // Pass the determined pattern
  getTile: currentFetcher, // Pass the appropriate fetcher function
};

const manager = demUrlPattern
  ? new mlcontour.LocalDemManager(demManagerOptions)
  : null;

// --------------------------------------------------
// Tile Processing Function (using the manager)
// --------------------------------------------------

type TileResult = "written" | "exists" | "nodata" | "empty";

// How many tiles are in flight at once. A sliding window rather than fixed
// batches, so one slow tile does not hold up the rest of its batch.
const TILE_CONCURRENCY = 25;

// A tile that takes longer than this is reported when it finishes. Tracing is
// synchronous, so this cannot interrupt one, but it names the tile.
const SLOW_TILE_SECONDS = 30;

const PROGRESS_INTERVAL_MS = 10000;

async function processTile(v: Tile): Promise<TileResult> {
  if (!manager) {
    throw new Error("LocalDemManager is not initialized. Check DEM URL.");
  }

  const z: number = v[2];
  const x: number = v[0];
  const y: number = v[1];
  const dirPath: string = path.join(outputDir, `${z}`, `${x}`);
  const filePath: string = path.join(dirPath, `${y}.pbf`);

  if (existsSync(filePath)) {
    if (verbose) {
      console.log(`[Tile ${z}-${x}-${y}] Tile already exists. Skipping.`);
    }
    return "exists";
  }

  let tileOptions = contourOptions;
  if ("thresholds" in contourOptions) {
    tileOptions = getOptionsForZoom(contourOptions, z);
  }

  // Above the shallowest threshold there is nothing to draw
  if (!("levels" in tileOptions) || tileOptions.levels.length === 0) {
    return "empty";
  }

  if (verbose) {
    console.log(`[Tile ${z}-${x}-${y}] Generating contour tile...`);
  }

  const startedAt = Date.now();
  const tile = await manager.fetchContourTile(
    z,
    x,
    y,
    tileOptions,
    new AbortController(),
  );
  const seconds = (Date.now() - startedAt) / 1000;
  if (seconds >= SLOW_TILE_SECONDS) {
    console.log(
      `[slow] Tile ${z}/${x}/${y} took ${seconds.toFixed(1)}s (${(
        tile.arrayBuffer.byteLength /
        1024 /
        1024
      ).toFixed(1)} MB). Check its DEM for no-data pixels.`,
    );
  }

  // Nothing to draw where the DEM has no tile: the lines stop where the
  // ground does, so no file is written. The DEM tile this one is drawn from
  // is the source tile at or above the source's maximum zoom.
  const demZ = Math.min(z, numsourceMaxZoom);
  const demDiv = 2 ** (z - demZ);
  if (
    missingDemTiles.has(
      `${demZ}/${Math.floor(x / demDiv)}/${Math.floor(y / demDiv)}`,
    )
  ) {
    if (verbose) {
      console.log(
        `[Tile ${z}-${x}-${y}] No DEM data under this tile. Not writing.`,
      );
    }
    return "nodata";
  }

  // An empty result is a tile with nothing in it, and is not written
  if (tile.arrayBuffer.byteLength === 0) {
    return "empty";
  }

  await mkdirAsync(dirPath, { recursive: true });
  await writeFileAsync(filePath, Buffer.from(tile.arrayBuffer));
  if (verbose) {
    console.log(`[Tile ${z}-${x}-${y}] Successfully wrote ${filePath}`);
  }
  return "written";
}

type Failure = { tile: Tile; message: string };

async function processQueue(queue: Tile[]): Promise<Failure[]> {
  const counts: Record<TileResult, number> = {
    written: 0,
    exists: 0,
    nodata: 0,
    empty: 0,
  };
  const failures: Failure[] = [];
  const startedAt = Date.now();
  let next = 0;
  let done = 0;
  let lastReport = Date.now();

  const report = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[progress] ${z}/${x}/${y}: ${done}/${queue.length} tiles (${counts.written} written, ${counts.exists} existing, ${counts.nodata} no data, ${counts.empty} empty, ${failures.length} failed) in ${seconds}s`,
    );
  };

  // Every failure is kept and the rest carry on, so one bad tile cannot hide
  // behind the others or stop a long run. The caller reports them at the end.
  const run = async () => {
    while (next < queue.length) {
      const tile = queue[next++];
      try {
        counts[await processTile(tile)]++;
      } catch (error: any) {
        const message = error?.message ?? String(error);
        failures.push({ tile, message });
        console.error(
          `[failed] Tile ${tile[2]}/${tile[0]}/${tile[1]}: ${message}`,
        );
      }
      done++;
      if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = Date.now();
        report();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(TILE_CONCURRENCY, queue.length) }, run),
  );
  report();
  return failures;
}

// --------------------------------------------------
// Main Execution Logic
// --------------------------------------------------

const children: Tile[] = getAllTiles([numX, numY, numZ], numoutputMaxZoom);

// Zoom by zoom, and in Z-order within a zoom so the DEM tiles neighbouring tiles
// share are still cached when they are wanted again. See src/tile-order.ts.
sortTilesForCache(children);

// Ensure the base output directory exists
if (!existsSync(outputDir)) {
  if (verbose) {
    console.log(`Creating output directory: ${outputDir}`);
  }
  mkdir(outputDir, { recursive: true }, (err) => {
    if (err) {
      console.error(
        `Failed to create output directory ${outputDir}: ${err.message}`,
      );
      process.exit(1);
    }
  });
}

// Lets the process end on its own, which flushes the pipes and closes its
// handles cleanly. Calling process.exit() straight away can crash node on
// Windows with a libuv assertion while a handle is still closing, and that
// crash reads as a failed pyramid. If something a DEM source left open keeps
// the process alive, this forces the exit after a delay so the pyramid waiting
// on it is not stuck. The timer is unref'd, so it never keeps the process
// alive itself.
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 15000).unref();
}

if (manager) {
  processQueue(children)
    .then((failures) => {
      if (failures.length > 0) {
        console.error(
          `[failed] ${failures.length} of ${children.length} tiles for pyramid ${z}/${x}/${y} could not be generated. Run it again to retry them: tiles already written are skipped.`,
        );
        finish(1);
        return;
      }
      console.log(
        `All contour tiles for pyramid originating from ${z}/${x}/${y} have been written!`,
      );
      finish(0);
    })
    .catch((error) => {
      console.error(
        `An error occurred during the tile generation process: ${error.message}`,
      );
      finish(1);
    });
} else {
  console.error(
    "Failed to initialize DEM manager. Check DEM URL and ensure it's a supported format (PMTiles, MBTiles, or a tile URL pattern).",
  );
  finish(1);
}
