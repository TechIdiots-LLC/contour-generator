## main
### ✨ Features and improvements
- A missing DEM tile is now no data instead of a flat blank tile. Contours stop where the ground does and no tile is written under a missing DEM tile. `--blankTileNoDataValue`, `--blankTileSize` and `--blankTileFormat` are deprecated and ignored.
- Add `--maskValue` and `--maskRange` to mark heights that mean no data. A mapbox-encoded pixel of exactly -10000 m and fully transparent pixels are always masked.
- A tile server URL pattern now treats a 404 as a missing tile instead of an error.
- _...Add new stuff here..._

### 🐞 Bug fixes
- Stray no-data pixels such as mapbox's -10000 m no longer make a tile take minutes and produce an enormous vector tile.
- A PMTiles read error is reported instead of being treated as a missing tile.
- _...Add new stuff here..._

## 2.0.8
### ✨ Features and improvements
- Update to TechIdiots LLC ([#17](https://github.com/TechIdiots-LLC/contour-generator/pull/17)) (@acalcutt)

## 2.0.7
* Test Release
