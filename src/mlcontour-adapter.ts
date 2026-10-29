import sharp from "sharp";
import mlcontour from "maplibre-contour";
import type {
  DemTile,
  Encoding,
  GlobalContourTileOptions,
} from "../node_modules/maplibre-contour/dist/types.d.ts";
import type { MaskRange } from "./mask-options.js";

// A DEM tile that does not exist is "no data", not a flat tile. An encoded
// terrain tile cannot say "nothing", so the fetchers hand the decoder an empty
// blob carrying this type and the decoder turns it into a tile of NaN.
// maplibre-contour skips NaN cells, so the lines stop where the ground does
// instead of tracing a cliff against an invented height.
export const NO_DATA_MIME = "application/x-contour-generator-no-data";

export function noDataBlob(): Blob {
  return new Blob([], { type: NO_DATA_MIME });
}

// --------------------------------------------------
// No-data masks
// --------------------------------------------------

// Mapbox encoding has no way to mark a pixel as empty, and an all-zero pixel
// decodes to this height. maplibre-contour only rejects heights outside
// -12000..9000, so it would pass this one as real ground, and a handful of them
// beside terrain makes the isoline pass walk thousands of levels per cell.
// Terrarium's equivalent (-32768) is already rejected by maplibre-contour.
const MAPBOX_ZERO_PIXEL_HEIGHT = -10000;

export type MaskOptions = {
  values?: number[];
  ranges?: MaskRange[];
};

/**
 * Builds the function that turns a DEM image into a tile of heights.
 *
 * Pixels that are fully transparent, equal to a masked value, or inside a
 * masked range become NaN. Values are compared in thousandths, because decoding
 * lands on base + n * interval in floating point and exact equality alone would
 * miss them.
 */
export function createImageDecoder(mask: MaskOptions = {}) {
  const userValues = (mask.values ?? []).map((v) => Math.round(v * 1000));
  const bands = (mask.ranges ?? []).map(
    ([low, high]) =>
      [Math.round(low * 1000), Math.round(high * 1000)] as MaskRange,
  );
  const exactFor = new Map<Encoding, Set<number>>();
  const exactValues = (encoding: Encoding): Set<number> => {
    let set = exactFor.get(encoding);
    if (!set) {
      set = new Set(userValues);
      if (encoding === "mapbox") {
        set.add(Math.round(MAPBOX_ZERO_PIXEL_HEIGHT * 1000));
      }
      exactFor.set(encoding, set);
    }
    return set;
  };

  return async function decodeImage(
    blob: Blob,
    encoding: Encoding,
    abortController: AbortController,
  ): Promise<DemTile> {
    if (blob.type === NO_DATA_MIME) {
      // One NaN sample reads as NaN at any coordinate, so its size does not
      // matter next to neighbours of another size.
      return { width: 1, height: 1, data: new Float32Array([Number.NaN]) };
    }
    if (abortController?.signal?.aborted) {
      throw new Error("Image processing was aborted.");
    }
    try {
      const buffer = await blob.arrayBuffer();
      const image = sharp(Buffer.from(buffer));

      if (abortController?.signal?.aborted) {
        throw new Error("Image processing was aborted.");
      }

      const { data, info } = await image
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (abortController?.signal?.aborted) {
        throw new Error("Image processing was aborted.");
      }
      const parsed = mlcontour.decodeParsedImage(
        info.width,
        info.height,
        encoding, // mlcontour decodes based on the encoding it receives
        data as any as Uint8ClampedArray,
      );

      const exact = exactValues(encoding);
      const heights = parsed.data;
      for (let i = 0; i < heights.length; i++) {
        // Transparent pixels carry no data whatever colour they hold
        if (data[i * 4 + 3] === 0) {
          heights[i] = Number.NaN;
          continue;
        }
        const height = heights[i];
        if (Number.isNaN(height)) continue;
        const thousandths = Math.round(height * 1000);
        if (exact.has(thousandths)) {
          heights[i] = Number.NaN;
          continue;
        }
        for (const [low, high] of bands) {
          if (thousandths >= low && thousandths <= high) {
            heights[i] = Number.NaN;
            break;
          }
        }
      }

      if (abortController?.signal?.aborted) {
        throw new Error("Image processing was aborted.");
      }

      return parsed;
    } catch (error) {
      console.error("Error processing image:", error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("An unknown error has occurred.");
    }
  };
}

export function extractZXYFromUrlTrim(
  url: string,
): { z: number; x: number; y: number } | null {
  const lastSlashIndex = url.lastIndexOf("/");
  if (lastSlashIndex === -1) {
    return null;
  }

  const segments = url.split("/");
  if (segments.length <= 3) {
    return null;
  }

  const ySegment = segments[segments.length - 1];
  const xSegment = segments[segments.length - 2];
  const zSegment = segments[segments.length - 3];

  const lastDotIndex = ySegment.lastIndexOf(".");
  const cleanedYSegment =
    lastDotIndex === -1 ? ySegment : ySegment.substring(0, lastDotIndex);

  const z = parseInt(zSegment, 10);
  const x = parseInt(xSegment, 10);
  const y = parseInt(cleanedYSegment, 10);

  if (isNaN(z) || isNaN(x) || isNaN(y)) {
    return null;
  }

  return { z, x, y };
}

export function getOptionsForZoom(
  options: GlobalContourTileOptions,
  zoom: number,
): any {
  const { thresholds, ...rest } = options;

  let levels: number[] = [];
  let maxLessThanOrEqualTo: number = -Infinity;

  Object.entries(thresholds).forEach(([zString, value]) => {
    const z = Number(zString);
    if (z <= zoom && z > maxLessThanOrEqualTo) {
      maxLessThanOrEqualTo = z;
      levels = typeof value === "number" ? [value] : value;
    }
  });

  return {
    levels,
    ...rest,
  };
}
