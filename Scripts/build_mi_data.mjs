import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const contestsDir = path.join(dataDir, 'contests');
const districtContestsDir = path.join(dataDir, 'district_contests');
const tilesetDir = path.join(dataDir, 'tileset');

fs.mkdirSync(contestsDir, { recursive: true });
fs.mkdirSync(districtContestsDir, { recursive: true });
fs.mkdirSync(tilesetDir, { recursive: true });

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function normalizeOffice(rawOffice) {
  const office = String(rawOffice || '').trim().toLowerCase();
  if (!office) return null;
  if (office === 'president' || office === 'president of the united states') {
    return { contestType: 'president', kind: 'statewide' };
  }
  if (office === 'governor') return { contestType: 'governor', kind: 'statewide' };
  if (office === 'u.s. senate' || office === 'us senate' || office === 'united states senator') {
    return { contestType: 'us_senate', kind: 'statewide' };
  }
  if (office === 'lieutenant governor') return { contestType: 'lieutenant_governor', kind: 'statewide' };
  if (office === 'attorney general') return { contestType: 'attorney_general', kind: 'statewide' };
  if (office === 'secretary of state') return { contestType: 'secretary_of_state', kind: 'statewide' };
  if (office === 'treasurer') return { contestType: 'treasurer', kind: 'statewide' };
  if (office === 'auditor general' || office === 'auditor') return { contestType: 'auditor', kind: 'statewide' };
  if (office === 'u.s. house' || office === 'us house' || office === 'u.s. representative') {
    return { contestType: 'us_house', kind: 'district', scope: 'congressional' };
  }
  if (office === 'state house') {
    return { contestType: 'state_house', kind: 'district', scope: 'state_house' };
  }
  if (office === 'state senate') {
    return { contestType: 'state_senate', kind: 'district', scope: 'state_senate' };
  }
  return null;
}

function isNonGeographicPrecinctName(rawPrecinct) {
  const value = String(rawPrecinct || '').trim();
  if (!value) return true;
  const upper = value.toUpperCase().replace(/\s+/g, ' ').trim();

  if (
    upper.includes('EARLY VOT') ||
    upper.includes('ABSENTEE') ||
    upper.includes('COUNTING BOARD') ||
    upper.includes('AV COUNTING BOARD') ||
    upper.includes('PROVISIONAL') ||
    upper.includes('CURBSIDE') ||
    upper.includes('UOCAVA') ||
    upper.includes('POST ELECTION') ||
    upper.includes('LATE ARRIVING') ||
    upper.includes('MULTI-PRECINCT')
  ) {
    return true;
  }

  if (/\b(?:EV|AVCB|ACB|CB)\s*\d+\b/.test(upper)) return true;
  if (/,\s*CB\s*\d+\b/.test(upper)) return true;

  // Aggregated labels like "City of Dowagiac Precincts 1,2 & 3" do not map to one polygon.
  if (/\bPRECINCTS\b/.test(upper)) return true;

  return false;
}

function ensureAgg(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      dem_votes: 0,
      rep_votes: 0,
      other_votes: 0,
      total_votes: 0,
      dem_candidate: '',
      rep_candidate: ''
    });
  }
  return map.get(key);
}

function addVotes(node, party, candidate, votes) {
  const p = String(party || '').trim().toUpperCase();
  node.total_votes += votes;
  if (p === 'DEM' || p === 'D') {
    node.dem_votes += votes;
    if (!node.dem_candidate && candidate) node.dem_candidate = candidate;
  } else if (p === 'REP' || p === 'R') {
    node.rep_votes += votes;
    if (!node.rep_candidate && candidate) node.rep_candidate = candidate;
  } else {
    node.other_votes += votes;
  }
}

function finalizeNode(node) {
  const total = Number(node.total_votes || 0);
  const dem = Number(node.dem_votes || 0);
  const rep = Number(node.rep_votes || 0);
  const signedMarginVotes = rep - dem;
  const signedMarginPct = total > 0 ? ((rep - dem) / total) * 100 : 0;
  let winner = 'TIE';
  if (dem > rep) winner = 'DEM';
  else if (rep > dem) winner = 'REP';
  else if (node.other_votes > 0) winner = 'OTHER';
  return {
    ...node,
    margin: Math.abs(signedMarginVotes),
    margin_pct: Number(signedMarginPct.toFixed(6)),
    winner,
    color: ''
  };
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function runMapshaper(inputZip, outputGeojson) {
  if (fileExists(outputGeojson)) return;
  const result = spawnSync(
    'cmd.exe',
    ['/c', 'npx.cmd', '--yes', 'mapshaper', inputZip, '-o', 'format=geojson', outputGeojson],
    { cwd: rootDir, stdio: 'inherit', shell: false }
  );
  if (result.status !== 0) {
    throw new Error(`mapshaper failed for ${path.basename(inputZip)}`);
  }
}

function writeEmptyFeatureCollection(filePath) {
  if (fileExists(filePath)) return;
  writeJson(filePath, {
    type: 'FeatureCollection',
    features: []
  });
}

const precinctContestAgg = new Map();
const countyContestAgg = new Map();
const districtContestAgg = new Map();

const csvFiles = fs.readdirSync(dataDir)
  .filter(name => /^\d{8}__mi__general__precinct\.csv$/i.test(name))
  .sort();

for (const fileName of csvFiles) {
  const year = Number(fileName.slice(0, 4));
  const filePath = path.join(dataDir, fileName);
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let headers = null;

  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }

    const values = parseCsvLine(line);
    if (values.length !== headers.length) continue;

    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = values[i];
    }

    const officeMeta = normalizeOffice(row.office);
    if (!officeMeta) continue;

    const votes = Number(row.votes || 0);
    if (!Number.isFinite(votes) || votes < 0) continue;

    const county = String(row.county || '').trim();
    if (!county) continue;

    if (officeMeta.kind === 'statewide') {
      const precinct = String(row.precinct || '').trim();
      const precinctKey = precinct || '__NO_PRECINCT__';

      if (!isNonGeographicPrecinctName(precinct)) {
        const precinctAggKey = `${year}|${officeMeta.contestType}|${county}|${precinctKey}`;
        const precinctNode = ensureAgg(precinctContestAgg, precinctAggKey);
        addVotes(precinctNode, row.party, String(row.candidate || '').trim(), votes);
      }

      const countyAggKey = `${year}|${officeMeta.contestType}|${county}`;
      const countyNode = ensureAgg(countyContestAgg, countyAggKey);
      addVotes(countyNode, row.party, String(row.candidate || '').trim(), votes);
      continue;
    }

    const district = String(row.district || '').trim();
    if (!district) continue;
    const aggKey = `${year}|${officeMeta.scope}|${officeMeta.contestType}|${district}`;
    const node = ensureAgg(districtContestAgg, aggKey);
    addVotes(node, row.party, String(row.candidate || '').trim(), votes);
  }
}

const contestManifest = [];
const districtManifest = [];
const electionResultsByYear = {};
const districtResultsByYear = {};

const precinctSlicesByContest = new Map();
for (const [aggKey, rawNode] of precinctContestAgg.entries()) {
  const [yearStr, contestType, county, precinctKey] = aggKey.split('|');
  const year = Number(yearStr);
  const finalized = finalizeNode(rawNode);
  const precinct = precinctKey === '__NO_PRECINCT__' ? '' : precinctKey;
  const rowCounty = precinct ? `${county} - ${precinct}` : county;

  const sliceKey = `${contestType}|${year}`;
  if (!precinctSlicesByContest.has(sliceKey)) precinctSlicesByContest.set(sliceKey, []);
  precinctSlicesByContest.get(sliceKey).push({
    county: rowCounty,
    ...finalized
  });
}

for (const [aggKey, rawNode] of countyContestAgg.entries()) {
  const [yearStr, contestType, county] = aggKey.split('|');
  const year = Number(yearStr);
  const finalized = finalizeNode(rawNode);

  if (!electionResultsByYear[year]) electionResultsByYear[year] = {};
  if (!electionResultsByYear[year][contestType]) electionResultsByYear[year][contestType] = {};
  if (!electionResultsByYear[year][contestType].general) {
    electionResultsByYear[year][contestType].general = { results: {} };
  }
  electionResultsByYear[year][contestType].general.results[county] = finalized;
}

for (const [sliceKey, rows] of precinctSlicesByContest.entries()) {
  const [contestType, yearStr] = sliceKey.split('|');
  const year = Number(yearStr);
  rows.sort((a, b) => a.county.localeCompare(b.county));
  const file = `${contestType}_${year}.json`;
  writeJson(path.join(contestsDir, file), {
    meta: {
      year,
      contest_type: contestType,
      rows: rows.length,
      level: 'precinct'
    },
    rows
  });
  contestManifest.push({
    year,
    contest_type: contestType,
    file,
    rows: rows.length,
    level: 'precinct'
  });
}

for (const [aggKey, rawNode] of districtContestAgg.entries()) {
  const [yearStr, scope, contestType, district] = aggKey.split('|');
  const year = Number(yearStr);
  const finalized = finalizeNode(rawNode);

  if (!districtResultsByYear[year]) districtResultsByYear[year] = {};
  if (!districtResultsByYear[year][scope]) districtResultsByYear[year][scope] = {};
  if (!districtResultsByYear[year][scope][contestType]) {
    districtResultsByYear[year][scope][contestType] = {
      meta: { match_coverage_pct: 100 },
      general: { results: {} }
    };
  }
  districtResultsByYear[year][scope][contestType].general.results[district] = finalized;
}

for (const [yearStr, scopes] of Object.entries(districtResultsByYear)) {
  const year = Number(yearStr);
  for (const [scope, contests] of Object.entries(scopes)) {
    for (const [contestType, payload] of Object.entries(contests)) {
      const districtCount = Object.keys(payload.general.results || {}).length;
      const file = `${scope}_${contestType}_${year}.json`;
      writeJson(path.join(districtContestsDir, file), payload);
      districtManifest.push({
        year,
        scope,
        contest_type: contestType,
        file,
        districts: districtCount
      });
    }
  }
}

contestManifest.sort((a, b) => {
  if (a.contest_type !== b.contest_type) return a.contest_type.localeCompare(b.contest_type);
  return a.year - b.year;
});

districtManifest.sort((a, b) => {
  if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
  if (a.contest_type !== b.contest_type) return a.contest_type.localeCompare(b.contest_type);
  return a.year - b.year;
});

writeJson(path.join(contestsDir, 'manifest.json'), { files: contestManifest });
writeJson(path.join(districtContestsDir, 'manifest.json'), { files: districtManifest });
writeJson(path.join(dataDir, 'mi_elections_aggregated.json'), {
  metadata: {
    generated_at: new Date().toISOString(),
    source: 'Michigan precinct CSV files'
  },
  results_by_year: electionResultsByYear
});
writeJson(path.join(dataDir, 'mi_district_results_2022_lines.json'), {
  metadata: {
    generated_at: new Date().toISOString(),
    source: 'Michigan precinct CSV files',
    note: 'District rows come directly from reported contest districts; statewide reallocation to district lines is not included.'
  },
  results_by_year: districtResultsByYear
});

runMapshaper(path.join(dataDir, 'tl_2022_26_cd118.zip'), path.join(tilesetDir, 'mi_cd118_tileset.geojson'));
runMapshaper(path.join(dataDir, 'tl_2024_26_sldl.zip'), path.join(tilesetDir, 'mi_state_house_2022_lines_tileset.geojson'));
runMapshaper(path.join(dataDir, 'tl_2024_26_sldu.zip'), path.join(tilesetDir, 'mi_state_senate_2022_lines_tileset.geojson'));

// Michigan raw inputs in this repo do not include a stable precinct-name-to-VTD crosswalk,
// so create harmless placeholders instead of writing misleading precinct geometry.
writeEmptyFeatureCollection(path.join(dataDir, 'Voting_Precincts.geojson'));
writeEmptyFeatureCollection(path.join(dataDir, 'precinct_centroids.geojson'));

console.log(`Built ${contestManifest.length} county contest slices.`);
console.log(`Built ${districtManifest.length} district contest slices.`);
