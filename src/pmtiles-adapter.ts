import fs from "node:fs";
import { PMTiles, FetchSource, type Source } from "pmtiles";

const httpTester = /^https?:\/\//i;
export const pmtilesTester = /^pmtiles:\/\//i;

export class PMTilesFileSource implements Source {
  private fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  getKey(): string {
    return String(this.fd);
  }
  async getBytes(
    offset: number,
    length: number,
  ): Promise<{ data: ArrayBuffer }> {
    const buffer = Buffer.alloc(length);
    await readFileBytes(this.fd, buffer, offset);
    return {
      data: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    };
  }
}

async function readFileBytes(
  fd: number,
  buffer: Buffer,
  offset: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, offset, (err, bytesRead, _buff) => {
      if (err) return reject(err);
      if (bytesRead !== buffer.length)
        return reject(
          new Error(`Failed to read ${buffer.length} bytes, got ${bytesRead}`),
        );
      resolve();
    });
  });
}

function getPmtilesMimeTypeFromTypeNum(tileTypeNum: number): string {
  switch (tileTypeNum) {
    case 1:
      return "application/x-protobuf"; // pbf
    case 2:
      return "image/png";
    case 3:
      return "image/jpeg";
    case 4:
      return "image/webp";
    case 5:
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

export function openPMtiles(FilePath: string): PMTiles {
  let pmtiles: PMTiles;

  try {
    if (httpTester.test(FilePath)) {
      const source = new FetchSource(FilePath);
      pmtiles = new PMTiles(source);
    } else {
      const fd = fs.openSync(FilePath, "r");
      const source = new PMTilesFileSource(fd);
      pmtiles = new PMTiles(source);
    }
    return pmtiles;
  } catch (error: any) {
    console.error(
      `Failed to open PMTiles source ${FilePath}: ${error.message}`,
    );
    throw error;
  }
}

// New exported function to get MIME type from PMTiles instance
export async function getPMTilesMimeType(
  pmtiles: PMTiles,
): Promise<string | undefined> {
  try {
    const header = await pmtiles.getHeader();
    return getPmtilesMimeTypeFromTypeNum(header.tileType);
  } catch (error: any) {
    console.error("Error getting PMTiles header for MIME type:", error.message);
    return undefined;
  }
}

export async function getPMtilesTile(
  pmtiles: PMTiles,
  z: number,
  x: number,
  y: number,
): Promise<{ data: ArrayBuffer | undefined; mimeType: string | undefined }> {
  try {
    // Fetch header and mimeType once for this operation
    const header = await pmtiles.getHeader();
    const mimeType = getPmtilesMimeTypeFromTypeNum(header.tileType);

    const zxyTile = await pmtiles.getZxy(z, x, y);

    if (zxyTile && zxyTile.data) {
      return { data: zxyTile.data, mimeType };
    } else {
      // Tile not found, but we still have the archive's mimeType from the header.
      return { data: undefined, mimeType: mimeType };
    }
  } catch (error: any) {
    // A read that failed is not a tile that is missing. Reporting it as one
    // would leave a hole in the output that looks like a gap in the DEM.
    throw new Error(
      `Error fetching PMTiles tile (z:${z}, x:${x}, y:${y}): ${error.message}`,
    );
  }
}
