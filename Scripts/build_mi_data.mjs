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

function canonicalCountyName(rawCounty) {
  const county = String(rawCounty || '').replace(/\s+/g, ' ').trim();
  if (!county) return '';
  if (/^Gd\.?\s+Traverse$/i.test(county)) return 'Grand Traverse';
  if (/^Shiawasse$/i.test(county)) return 'Shiawassee';
  if (/^St\.?\s*Joseph'?s$/i.test(county)) return 'St. Joseph';
  return county;
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
  if (upper === '9999') return true;

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeCountyLookup(rawCounty) {
  return canonicalCountyName(rawCounty)
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNumericToken(token) {
  if (!/^\d+$/.test(token)) return token;
  return String(Number(token));
}

function normalizePrecinctAlias(rawValue, county = '') {
  let value = String(rawValue || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[’']/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+-\s+[A-Z]{2,4}\s*$/g, ' ')
    .replace(/\bPCT\b/g, 'PRECINCT')
    .replace(/\bTWP\b/g, 'TOWNSHIP')
    .replace(/\bCHARTER TOWNSHIP\b/g, 'TOWNSHIP')
    .replace(/\bGUNPLAIN\b/g, 'GUN PLAIN')
    .replace(/\bDISTRICT\b/g, ' ')
    .replace(/\bDIST\b/g, ' ')
    .replace(/\bTHE\s+(CITY|VILLAGE|TOWNSHIP)\s+OF\b/g, '$1 OF')
    .replace(/\bA MICHIGAN (CITY|VILLAGE|TOWNSHIP)\b/g, ' ')
    .replace(/\bPRECINCT\s*0+(\d)\b/g, 'PRECINCT $1')
    .replace(/\bWARD\s*0+(\d)\b/g, 'WARD $1')
    .replace(/,/g, ' ')
    .replace(/[./-]/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/\s+/g, ' ')
    .trim();

  if (county) {
    const countyKey = normalizeCountyLookup(county);
    if (countyKey) {
      value = value.replace(new RegExp(`\\b${countyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b$`), '').trim();
    }
  }

  const tokens = value
    .split(' ')
    .filter(Boolean)
    .map(normalizeNumericToken);

  return tokens.join(' ').trim();
}

function buildPrecinctAliases(rawValue, county = '') {
  const aliases = new Set();

  function push(candidate) {
    const normalized = normalizePrecinctAlias(candidate, county);
    if (normalized) aliases.add(normalized);
  }

  push(rawValue);
  const base = normalizePrecinctAlias(rawValue, county);
  if (!base) return aliases;

  const wardPrecinctMatch = base.match(/^(\d+)\s+(\d+)$/);
  if (wardPrecinctMatch) {
    push(`WARD ${wardPrecinctMatch[1]} PRECINCT ${wardPrecinctMatch[2]}`);
  }

  const dashWardMatch = base.match(/^(\d+)\s+(\d+)$/);
  if (dashWardMatch) {
    push(`${dashWardMatch[1]}-${dashWardMatch[2]}`);
  }

  const cityOfMatch = base.match(/^(CITY|VILLAGE|TOWNSHIP) OF (.+?) PRECINCT (\d+)$/);
  if (cityOfMatch) {
    push(`${cityOfMatch[2]} ${cityOfMatch[1]} PRECINCT ${cityOfMatch[3]}`);
    push(`${cityOfMatch[2]} PRECINCT ${cityOfMatch[3]}`);
  }

  const suffixTypeMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) PRECINCT (\d+)$/);
  if (suffixTypeMatch) {
    push(`${suffixTypeMatch[2]} OF ${suffixTypeMatch[1]} PRECINCT ${suffixTypeMatch[3]}`);
    push(`${suffixTypeMatch[1]} PRECINCT ${suffixTypeMatch[3]}`);
  }

  const numberedTypeMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) (\d+)$/);
  if (numberedTypeMatch) {
    push(`${numberedTypeMatch[1]} ${numberedTypeMatch[2]} PRECINCT ${numberedTypeMatch[3]}`);
    push(`${numberedTypeMatch[2]} OF ${numberedTypeMatch[1]} PRECINCT ${numberedTypeMatch[3]}`);
    push(`${numberedTypeMatch[1]} PRECINCT ${numberedTypeMatch[3]}`);
  }

  const numberedTypeWardMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) (\d+) WARD (\d+)$/);
  if (numberedTypeWardMatch) {
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[2]} PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
    push(`${numberedTypeWardMatch[2]} OF ${numberedTypeWardMatch[1]} PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
    push(`WARD ${numberedTypeWardMatch[4]} PRECINCT ${numberedTypeWardMatch[3]}`);
    push(`PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
  }

  const townshipOfMatch = base.match(/^TOWNSHIP OF (.+)$/);
  if (townshipOfMatch) {
    push(`${townshipOfMatch[1]} TOWNSHIP`);
  }

  const wardLeadingMatch = base.match(/^WARD (\d+) PRECINCT (\d+)$/);
  if (wardLeadingMatch) {
    push(`${wardLeadingMatch[1]}-${wardLeadingMatch[2]}`);
    push(`PRECINCT ${wardLeadingMatch[2]} WARD ${wardLeadingMatch[1]}`);
  }

  const wardTrailingMatch = base.match(/^PRECINCT (\d+) WARD (\d+)$/);
  if (wardTrailingMatch) {
    push(`WARD ${wardTrailingMatch[2]} PRECINCT ${wardTrailingMatch[1]}`);
    push(`${wardTrailingMatch[2]}-${wardTrailingMatch[1]}`);
  }

  return aliases;
}

function computeRingBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return { minX, minY, maxX, maxY };
}

function boundsContainPoint(bounds, point) {
  return (
    point[0] >= bounds.minX &&
    point[0] <= bounds.maxX &&
    point[1] >= bounds.minY &&
    point[1] <= bounds.maxY
  );
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygon(point, rings) {
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates || []);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some(polygon => pointInPolygon(point, polygon));
  }
  return false;
}

function normalizeDistrictId(rawValue) {
  const num = Number(String(rawValue || '').trim());
  if (!Number.isFinite(num)) return '';
  return String(num);
}

function loadDistrictFeatures(filePath, propertyName) {
  const geojson = readJson(filePath);
  return (geojson.features || [])
    .map(feature => {
      const district = normalizeDistrictId(feature?.properties?.[propertyName]);
      if (!district || !feature?.geometry) return null;
      let bounds = null;
      if (feature.geometry.type === 'Polygon') {
        bounds = computeRingBounds(feature.geometry.coordinates[0] || []);
      } else if (feature.geometry.type === 'MultiPolygon') {
        const polygons = feature.geometry.coordinates || [];
        const firstRing = polygons[0]?.[0] || [];
        bounds = computeRingBounds(firstRing);
        for (let i = 1; i < polygons.length; i += 1) {
          const nextBounds = computeRingBounds(polygons[i][0] || []);
          bounds = {
            minX: Math.min(bounds.minX, nextBounds.minX),
            minY: Math.min(bounds.minY, nextBounds.minY),
            maxX: Math.max(bounds.maxX, nextBounds.maxX),
            maxY: Math.max(bounds.maxY, nextBounds.maxY)
          };
        }
      }
      if (!bounds) return null;
      return { district, bounds, geometry: feature.geometry };
    })
    .filter(Boolean);
}

function assignPointToDistrict(point, districtFeatures) {
  for (const feature of districtFeatures) {
    if (!boundsContainPoint(feature.bounds, point)) continue;
    if (pointInGeometry(point, feature.geometry)) return feature.district;
  }
  return '';
}

async function buildVtdDistrictShareMaps() {
  const vtdAssignmentPath = path.join(dataDir, '.blockassign_tmp', 'BlockAssign_ST26_MI_VTD.txt');
  const scopeFiles = {
    congressional: path.join(dataDir, '.blockassign_tmp', 'BlockAssign_ST26_MI_CD.txt'),
    state_house: path.join(dataDir, '.blockassign_tmp', 'BlockAssign_ST26_MI_SLDL.txt'),
    state_senate: path.join(dataDir, '.blockassign_tmp', 'BlockAssign_ST26_MI_SLDU.txt')
  };

  if (!fileExists(vtdAssignmentPath)) return { congressional: new Map(), state_house: new Map(), state_senate: new Map() };

  const blockToVtd = new Map();
  const blockToCountyFips = new Map();
  const vtdRl = readline.createInterface({
    input: fs.createReadStream(vtdAssignmentPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let vtdHeaderSeen = false;
  for await (const rawLine of vtdRl) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    if (!vtdHeaderSeen) {
      vtdHeaderSeen = true;
      continue;
    }
    const [blockId, countyFp, vtd] = line.split('|');
    if (!blockId || !vtd) continue;
    const blockKey = blockId.trim();
    blockToVtd.set(blockKey, vtd.trim());
    if (countyFp) blockToCountyFips.set(blockKey, countyFp.trim());
  }

  const out = {};
  for (const [scope, filePath] of Object.entries(scopeFiles)) {
    const countsByVtd = new Map();
    const countsByCounty = new Map();
    if (!fileExists(filePath)) {
      out[scope] = { vtd: new Map(), county: new Map() };
      continue;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    let headerSeen = false;
    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line) continue;
      if (!headerSeen) {
        headerSeen = true;
        continue;
      }
      const [blockId, districtRaw] = line.split('|');
      const blockKey = String(blockId || '').trim();
      const district = normalizeDistrictId(districtRaw);
      const vtd = blockToVtd.get(blockKey);
      const countyFips = blockToCountyFips.get(blockKey);
      if (!vtd || !district) continue;

      if (!countsByVtd.has(vtd)) countsByVtd.set(vtd, { total: 0, districts: new Map() });
      const node = countsByVtd.get(vtd);
      node.total += 1;
      node.districts.set(district, (node.districts.get(district) || 0) + 1);

      if (countyFips) {
        if (!countsByCounty.has(countyFips)) countsByCounty.set(countyFips, { total: 0, districts: new Map() });
        const countyNode = countsByCounty.get(countyFips);
        countyNode.total += 1;
        countyNode.districts.set(district, (countyNode.districts.get(district) || 0) + 1);
      }
    }

    const vtdShareMap = new Map();
    for (const [vtd, node] of countsByVtd.entries()) {
      const parts = [];
      for (const [district, count] of node.districts.entries()) {
        parts.push({ district, share: count / node.total });
      }
      parts.sort((a, b) => b.share - a.share || a.district.localeCompare(b.district));
      vtdShareMap.set(vtd, parts);
    }

    const countyShareMap = new Map();
    for (const [countyFips, node] of countsByCounty.entries()) {
      const parts = [];
      for (const [district, count] of node.districts.entries()) {
        parts.push({ district, share: count / node.total });
      }
      parts.sort((a, b) => b.share - a.share || a.district.localeCompare(b.district));
      countyShareMap.set(countyFips, parts);
    }

    out[scope] = { vtd: vtdShareMap, county: countyShareMap };
  }

  return out;
}

function bumpShareCount(container, key, district) {
  if (!key || !district) return;
  if (!container.has(key)) container.set(key, { total: 0, districts: new Map() });
  const node = container.get(key);
  node.total += 1;
  node.districts.set(district, (node.districts.get(district) || 0) + 1);
}

function finalizeShareMap(countsMap) {
  const shareMap = new Map();
  for (const [key, node] of countsMap.entries()) {
    if (!node || !(node.total > 0)) continue;
    const parts = [];
    for (const [district, count] of node.districts.entries()) {
      if (!district || !(count > 0)) continue;
      parts.push({ district, share: count / node.total });
    }
    parts.sort((a, b) => b.share - a.share || a.district.localeCompare(b.district));
    if (parts.length) shareMap.set(key, parts);
  }
  return shareMap;
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
const districtCoverageAgg = new Map();

const districtFeaturesByScope = {
  congressional: loadDistrictFeatures(path.join(tilesetDir, 'mi_cd118_tileset.geojson'), 'CD118FP'),
  state_house: loadDistrictFeatures(path.join(tilesetDir, 'mi_state_house_2022_lines_tileset.geojson'), 'SLDLST'),
  state_senate: loadDistrictFeatures(path.join(tilesetDir, 'mi_state_senate_2022_lines_tileset.geojson'), 'SLDUST')
};

const vtdDistrictSharesByScope = await buildVtdDistrictShareMaps();
const precinctAssignmentLookup = new Map();
const countyNameToFips = new Map();
const currentShareCountsByScope = {
  congressional: { vtd: new Map(), county: new Map() },
  state_house: { vtd: new Map(), county: new Map() },
  state_senate: { vtd: new Map(), county: new Map() }
};
const centroidGeojsonPath = path.join(dataDir, 'precinct_centroids.geojson');
if (fileExists(centroidGeojsonPath)) {
  const centroidGeojson = readJson(centroidGeojsonPath);
  for (const feature of centroidGeojson.features || []) {
    const point = feature?.geometry?.coordinates;
    if (!Array.isArray(point) || point.length < 2) continue;
    const props = feature.properties || {};
    const countyKey = normalizeCountyLookup(props.county_nam || props.County_Name || props.Jurisdiction_Name || props.jurisdiction_name || '');
    const countyFips = String(props.county_fips || props.COUNTYFIPS || props.CountyFIPS || '').trim();
    if (!countyKey) continue;
    if (countyFips && !countyNameToFips.has(countyKey)) countyNameToFips.set(countyKey, countyFips);

    const districts = {
      congressional: assignPointToDistrict(point, districtFeaturesByScope.congressional),
      state_house: assignPointToDistrict(point, districtFeaturesByScope.state_house),
      state_senate: assignPointToDistrict(point, districtFeaturesByScope.state_senate)
    };
    const vtd = String(props.vtdst || props.VTDST || '').trim();

    for (const scope of Object.keys(districts)) {
      const district = districts[scope];
      if (!district) continue;
      if (vtd) bumpShareCount(currentShareCountsByScope[scope].vtd, vtd, district);
      if (countyFips) bumpShareCount(currentShareCountsByScope[scope].county, countyFips, district);
    }

    const rawNames = [
      props.prec_id,
      props.precinct_long_name,
      props.precinct_short_name,
      props.Precinct_Long_Name,
      props.Precinct_Short_Name
    ];

    const aliases = new Set();
    for (const rawName of rawNames) {
      for (const alias of buildPrecinctAliases(rawName, countyKey)) aliases.add(alias);
    }

    for (const alias of aliases) {
      const lookupKey = `${countyKey}|${alias}`;
      if (!precinctAssignmentLookup.has(lookupKey)) {
        precinctAssignmentLookup.set(lookupKey, { vtd, districts });
      }
    }
  }
}

for (const scope of Object.keys(currentShareCountsByScope)) {
  const currentShares = {
    vtd: finalizeShareMap(currentShareCountsByScope[scope].vtd),
    county: finalizeShareMap(currentShareCountsByScope[scope].county)
  };
  if (scope === 'congressional') {
    vtdDistrictSharesByScope[scope] = currentShares;
    continue;
  }
  if (!(vtdDistrictSharesByScope?.[scope]?.vtd instanceof Map) || vtdDistrictSharesByScope[scope].vtd.size === 0) {
    vtdDistrictSharesByScope[scope] = currentShares;
  }
}

const precinctDistrictCache = new Map();

function lookupPrecinctAssignment(county, precinct) {
  const countyKey = normalizeCountyLookup(county);
  const cacheKey = `${countyKey}|${precinct}`;
  if (precinctDistrictCache.has(cacheKey)) return precinctDistrictCache.get(cacheKey);

  let match = null;
  for (const alias of buildPrecinctAliases(precinct, countyKey)) {
    const lookupKey = `${countyKey}|${alias}`;
    if (precinctAssignmentLookup.has(lookupKey)) {
      match = precinctAssignmentLookup.get(lookupKey);
      break;
    }
  }

  precinctDistrictCache.set(cacheKey, match);
  return match;
}

const preferredCsvByDate = new Map();
fs.readdirSync(dataDir)
  .filter(name => /^\d{8}__mi__general__precinct(?:_mvic)?\.csv$/i.test(name))
  .sort()
  .forEach(name => {
    const dateKey = name.slice(0, 8);
    const prev = preferredCsvByDate.get(dateKey);
    if (!prev || /_mvic\.csv$/i.test(name)) preferredCsvByDate.set(dateKey, name);
  });
const csvFiles = Array.from(preferredCsvByDate.values()).sort();

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

    const county = canonicalCountyName(row.county);
    if (!county) continue;

    if (officeMeta.kind === 'statewide') {
      const precinct = String(row.precinct || '').trim();
      const precinctKey = precinct || '__NO_PRECINCT__';

      if (!isNonGeographicPrecinctName(precinct)) {
        const precinctAggKey = `${year}|${officeMeta.contestType}|${county}|${precinctKey}`;
        const precinctNode = ensureAgg(precinctContestAgg, precinctAggKey);
        addVotes(precinctNode, row.party, String(row.candidate || '').trim(), votes);

        const precinctAssignment = lookupPrecinctAssignment(county, precinct);
        for (const scope of Object.keys(districtFeaturesByScope)) {
          const coverageKey = `${year}|${scope}|${officeMeta.contestType}`;
          if (!districtCoverageAgg.has(coverageKey)) {
            districtCoverageAgg.set(coverageKey, { total_votes: 0, matched_votes: 0 });
          }
          const coverage = districtCoverageAgg.get(coverageKey);
          coverage.total_votes += votes;
          let allocated = false;

          const vtd = String(precinctAssignment?.vtd || '').trim();
          const vtdShares = vtd ? (vtdDistrictSharesByScope?.[scope]?.vtd?.get(vtd) || null) : null;
          if (Array.isArray(vtdShares) && vtdShares.length) {
            for (const part of vtdShares) {
              const share = Number(part.share || 0);
              if (!(share > 0)) continue;
              const districtAggKey = `${year}|${scope}|${officeMeta.contestType}|${part.district}`;
              const districtNode = ensureAgg(districtContestAgg, districtAggKey);
              addVotes(districtNode, row.party, String(row.candidate || '').trim(), votes * share);
              allocated = true;
            }
          } else {
            const fallbackDistrict = precinctAssignment?.districts?.[scope] || '';
            if (fallbackDistrict) {
              const districtAggKey = `${year}|${scope}|${officeMeta.contestType}|${fallbackDistrict}`;
              const districtNode = ensureAgg(districtContestAgg, districtAggKey);
              addVotes(districtNode, row.party, String(row.candidate || '').trim(), votes);
              allocated = true;
            } else {
              const countyFips = countyNameToFips.get(normalizeCountyLookup(county)) || '';
              const countyShares = countyFips ? (vtdDistrictSharesByScope?.[scope]?.county?.get(countyFips) || null) : null;
              if (Array.isArray(countyShares) && countyShares.length) {
                for (const part of countyShares) {
                  const share = Number(part.share || 0);
                  if (!(share > 0)) continue;
                  const districtAggKey = `${year}|${scope}|${officeMeta.contestType}|${part.district}`;
                  const districtNode = ensureAgg(districtContestAgg, districtAggKey);
                  addVotes(districtNode, row.party, String(row.candidate || '').trim(), votes * share);
                  allocated = true;
                }
              }
            }
          }

          if (allocated) coverage.matched_votes += votes;
        }
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
  const coverageKey = `${year}|${scope}|${contestType}`;
  const coverage = districtCoverageAgg.get(coverageKey);
  const matchCoveragePct = coverage && coverage.total_votes > 0
    ? Number(((coverage.matched_votes / coverage.total_votes) * 100).toFixed(6))
    : 100;

  if (!districtResultsByYear[year]) districtResultsByYear[year] = {};
  if (!districtResultsByYear[year][scope]) districtResultsByYear[year][scope] = {};
  if (!districtResultsByYear[year][scope][contestType]) {
    districtResultsByYear[year][scope][contestType] = {
      meta: { match_coverage_pct: matchCoveragePct },
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
    note: 'Statewide contests are aggregated from matched official precinct centroids to current district polygons; district-office contests still use reported district rows.'
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
