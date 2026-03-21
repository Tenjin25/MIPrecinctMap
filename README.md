# Mitten Margin Atlas (2008-2024)

Interactive Michigan election map with county, precinct, and district views.

## Name Change

- Current app name: `Mitten Margin Atlas`
- Previous working name: `Michigan Precinct Map`
- Repository name remains `MIPrecinctMap` so the existing GitHub Pages URL stays stable.
- `NCMap.html` is an archived North Carolina prototype file; the active Michigan app is `index.html`.

## Run The App

Primary runtime is GitHub Pages (not a local server):

- Live site: https://tenjin25.github.io/MIPrecinctMap/
- Entry point: `index.html`
- Data is loaded from the repository `Data/` folder at runtime.

To publish updates, push changes to the branch configured for Pages (currently `main` in this repo). Once GitHub Pages finishes deployment, refresh the live URL.

## What The App Includes

- County-level and precinct-level election visualization.
- District overlays for:
  - U.S. Congressional districts (`Data/tileset/mi_cd118_tileset.geojson`)
  - Michigan State House districts (`Data/tileset/mi_state_house_2022_lines_tileset.geojson`)
  - Michigan State Senate districts (`Data/tileset/mi_state_senate_2022_lines_tileset.geojson`)
- Contest/year selection across multiple statewide and district contests.
- Mobile-safe controls and legend behavior for smaller screens.

## Current Data Coverage

From generated manifests in `Data/`:

- Years covered: `2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024`
- Statewide contest slices (precinct rows): `23` files in `Data/contests/manifest.json`
- District contest slices: `91` files in `Data/district_contests/manifest.json`
- Statewide contest types currently available:
  - `president`
  - `governor`
  - `us_senate`
  - `secretary_of_state`
  - `attorney_general`
- District scopes currently available:
  - `congressional`
  - `state_house`
  - `state_senate`

## Repository Layout

- `index.html`: production Michigan map application used by Pages.
- `Data/`: raw and generated election/geometry artifacts.
- `Data/contests/`: statewide contest files + manifest.
- `Data/district_contests/`: district contest files + manifest.
- `Data/tileset/`: district geometry used by overlays.
- `Scripts/`: data conversion, build, and geometry download scripts.
- `NCMap.html`: archived older NC prototype.
- `index.pre_nc_ui_backup.html`: UI backup snapshot from earlier migration work.

## Deployment Notes (GitHub Pages)

- This project is a static site (`index.html` + `Data/`), so there is no separate build step required for deployment.
- Keep relative paths intact when moving files; the app fetches data from `./Data/...`.
- If you ever rename the repository, the Pages path segment changes and you should retest all data fetches on the new URL.

## Data Sources

- Michigan election results in OpenElections-style CSV format (`Data/*__mi__general__precinct*.csv`).
- Michigan official precinct boundaries (ArcGIS OpenData boundaries service):
  - `https://gisagocss.state.mi.us/arcgis/rest/services/OpenData/boundaries/MapServer/9`
- U.S. Census TIGER/Line geometry used for district overlays and fallback precinct geometry:
  - Congressional and legislative district ZIPs in `Data/`
  - TIGER 2008 county VTD downloads used by `Scripts/download_mi_tiger2008_vtd.mjs`

## Maintainer Workflow (Data Refresh)

If you need to regenerate data artifacts before publishing:

1. Prerequisites:
   - Node.js 18+ (required for built-in `fetch` used by scripts).
   - `npm`/`npx` available in PATH.
2. Optional: convert MVIC package/text bundle to OpenElections-style CSV:

```powershell
node .\Scripts\convert_mvic_package_to_openelections.mjs .\Data\2024GEN.zip .\Data\20241105__mi__general__precinct_mvic.csv
```

3. Build derived contest and district artifacts:

```powershell
node .\Scripts\build_mi_data.mjs
```

4. Optional: fetch official Michigan precinct geometry (preferred over TIGER fallback):

```powershell
node .\Scripts\download_mi_official_precincts.mjs
```

5. Optional TIGER 2008 fallback geometry workflow:

```powershell
node .\Scripts\download_mi_tiger2008_vtd.mjs
```

6. Commit updated `Data/` files and push to `main` so Pages serves the latest build.

## Generated Artifacts

`Scripts/build_mi_data.mjs` writes:

- `Data/contests/*.json`
- `Data/contests/manifest.json`
- `Data/district_contests/*.json`
- `Data/district_contests/manifest.json`
- `Data/mi_elections_aggregated.json`
- `Data/mi_district_results_2022_lines.json`
- `Data/tileset/mi_cd118_tileset.geojson`
- `Data/tileset/mi_state_house_2022_lines_tileset.geojson`
- `Data/tileset/mi_state_senate_2022_lines_tileset.geojson`

## Known Limitations

- Precinct name matching is still heuristic; a perfect statewide precinct-name crosswalk is not yet guaranteed.
- Non-geographic/aggregate labels (for example early vote, counting boards, multi-precinct rollups) are intentionally excluded from precinct fill slices, but retained in county totals.
- District allocations for statewide contests use matched precinct assignments; congressional uses VTD overlap shares from TIGER VTD and CD118 shapefile intersections, while State House and State Senate use precinct-centroid overlays against 2022 legislative shapefiles. Pre-2022 U.S. House precinct rows are also reallocated to 2022 congressional lines through the same congressional share maps.

## Optional Local Preview (Development Only)

Production usage should be through GitHub Pages. If you still want a local preview:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/`.
