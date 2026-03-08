# Michigan Precinct Map

## Python virtual environment setup

Your current `.venv` points to a Microsoft Store Python shim path, so it cannot be executed in this environment.

To create a working `.venv`, install/enable a standard Python interpreter and run:

```powershell
cd C:\Users\Shama\OneDrive\Documents\Course_Materials\CPT-236\Side_Projects\MIPrecinctMap
python -m venv .venv
# or:
# C:\Path\To\Python\python.exe -m venv .venv

# Activate
. .\.venv\Scripts\Activate.ps1

# Verify
python --version
```

If `py -m venv` still fails with **Access denied**, remove the existing environment and recreate with a full Python executable:

```powershell
Remove-Item -Recurse -Force .venv

# replace <python.exe> with your real interpreter path
& "<python.exe>" -m venv .venv
```

---

## Michigan map config done in `index.html`

- Title/OG metadata updated to Michigan
- Initial map center/zoom/bounds updated for Michigan
- Data/config path references switched to Michigan files (`Data/`)
- OpenElections CSV list updated to Michigan years:
  - 2008, 2012, 2016, 2020, 2024

---

## Build Michigan data artifacts

This repo now includes a local builder:

```powershell
node .\Scripts\build_mi_data.mjs
```

It generates:

- `Data\contests\*.json`
- `Data\contests\manifest.json`
- `Data\district_contests\*.json`
- `Data\district_contests\manifest.json`
- `Data\mi_elections_aggregated.json`
- `Data\mi_district_results_2022_lines.json`
- `Data\tileset\mi_cd118_tileset.geojson`
- `Data\tileset\mi_state_house_2022_lines_tileset.geojson`
- `Data\tileset\mi_state_senate_2022_lines_tileset.geojson`

Current limitation:

- The raw Michigan inputs in this repo do not include a clean precinct-name-to-Census-VTD crosswalk, so `Data\Voting_Precincts.geojson` and `Data\precinct_centroids.geojson` are generated as empty placeholders to prevent path failures. County and district views work from the generated data, but precinct overlay is not yet wired to real Michigan precinct geometry.

Builder behavior:

- Statewide contest slices in `Data\contests\*.json` are generated at precinct level for overlay coloring.
- County aggregate totals are still generated separately for county fills, sidebar state totals, and district fallback logic.
- Non-geographic precinct rows such as early-vote buckets, counting boards, absentee-style buckets, and aggregated multi-precinct labels are excluded from precinct overlay slices but retained in county aggregates.

---

## Download TIGER 2008 Michigan VTD geometry

This repo also includes:

```powershell
node .\Scripts\download_mi_tiger2008_vtd.mjs
```

It downloads county-level TIGER 2008 `vtd00` ZIPs from Census, converts them, and writes:

- `Data\Voting_Precincts.geojson`
- `Data\precinct_centroids.geojson`
- cached ZIP/temporary files under `Data\tiger2008_vtd\`

Current status:

- The merged 2008 VTD geometry now exists locally.
- Two counties were skipped during download:
  - `26069 Iosco`
  - `26077 Kalamazoo`
- The TIGER 2008 VTD attributes are still Census-style identifiers such as `VTDST00`, `VTDIDFP00`, and `NAMELSAD00`, not the election precinct names used in the Michigan CSVs.
- That means the boundary layer is present, but a reliable precinct-result join still needs another crosswalk or a better Michigan precinct source.

---

## Download official Michigan precinct geometry

Preferred source:

```powershell
node .\Scripts\download_mi_official_precincts.mjs
```

This downloads the official Michigan `2024 Voting Precincts` layer from the state ArcGIS service and overwrites:

- `Data\Voting_Precincts.geojson`
- `Data\precinct_centroids.geojson`

Current status:

- The official precinct layer is now downloaded locally.
- The geometry includes fields such as `Precinct_Long_Name`, `Precinct_Short_Name`, `Jurisdiction_Name`, `PRECINCTID`, and `VTDST`.
- This source is materially better than the TIGER 2008 fallback for matching against the Michigan election CSV precinct names, but it still does not produce a perfect statewide join without additional crosswalk logic.
- The app now applies Michigan-specific alias matching for ward removal, `Pct` -> `Precinct`, charter-township normalization, and common jurisdiction suffix noise.
