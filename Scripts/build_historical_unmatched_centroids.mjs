import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const unmatchedAuditCsvPath = path.join(dataDir, 'precinct_unmatched_pre2018_audit.csv');
const officialCentroidsPath = path.join(dataDir, 'precinct_centroids.geojson');
const outputPath = path.join(dataDir, 'precinct_centroids_historical_unmatched.geojson');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCounty(value) {
  return normalizeText(value);
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return [];

  function parseLine(line) {
    const out = [];
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
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseLine(lines[i]);
    if (fields.length !== header.length) continue;
    const row = {};
    for (let j = 0; j < header.length; j += 1) row[header[j]] = fields[j];
    rows.push(row);
  }
  return rows;
}

function extractLocalityCandidates(precinctLabel) {
  const raw = normalizeText(precinctLabel);
  const out = new Set();
  if (!raw) return out;

  out.add(raw);

  const withoutWardPrec = raw
    .replace(/\bWARD\s+\d+\b/g, ' ')
    .replace(/\bPRECINCT\s+[A-Z0-9-]+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutWardPrec) out.add(withoutWardPrec);

  const trailingNumber = raw
    .replace(/\bWARD\s+\d+\b/g, ' ')
    .replace(/\s+[A-Z0-9-]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (trailingNumber) out.add(trailingNumber);

  const noType = raw
    .replace(/\b(CITY|TOWNSHIP|VILLAGE)\b/g, ' ')
    .replace(/\bWARD\s+\d+\b/g, ' ')
    .replace(/\bPRECINCT\s+[A-Z0-9-]+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (noType) out.add(noType);

  return out;
}

function centroidOfPoints(points) {
  if (!points.length) return null;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  return [sumX / points.length, sumY / points.length];
}

function keyOfCountyPrecinct(county, precinct) {
  return `${normalizeCounty(county)}|${normalizeText(precinct)}`;
}

function main() {
  if (!fs.existsSync(unmatchedAuditCsvPath)) {
    throw new Error(`Missing unmatched audit CSV: ${unmatchedAuditCsvPath}`);
  }
  if (!fs.existsSync(officialCentroidsPath)) {
    throw new Error(`Missing official centroids: ${officialCentroidsPath}`);
  }

  const unmatchedRows = parseCsv(fs.readFileSync(unmatchedAuditCsvPath, 'utf8'));
  const official = readJson(officialCentroidsPath);

  const countyPoints = new Map();
  const countyLocalityPoints = new Map();
  const existingKeys = new Set();

  for (const feature of official.features || []) {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const county = String(props.county_nam || props.COUNTYNAME || props.County || props.NAME || '').trim();
    const precinct = String(props.prec_id || props.PREC_ID || '').trim();
    if (!county || !precinct) continue;

    existingKeys.add(keyOfCountyPrecinct(county, precinct));

    const countyKey = normalizeCounty(county);
    if (!countyPoints.has(countyKey)) countyPoints.set(countyKey, []);
    countyPoints.get(countyKey).push(coords);

    const localityCandidates = extractLocalityCandidates(precinct);
    if (!countyLocalityPoints.has(countyKey)) countyLocalityPoints.set(countyKey, new Map());
    const localityMap = countyLocalityPoints.get(countyKey);
    for (const candidate of localityCandidates) {
      if (!candidate) continue;
      if (!localityMap.has(candidate)) localityMap.set(candidate, []);
      localityMap.get(candidate).push(coords);
    }
  }

  const outputFeatures = [];
  let localityAnchored = 0;
  let countyAnchored = 0;
  let skippedExisting = 0;

  for (const row of unmatchedRows) {
    const county = String(row.county || '').trim();
    const precinct = String(row.precinct_label || '').trim();
    const years = String(row.years || '').trim();
    if (!county || !precinct) continue;

    const key = keyOfCountyPrecinct(county, precinct);
    if (existingKeys.has(key)) {
      skippedExisting += 1;
      continue;
    }

    const countyKey = normalizeCounty(county);
    const localityMap = countyLocalityPoints.get(countyKey) || new Map();

    let anchor = null;
    const localityCandidates = Array.from(extractLocalityCandidates(precinct));
    for (const locality of localityCandidates) {
      const pts = localityMap.get(locality) || [];
      if (pts.length >= 2) {
        anchor = centroidOfPoints(pts);
        break;
      }
    }

    let method = 'locality_mean';
    if (!anchor) {
      const countyPts = countyPoints.get(countyKey) || [];
      anchor = centroidOfPoints(countyPts);
      method = 'county_mean';
    }
    if (!anchor) continue;

    if (method === 'locality_mean') localityAnchored += 1;
    else countyAnchored += 1;

    outputFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: anchor },
      properties: {
        county_nam: county,
        prec_id: precinct,
        precinct_long_name: precinct,
        precinct_short_name: precinct,
        source: 'historical_unmatched_locality_estimate',
        approximate: true,
        anchor_method: method,
        years
      }
    });
  }

  writeJson(outputPath, {
    type: 'FeatureCollection',
    metadata: {
      generated_at: new Date().toISOString(),
      source_csv: path.basename(unmatchedAuditCsvPath),
      rows_in_audit: unmatchedRows.length,
      features_written: outputFeatures.length,
      locality_anchored: localityAnchored,
      county_anchored: countyAnchored,
      skipped_existing: skippedExisting
    },
    features: outputFeatures
  });

  console.log(`Wrote ${outputFeatures.length} historical unmatched centroid features`);
  console.log(`Locality anchors: ${localityAnchored}; county anchors: ${countyAnchored}`);
  console.log(`Output: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
