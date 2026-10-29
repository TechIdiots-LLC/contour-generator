#!/usr/bin/env node

import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { bboxToTiles } from "./bbox_to_tiles.js";
import {
  collectMaskValue,
  collectMaskRange,
  type MaskRange,
} from "./mask-options.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Types ---
type BaseOptions = {
  demUrl: string;
  encoding: "mapbox" | "terrarium";
  sourceMaxZoom: number;
  increment: number;
  outputMaxZoom: number;
  outputDir: string;
  processes: number;
  verbose: boolean;
  maskValue: number[];
  maskRange: MaskRange[];
  // Deprecated and ignored
  blankTileNoDataValue?: number;
  blankTileSize?: number;
  blankTileFormat?: string;
};

type PyramidOptions = BaseOptions & {
  x: number;
  y: number;
  z: number;
};

type ZoomOptions = BaseOptions & {
  outputMinZoom: number;
};

type BboxOptions = BaseOptions & {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  outputMinZoom: number;
};

/**
 * Helper function to validate encoding
 */
function validateEncoding(
  encoding: string,
): asserts encoding is "mapbox" | "terrarium" {
  if (encoding !== "mapbox" && encoding !== "terrarium") {
    throw new Error(
      `Encoding must be either "mapbox" or "terrarium", got ${encoding}`,
    );
  }
}

/**
 * Function to create metadata.json
 */
async function createMetadata(
  outputDir: string,
  outputMinZoom: number,
  outputMaxZoom: number,
): Promise<void> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const metadata = {
    name: `Contour_z${outputMinZoom}_Z${outputMaxZoom}`,
    type: "baselayer",
    description: new Date().toISOString(),
    version: "1",
    format: "pbf",
    minzoom: outputMinZoom.toString(),
    maxzoom: outputMaxZoom.toString(),
    json: JSON.stringify({
      vector_layers: [
        {
          id: "contours",
          fields: {
            ele: "Number",
            level: "Number",
          },
          minzoom: outputMinZoom,
          maxzoom: outputMaxZoom,
        },
      ],
    }),
    bounds: "-180.000000,-85.051129,180.000000,85.051129",
  };

  writeFileSync(
    path.join(outputDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  console.log(`metadata.json has been created in ${outputDir}`);
}

/**
 * Function to process a single tile by spawning a child process.
 */
async function processTile(options: PyramidOptions): Promise<void> {
  if (options.verbose) {
    console.log(
      `[Tile ${options.z}-${options.x}-${options.y}] Starting... outputMaxZoom: ${options.outputMaxZoom}`,
    );
  }

  validateEncoding(options.encoding);

  return new Promise((resolve, reject) => {
    // Path to the generate-contour-tile-pyramid.js script in the same directory
    const scriptPath = path.join(__dirname, "generate-contour-tile-pyramid.js");

    // Check if the script exists
    if (!existsSync(scriptPath)) {
      reject(new Error(`Script not found at: ${scriptPath}`));
      return;
    }

    const commandArgs = [
      scriptPath,
      "--x",
      options.x.toString(),
      "--y",
      options.y.toString(),
      "--z",
      options.z.toString(),
      "--demUrl",
      options.demUrl,
      "--encoding",
      options.encoding,
      "--sourceMaxZoom",
      options.sourceMaxZoom.toString(),
      "--increment",
      options.increment.toString(),
      "--outputMaxZoom",
      options.outputMaxZoom.toString(),
      "--outputDir",
      options.outputDir,
    ];

    // Passed as --flag=value so a negative height is not read as another option
    for (const value of options.maskValue) {
      commandArgs.push(`--maskValue=${value}`);
    }
    for (const [low, high] of options.maskRange) {
      commandArgs.push(`--maskRange=${low},${high}`);
    }

    // Pass the verbose flag down to the child process ONLY if the orchestrator is verbose
    if (options.verbose) {
      commandArgs.push("--verbose"); // Pass the verbose flag to the child
    }

    const workerProcess = spawn("node", commandArgs, {
      stdio: ["ignore", "pipe", "pipe"], // Capture stdout and stderr
      shell: true, // Use false for better security and performance
    });

    const processPrefix = `[Tile ${options.z}-${options.x}-${options.y}] `;

    // Buffering for verbose output to prevent flooding the console and consuming excessive memory
    let stdoutBuffer = "";
    let stderrBuffer = "";

    workerProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      // Process captured output if orchestrator is verbose.
      // We trust the child process to handle its own verbose output; this capture
      // is mainly for potential error logging or if the child isn't verbose.
      if (options.verbose) {
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || ""; // Keep the last (potentially partial) line
        // Log with orchestrator's prefix, but only if it's not already verbose output from child
        // This is still tricky. The robust solution is to NOT log here and let the child's verbose logs appear.
        // However, for debugging purposes, logging captured data is useful.
        // The duplicate "Starting..." and "Finished..." are from the orchestrator's own handlers.
        // We should avoid double-logging the CHILD's output.
        //
        // For now, let's keep the logging here, but be aware it might duplicate child's --verbose output.
        // The FIX for the "Starting..." and "Finished..." duplication is in the orchestrator handlers themselves.
        lines.forEach((line) => console.log(processPrefix + line.trim()));
      }
    });

    workerProcess.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      if (options.verbose) {
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        lines.forEach((line) => console.error(processPrefix + line.trim()));
      }
    });

    workerProcess.on("close", (code) => {
      // Flush any remaining buffered data if verbose, primarily for error reporting
      if (options.verbose) {
        if (stdoutBuffer) console.log(processPrefix + stdoutBuffer.trim());
        if (stderrBuffer) console.error(processPrefix + stderrBuffer.trim());
      }

      if (code === 0) {
        if (options.verbose) {
          console.log(processPrefix + "Finished successfully."); // Orchestrator's own status message
        }
        resolve();
      } else {
        // Reject with a more informative error, including stderr content
        reject(
          new Error(
            `${processPrefix}Exited with code ${code}. Captured stderr: "${stderrBuffer.trim()}"`,
          ),
        );
      }
    });

    workerProcess.on("error", (err) => {
      reject(
        new Error(`${processPrefix}Failed to start process: ${err.message}`),
      );
    });
  });
}

/**
 * Manages a pool of worker processes to execute tasks concurrently,
 * ensuring no more than `maxProcesses` are running at any time.
 * @param coordinates - Array of [z, x, y] tuples representing tiles to process.
 * @param options - Base options to pass to each tile processing job.
 * @param maxProcesses - The maximum number of parallel processes to run.
 */
async function processTilesInParallel(
  coordinates: Array<[number, number, number]>,
  options: BaseOptions,
  maxProcesses: number,
): Promise<void> {
  const totalTiles = coordinates.length;
  if (totalTiles === 0) {
    console.log("[Main] No tiles to process.");
    return;
  }

  let currentIndex = 0;
  let completedCount = 0;
  const activeWorkers: Promise<void>[] = [];

  console.log(
    `[Main] Starting to process ${totalTiles} tiles with up to ${maxProcesses} parallel processes.`,
  );

  return new Promise((resolve, reject) => {
    const scheduleNextTile = () => {
      // If all tasks are assigned and all active workers have finished, we are done.
      if (currentIndex >= totalTiles && activeWorkers.length === 0) {
        console.log(`[Main] All ${totalTiles} tiles processed.`);
        return resolve();
      }

      // While we have tasks left and the number of active workers is below the limit
      while (currentIndex < totalTiles && activeWorkers.length < maxProcesses) {
        const [z, x, y] = coordinates[currentIndex];
        const tileOptions: PyramidOptions = {
          ...options,
          z,
          x,
          y,
        };

        currentIndex++;

        if (options.verbose) {
          console.log(
            `[Main] Assigning tile ${z}-${x}-${y} to worker. (${currentIndex}/${totalTiles} assigned)`,
          );
        }

        // Create a promise for this tile's processing
        const tilePromise = processTile(tileOptions)
          .then(() => {
            completedCount++;
            if (options.verbose) {
              console.log(
                `[Main] Tile ${z}-${x}-${y} completed. (${completedCount}/${totalTiles} done)`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `[Main] Error processing tile ${z}-${x}-${y}:`,
              error,
            );
            reject(error); // Reject the main promise if any tile fails
          })
          .finally(() => {
            // Remove this worker from the active pool
            const index = activeWorkers.indexOf(tilePromise);
            if (index > -1) {
              activeWorkers.splice(index, 1);
            }
            // Try to schedule the next available tile
            scheduleNextTile();
          });

        activeWorkers.push(tilePromise);
      }
    };

    // Start the initial batch of workers
    scheduleNextTile();
  });
}

// --- Command Handlers ---

async function runPyramid(options: PyramidOptions): Promise<void> {
  await processTile(options);
  await createMetadata(options.outputDir, options.z, options.outputMaxZoom);
}

async function runZoom(options: ZoomOptions): Promise<void> {
  if (options.verbose) {
    console.log(`[Main] Source: ${options.demUrl}`);
    console.log(`[Main] Output Dir: ${options.outputDir}`);
    console.log(
      `[Main] Zoom Levels: ${options.outputMinZoom} to ${options.outputMaxZoom}`,
    );
    console.log(`[Main] Starting tile generation.`);
  }

  const coordinates: Array<[number, number, number]> = [];
  const tilesInDimension = Math.pow(2, options.outputMinZoom);
  for (let y = 0; y < tilesInDimension; y++) {
    for (let x = 0; x < tilesInDimension; x++) {
      coordinates.push([options.outputMinZoom, x, y]);
    }
  }

  await processTilesInParallel(coordinates, options, options.processes);

  if (options.verbose) {
    console.log(
      `[Main] Finished processing all tiles at zoom level ${options.outputMinZoom}.`,
    );
  }

  await createMetadata(
    options.outputDir,
    options.outputMinZoom,
    options.outputMaxZoom,
  );
}

async function runBbox(options: BboxOptions): Promise<void> {
  const coordinates = bboxToTiles(
    options.minx,
    options.miny,
    options.maxx,
    options.maxy,
    options.outputMinZoom,
  );

  if (options.verbose) {
    console.log(`[Main] Source: ${options.demUrl}`);
    console.log(`[Main] Output Dir: ${options.outputDir}`);
    console.log(
      `[Main] Bounding Box: ${options.minx},${options.miny},${options.maxx},${options.maxy}`,
    );
    console.log(`[Main] Starting tile generation.`);
  }

  await processTilesInParallel(coordinates, options, options.processes);

  if (options.verbose) {
    console.log("Main: Finished processing all tiles in bounding box.");
  }

  await createMetadata(
    options.outputDir,
    options.outputMinZoom,
    options.outputMaxZoom,
  );
}

// --- Main Program Setup ---
async function main(): Promise<void> {
  const program = new Command();

  program
    .name("contour-generator")
    .description("Generates contours from DEM tiles.");

  // --- Define common option configurations with proper typing ---
  type RequiredOptionConfig = {
    type: "required";
    flags: string;
    description: string;
  };

  type StandardOptionConfig = {
    type: "standard";
    flags: string;
    description: string;
    defaultValue: string | boolean;
  };

  type ParsedOptionConfig = {
    type: "parsed";
    flags: string;
    description: string;
    parser: NumberConstructor;
    defaultValue: number;
  };

  type NumberListOptionConfig = {
    type: "numberList";
    flags: string;
    description: string;
    collect: (value: string, previous: number[]) => number[];
  };

  type RangeListOptionConfig = {
    type: "rangeList";
    flags: string;
    description: string;
    collect: (value: string, previous: MaskRange[]) => MaskRange[];
  };

  type DeprecatedOptionConfig = {
    type: "deprecated";
    flags: string;
  };

  type OptionConfig =
    | RequiredOptionConfig
    | StandardOptionConfig
    | ParsedOptionConfig
    | NumberListOptionConfig
    | RangeListOptionConfig
    | DeprecatedOptionConfig;

  const commonOptionConfigs: OptionConfig[] = [
    // required options
    {
      type: "required",
      flags: "--demUrl <string>",
      description: "The URL of the DEM source.",
    },
    // standard options (string/boolean only)
    {
      type: "standard",
      flags: "--encoding <string>",
      description:
        'The encoding of the source DEM (e.g., "terrarium", "mapbox").',
      defaultValue: "mapbox",
    },
    {
      type: "standard",
      flags: "--outputDir <string>",
      description: "The output directory where tiles will be stored.",
      defaultValue: "./output",
    },
    {
      type: "standard",
      flags: "-v, --verbose",
      description: "Enable verbose output",
      defaultValue: false,
    },
    // parsed options (numbers that need parsing)
    {
      type: "parsed",
      flags: "--sourceMaxZoom <number>",
      description: "The maximum zoom level of the source DEM.",
      parser: Number,
      defaultValue: 8,
    },
    {
      type: "parsed",
      flags: "--increment <number>",
      description: "The contour increment value to extract.",
      parser: Number,
      defaultValue: 0,
    },
    {
      type: "parsed",
      flags: "--outputMaxZoom <number>",
      description: "The maximum zoom level of the output tile pyramid.",
      parser: Number,
      defaultValue: 8,
    },
    {
      type: "parsed",
      flags: "--processes <number>",
      description: "The number of parallel processes to use.",
      parser: Number,
      defaultValue: 8,
    },
    // no-data masks
    {
      type: "numberList",
      flags: "--maskValue <number>",
      description:
        "A height (metres) that means no data. Repeat for several. A mapbox-encoded pixel of exactly -10000 m is always masked.",
      collect: collectMaskValue,
    },
    {
      type: "rangeList",
      flags: "--maskRange <low,high>",
      description:
        "A band of heights (metres) that means no data, like -10001,-9999. Repeat for several.",
      collect: collectMaskRange,
    },
    // A missing DEM tile is now no data rather than a flat blank tile
    { type: "deprecated", flags: "--blankTileNoDataValue <number>" },
    { type: "deprecated", flags: "--blankTileSize <number>" },
    { type: "deprecated", flags: "--blankTileFormat <string>" },
  ];

  // --- Pyramid Command ---
  const pyramidCmd = program
    .command("pyramid")
    .description("Generates contours for a specific tile and its children.")
    .requiredOption(
      "--x <number>",
      "The X coordinate of the parent tile.",
      Number,
    )
    .requiredOption(
      "--y <number>",
      "The Y coordinate of the parent tile.",
      Number,
    )
    .requiredOption(
      "--z <number>",
      "The Z coordinate of the parent tile.",
      Number,
    );

  // --- Zoom Command ---
  const zoomCmd = program
    .command("zoom")
    .description(
      "Generates a list of parent tiles at a specified zoom level and runs pyramid on each. This command assumes you have the entire world at the specified zoom levels.",
    )
    .option(
      "--outputMinZoom <number>",
      "The minimum zoom level of the output tile pyramid.",
      Number,
      5,
    );

  // --- Bbox Command ---
  const bboxCmd = program
    .command("bbox")
    .description(
      "Generates a list of parent tiles covering a bounding box and runs pyramid on each.",
    )
    .requiredOption(
      "--minx <number>",
      "The minimum X coordinate of the bounding box.",
      Number,
    )
    .requiredOption(
      "--miny <number>",
      "The minimum Y coordinate of the bounding box.",
      Number,
    )
    .requiredOption(
      "--maxx <number>",
      "The maximum X coordinate of the bounding box.",
      Number,
    )
    .requiredOption(
      "--maxy <number>",
      "The maximum Y coordinate of the bounding box.",
      Number,
    )
    .option(
      "--outputMinZoom <number>",
      "The minimum zoom level of the output tile pyramid.",
      Number,
      5,
    );

  // Helper function to apply options to commands
  const applyCommonOptions = (command: Command, configs: OptionConfig[]) => {
    for (const config of configs) {
      if (config.type === "required") {
        command.requiredOption(config.flags, config.description);
      } else if (config.type === "numberList") {
        command.option(
          config.flags,
          config.description,
          config.collect,
          [] as number[],
        );
      } else if (config.type === "rangeList") {
        command.option(
          config.flags,
          config.description,
          config.collect,
          [] as MaskRange[],
        );
      } else if (config.type === "deprecated") {
        command.option(config.flags, "Deprecated and ignored.");
      } else if (config.type === "parsed") {
        // This is a ParsedOptionConfig - needs parser
        command.option(
          config.flags,
          config.description,
          config.parser,
          config.defaultValue,
        );
      } else {
        // This is a StandardOptionConfig - string/boolean only
        command.option(config.flags, config.description, config.defaultValue);
      }
    }
  };

  // Apply common options to each command
  applyCommonOptions(pyramidCmd, commonOptionConfigs);
  applyCommonOptions(zoomCmd, commonOptionConfigs);
  applyCommonOptions(bboxCmd, commonOptionConfigs);

  const warnDeprecated = (options: BaseOptions) => {
    if (
      options.blankTileNoDataValue !== undefined ||
      options.blankTileSize !== undefined ||
      options.blankTileFormat !== undefined
    ) {
      console.warn(
        "--blankTileNoDataValue, --blankTileSize and --blankTileFormat are ignored: a missing DEM tile is now treated as no data, and no contours are drawn there.",
      );
    }
  };

  // --- Set up action handlers (after options are defined) ---
  pyramidCmd.action(async (options: PyramidOptions) => {
    warnDeprecated(options);
    await runPyramid(options);
  });

  zoomCmd.action(async (options: ZoomOptions) => {
    warnDeprecated(options);
    await runZoom(options);
  });

  bboxCmd.action(async (options: BboxOptions) => {
    warnDeprecated(options);
    await runBbox(options);
  });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error("An unhandled error occurred:", err);
  process.exit(1);
});
