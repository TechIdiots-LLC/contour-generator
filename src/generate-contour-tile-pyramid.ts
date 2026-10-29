#!/usr/bin/env node

import { Command } from "commander";
import { writeFileSync, mkdir, existsSync } from "fs";
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
  timeoutMs: 10000,
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

async function processTile(v: Tile): Promise<void> {
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
    return Promise.resolve();
  }

  if (verbose) {
    console.log(`[Tile ${z}-${x}-${y}] Generating contour tile...`);
  }

  let tileOptions = contourOptions;
  if ("thresholds" in contourOptions) {
    tileOptions = getOptionsForZoom(contourOptions, z);
  }

  try {
    const tile = await manager.fetchContourTile(
      z,
      x,
      y,
      tileOptions,
      new AbortController(), // AbortController can be used for timeout/cancellation
    );
    const tileBuffer = Buffer.from(tile.arrayBuffer);

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
      return;
    }

    // Ensure directory exists before writing
    await new Promise<void>((resolve, reject) => {
      mkdir(dirPath, { recursive: true }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        writeFileSync(filePath, tileBuffer);
        resolve();
      });
    });
    if (verbose) {
      console.log(`[Tile ${z}-${x}-${y}] Successfully wrote ${filePath}`);
    }
  } catch (error: any) {
    // Log error, but don't necessarily exit here as it might be a single tile failure
    console.error(`Error processing tile ${z}/${x}/${y}: ${error.message}`);
    // Re-throwing might be necessary if we want the main process to catch it and exit
    throw error;
  }
}

async function processQueue(
  queue: Tile[],
  batchSize: number = 25, // Process in batches to manage concurrent Promises
): Promise<void> {
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize);
    console.log(
      `Processing batch ${i / batchSize + 1} of ${Math.ceil(
        queue.length / batchSize,
      )} for source tile ${z}/${x}/${y}`,
    );
    try {
      await Promise.all(batch.map(processTile));
      console.log(
        `Completed batch ${i / batchSize + 1} of ${Math.ceil(
          queue.length / batchSize,
        )} for source tile ${z}/${x}/${y}`,
      );
    } catch (error) {
      // If any tile in the batch fails, catch the error to prevent stopping the loop
      // unless we explicitly want to stop on first error.
      // For now, log and continue processing other batches.
      console.error(`Error in batch starting at index ${i}:`, error);
      // If you want to stop on first error, uncomment the next line:
      // throw error;
    }
  }
}

// --------------------------------------------------
// Main Execution Logic
// --------------------------------------------------

const children: Tile[] = getAllTiles([numX, numY, numZ], numoutputMaxZoom);

// Sort children for more predictable processing order (optional but good practice)
children.sort((a, b) => {
  if (a[2] !== b[2]) return a[2] - b[2]; // Sort by zoom level
  if (a[0] !== b[0]) return a[0] - b[0]; // Sort by X
  return a[1] - b[1]; // Sort by Y
});

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

if (manager) {
  processQueue(children)
    .then(() => {
      console.log(
        `All contour tiles for pyramid originating from ${z}/${x}/${y} have been written!`,
      );
    })
    .catch((error) => {
      console.error(
        `An error occurred during the tile generation process: ${error.message}`,
      );
      process.exit(1);
    });
} else {
  console.error(
    "Failed to initialize DEM manager. Check DEM URL and ensure it's a supported format (PMTiles, MBTiles, or a tile URL pattern).",
  );
  process.exit(1);
}
