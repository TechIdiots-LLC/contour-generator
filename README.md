# Contour Generator

Generate contour lines from terrain elevation data and output them as Mapbox Vector Tiles (MVT). This tool converts terrain raster-dem data into vector contour lines that can be used in web maps, GIS applications, and other mapping tools.

Built on [maplibre-contour](https://github.com/onthegomap/maplibre-contour) for contour generation, it outputs standard MVT tiles compatible with MapLibre GL JS, Mapbox GL JS, and other vector tile consumers. The tool handles tile pyramids automatically, generating appropriate detail levels for each zoom with contour density optimized for web map performance.

![Example Output](example-contours.png) <!-- Add actual image -->

## What are contour lines?
Contour lines connect points of equal elevation on a map, helping visualize terrain shape and steepness. They're essential for topographic maps, hiking applications, and terrain analysis.

## Quick Start

**Install globally via npm:**
```bash
npm install -g contour-generator
```

**Generate your first contour map:**
```bash
contour-generator pyramid \
  --z 9 --x 272 --y 179 \
  --demUrl "pmtiles://https://techidiots-llc.github.io/contour_generator/test_data/terrain-tiles.pmtiles" \
  --sourceMaxZoom 12 \
  --outputMaxZoom 15 \
  --outputDir "./my-contours"
```

This creates contour lines for a small area in the Alps. Check the `./my-contours` directory for the generated tiles, then jump to [Using the Output](#using-the-output) to see how to view them.

## Prerequisites

- Node.js 16 or higher
- At least 2GB free disk space for processing
- Internet connection (for remote DEM sources)

## Installation

### Option 1: Global Installation (Recommended)
```bash
npm install -g contour-generator

# Verify installation
contour-generator --help
```

### Option 2: Local Development
```bash
git clone https://github.com/TechIdiots-LLC/contour-generator.git
cd contour-generator
npm install

# Run with
node . --help
```

### Option 3: Docker
```bash
# No installation needed - runs in container
docker run --rm wifidb/contour-generator --help
```

## Core Concepts

### Generation Functions
- **`pyramid`**: Generate contours for a single map tile and all its children
- **`zoom`**: Process all tiles at a specific zoom level
- **`bbox`**: Process all tiles within a geographic bounding box

### DEM Sources
The tool supports various elevation data sources:
- **PMTiles**: `pmtiles:///path/to/file.pmtiles` (local) or `pmtiles://https://foo.lan/file.pmtiles` (HTTP)
- **MBTiles**: `mbtiles:///path/to/file.mbtiles` (local only)
- **Tile server**: `https://example.com/{z}/{x}/{y}.png`

### Encodings
- **`terrarium`**: RGB encoding where elevation = (R × 256² + G × 256 + B) / 256 - 32768
- **`mapbox`**: RGB encoding where elevation = -10000 + ((R × 256² + G × 256 + B) × 0.1)

## Usage Examples

### Generate contours for a specific area (pyramid)

```bash
contour-generator pyramid \
  --z 9 --x 272 --y 179 \
  --demUrl "pmtiles://https://techidiots-llc.github.io/contour_generator/test_data/terrain-tiles.pmtiles" \
  --sourceMaxZoom 12 \
  --encoding mapbox \
  --increment 50 \
  --outputMaxZoom 15 \
  --outputDir "./output"
```
*Generates contours for tile 9/272/179 and all child tiles up to zoom 15, with 50m elevation intervals*

### Process an entire zoom level

```bash
contour-generator zoom \
  --demUrl "pmtiles://./elevation-data.pmtiles" \
  --sourceMaxZoom 7 \
  --outputMinZoom 5 \
  --outputMaxZoom 7 \
  --increment 100 \
  --outputDir "./output"
```
*Processes all tiles from zoom 5 to 7 with 100m contour intervals*

### Process a geographic area (bbox)

```bash
contour-generator bbox \
  --minx -73.51 --miny 41.23 \
  --maxx -69.93 --maxy 42.88 \
  --demUrl "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png" \
  --sourceMaxZoom 15 \
  --encoding terrarium \
  --increment 50 \
  --outputMinZoom 5 \
  --outputMaxZoom 10 \
  --outputDir "./output"
```
*Generates contours for New England area with 50m intervals*

### Docker Usage

When using Docker, map your local directory to `/data` inside the container:

```bash
# Download test data
wget https://github.com/TechIdiots-LLC/contour-generator/releases/download/test_data/JAXA_2024_terrainrgb_z0-Z7_webp.pmtiles

# Run with Docker
docker run --rm -v $(pwd):/data wifidb/contour-generator \
  zoom \
  --demUrl "pmtiles:///data/JAXA_2024_terrainrgb_z0-Z7_webp.pmtiles" \
  --outputDir "/data/output" \
  --sourceMaxZoom 7 \
  --outputMaxZoom 7 \
  --increment 100
```

**Important**: All file paths in Docker must be under `/data/` since that's where your local directory is mounted.

## Configuration Options

### General Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--demUrl` | *required* | DEM source URL or file path |
| `--encoding` | `mapbox` | DEM encoding format (`mapbox` or `terrarium`) |
| `--sourceMaxZoom` | `8` | Maximum zoom of source DEM tiles |
| `--increment` | `0` | Contour interval in meters (0 = auto thresholds) |
| `--outputMaxZoom` | `8` | Maximum zoom of output tiles |
| `--outputDir` | `./output` | Directory for generated tiles |
| `--processes` | `8` | Parallel processes (adjust for your CPU) |
| `--verbose` | `false` | Enable detailed logging |

### Function-specific Parameters

**pyramid function:**
- `--x`, `--y`, `--z`: Tile coordinates (required)

**zoom function:**
- `--outputMinZoom`: Starting zoom level (default: 5)

**bbox function:**
- `--minx`, `--miny`, `--maxx`, `--maxy`: Bounding box coordinates (required)
- `--outputMinZoom`: Starting zoom level (default: 5)

### Missing Tiles and No Data

Contours are only drawn where the DEM has ground. A DEM tile that does not exist is treated as no data, so no contour tile is written under it and lines stop where the data does. (Earlier versions filled missing tiles with a flat blank tile, which drew packed lines along the edge of the data.)

Pixels inside a DEM tile can also mean "nothing here". They are treated as no data when they are:

- fully transparent
- a mapbox-encoded pixel of exactly -10000 m, which is what an all-black pixel decodes to
- equal to a `--maskValue`, or inside a `--maskRange`

Marking no-data pixels matters for speed as well as appearance: a few stray -10000 m pixels beside terrain make the tracer walk thousands of levels per cell. Resampling blurs sentinels, so a sea authored as exactly 0 often arrives as 0 with scattered -0.4 and 0.1 values. A band catches those where an exact value would not.

| Parameter | Description |
|-----------|-------------|
| `--maskValue <metres>` | A height that means no data. Repeat for several. |
| `--maskRange <low,high>` | A band of heights that means no data, like `--maskRange=-10001,-9999`. Repeat for several. |

Write negative values as `--maskValue=-10000` so they are not read as another option.

`--blankTileNoDataValue`, `--blankTileSize` and `--blankTileFormat` are deprecated and ignored.

## Using the Output

The tool generates:
- **Tile files**: `output/{z}/{x}/{y}.pbf` - Vector tiles containing contour lines
- **Metadata**: `metadata.json` - Tile set information

### Converting to MBTiles or PMTiles

Use [TechIdiots-LLC/mbutil](https://github.com/TechIdiots-LLC/mbutil) to convert the output directory into MBTiles or PMTiles archives.

**Option A: Install from source**
```bash
git clone --recursive https://github.com/TechIdiots-LLC/mbutil.git
cd mbutil
pip install .

# Convert directory to MBTiles
mb-util --image_format=pbf --do_compression ./output contours.mbtiles

# Or convert directory to PMTiles
mb-util --image_format=pbf ./output contours.pmtiles
```

**Option B: Use Docker**
```bash
# Pull the latest version
docker pull wifidb/mbutil

# Convert directory to MBTiles
docker run -v $(pwd):/data wifidb/mbutil --image_format pbf --do_compression /data/output /data/contours.mbtiles

# Or convert directory to PMTiles
docker run -v $(pwd):/data wifidb/mbutil --image_format pbf /data/output /data/contours.pmtiles
```

### Viewing in a web map
```javascript
// Add to MapLibre GL JS
map.addSource('contour-source', {
    type: 'vector',
    tiles: ['http://localhost:3000/{z}/{x}/{y}.pbf'],
    maxzoom: 15
});

// Add contour lines with variable width based on elevation level
map.addLayer({
    id: "contour-lines",
    type: "line",
    source: "contour-source",
    "source-layer": "contours",
    paint: {
        "line-color": "rgba(0,0,0, 50%)",
        // level = highest index in thresholds array the elevation is a multiple of
        "line-width": ["match", ["get", "level"], 1, 1, 0.5],
    },
});

// Add elevation labels on major contour lines
map.addLayer({
    id: "contour-labels",
    type: "symbol",
    source: "contour-source",
    "source-layer": "contours",
    filter: [">", ["get", "level"], 0],
    layout: {
        "symbol-placement": "line",
        "text-size": 10,
        "text-field": ["concat", ["number-format", ["get", "ele"], {}], "'"],
        "text-font": ["Noto Sans Bold"],
    },
    paint: {
        "text-halo-color": "white",
        "text-halo-width": 1,
    },
});
```

## Performance Guidelines

### Processing Time Estimates
- **Single tile (pyramid)**: 10-60 seconds
- **Full zoom level**: Minutes to hours depending on area
- **Large bbox**: Can take several hours

### System Requirements
- **RAM**: 4GB minimum, 8GB+ recommended for large areas
- **Storage**: ~1MB per tile generated
- **CPU**: More processes = faster completion (try `--processes` = CPU cores)

### Optimization Tips
- Use local DEM files when possible (faster than HTTP)
- Start with higher `--increment` values for faster processing
- Test with small areas (`pyramid`) before large batch jobs
- Monitor disk space - large bbox operations can generate many GB

## Troubleshooting

### Common Issues

**Out of memory errors**
- Reduce `--processes` count
- Process smaller areas at a time
- Increase system swap space

**Permission errors (Docker)**
- Ensure output directory is writable: `chmod 755 $(pwd)`
- On Windows, use full path: `-v C:\path\to\data:/data`

**Slow processing**
- Use local files instead of HTTP sources
- Reduce `--outputMaxZoom` for testing
- Check internet connection for remote sources

### Getting Help

```bash
# View general help
contour-generator --help

# Function-specific help
contour-generator pyramid --help
contour-generator zoom --help
contour-generator bbox --help
```

## Data Sources & Licensing

### Test Data
- **AWS Terrain Tiles**: [terrain-tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/)
- **JAXA AW3D30**: [JAXA Earth Data Policy](https://earth.jaxa.jp/en/data/policy/)
