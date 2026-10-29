## main
### ✨ Features and improvements
- A missing DEM tile is now no data instead of a flat blank tile. Contours stop where the ground does and no tile is written under a missing DEM tile. `--blankTileNoDataValue`, `--blankTileSize` and `--blankTileFormat` are deprecated and ignored.
- Add `--maskValue` and `--maskRange` to mark heights that mean no data. A mapbox-encoded pixel of exactly -10000 m and fully transparent pixels are always masked.
- A tile server URL pattern now treats a 404 as a missing tile instead of an error.
- Progress is shown without `--verbose`: a `[progress]` line per pyramid every ten seconds, a `[slow]` line naming any tile that takes more than 30 seconds, and a `[failed]` line for any tile that fails.
- A failed tile or pyramid no longer stops the run. The failures are listed at the end and the command exits with an error; run it again to retry them.
- Add `--demTimeout` (seconds, default 120).
- _...Add new stuff here..._

### 🐞 Bug fixes
- Stray no-data pixels such as mapbox's -10000 m no longer make a tile take minutes and produce an enormous vector tile.
- A PMTiles read error is reported instead of being treated as a missing tile.
- The DEM tile timeout was 10 seconds, and tracing blocks the event loop, so a slow tile made other tiles' perfectly good DEM reads fail with "timed out". The default is now 120 seconds.
- A batch of 25 tiles waited for its slowest tile before starting the next. Tiles now run in a sliding window.
- Tiles with nothing to draw are no longer written as empty files.
- Errors in a batch were logged and dropped, and the worker still reported success. They are now reported and exit with an error.
- Workers are started without a shell, so an output directory or DEM path containing a space works.
- _...Add new stuff here..._

## 2.0.8
### ✨ Features and improvements
- Update to TechIdiots LLC ([#17](https://github.com/TechIdiots-LLC/contour-generator/pull/17)) (@acalcutt)

## 2.0.7
* Test Release
