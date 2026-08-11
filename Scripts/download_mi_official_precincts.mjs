import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const countiesPath = path.join(dataDir, 'tl_2020_26_county20.geojson');
const precinctGeojsonPath = path.join(dataDir, 'Voting_Precincts.geojson');
const centroidGeojsonPath = path.join(dataDir, 'precinct_centroids.geojson');
const serviceUrl = 'https://gisagocss.state.mi.us/arcgis/rest/services/OpenData/boundaries/MapServer/9';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Codex/MI-Precinct-Map' }
    });
    if (res.ok) return await res.json();
    lastErr = new Error(`Fetch failed ${res.status} for ${url}`);
    if (![403, 429, 500, 502, 503, 504].includes(res.status) || attempt === 4) break;
    await sleep(1000 * attempt);
  }
  throw lastErr;
}

function buildCountyNameByFips() {
  const geojson = JSON.parse(fs.readFileSync(countiesPath, 'utf8'));
  const map = new Map();
  for (const feature of geojson.features || []) {
    const props = feature.properties || {};
    const fips = String(props.COUNTYFP20 || props.COUNTYFP || '').trim().padStart(3, '0');
    const name = String(props.NAME20 || props.NAME || '').trim();
    if (fips && name) map.set(fips, name);
  }
  return map;
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += (x1 * y2) - (x2 * y1);
  }
  return area / 2;
}

function centroidOfRing(ring) {
  let cx = 0;
  let cy = 0;
  let area2 = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = (x1 * y2) - (x2 * y1);
    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (area2 === 0) return null;
  return [cx / (3 * area2), cy / (3 * area2)];
}

function bboxCenter(coords) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of coords) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function featureCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates?.[0];
    if (!ring || ring.length < 4) return bboxCenter(geometry.coordinates || []);
    return centroidOfRing(ring) || bboxCenter(geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates || [];
    let best = null;
    let bestArea = -1;
    for (const poly of polys) {
      const ring = poly?.[0];
      if (!ring || ring.length < 4) continue;
      const area = Math.abs(ringArea(ring));
      if (area > bestArea) {
        bestArea = area;
        best = poly;
      }
    }
    if (best) return centroidOfRing(best[0]) || bboxCenter(best);
  }
  return null;
}

function buildCentroidFeature(feature) {
  const center = featureCentroid(feature.geometry);
  if (!center) return null;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: center },
    properties: { ...feature.properties }
  };
}

function pickFirst(props, keys) {
  for (const key of keys) {
    if (props[key] === undefined || props[key] === null) continue;
    const value = String(props[key]).trim();
    if (value) return value;
  }
  return '';
}

function normalizeFeature(feature, countyNameByFips) {
  const props = feature.properties || {};
  const countyFips = pickFirst(props, ['COUNTYFIPS', 'CountyFIPS', 'countyfips']).padStart(3, '0');
  const countyName = countyNameByFips.get(countyFips) || countyFips;
  const longName = pickFirst(props, ['Precinct_Long_Name', 'PRECINCT_LONG_NAME', 'precinct_long_name']);
  const shortName = pickFirst(props, ['Precinct_Short_Name', 'PRECINCT_SHORT_NAME', 'precinct_short_name']);
  const jurisdiction = pickFirst(props, ['Jurisdiction_Name', 'JURISDICTION_NAME', 'jurisdiction_name', 'Jurisdiction']);
  const ward = pickFirst(props, ['WARD', 'Ward', 'ward']);
  const precinct = pickFirst(props, ['PRECINCT', 'Precinct', 'precinct']);
  const vtdst = pickFirst(props, ['VTDST', 'VTDST20', 'VTDST00']);
  const precinctId = longName || shortName || precinct || vtdst || pickFirst(props, ['PRECINCTID', 'PrecinctID']);

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      ...props,
      county_nam: countyName,
      county_fips: countyFips,
      jurisdiction_name: jurisdiction,
      precinct_short_name: shortName,
      precinct_long_name: longName,
      ward,
      precinct,
      vtdst,
      prec_id: precinctId
    }
  };
}

async function main() {
  const countyNameByFips = buildCountyNameByFips();
  const countJson = await fetchJson(`${serviceUrl}/query?where=1%3D1&returnCountOnly=true&f=pjson`);
  const total = Number(countJson.count || 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Official Michigan precinct service returned no features');
  }

  const pageSize = 1000;
  const merged = [];

  for (let offset = 0; offset < total; offset += pageSize) {
    const queryUrl = `${serviceUrl}/query?where=1%3D1&outFields=*&returnGeometry=true&orderByFields=OBJECTID&outSR=4326&resultOffset=${offset}&resultRecordCount=${pageSize}&f=geojson`;
    const page = await fetchJson(queryUrl);
    for (const feature of page.features || []) {
      merged.push(normalizeFeature(feature, countyNameByFips));
    }
    await sleep(250);
  }

  const precinctGeojson = {
    type: 'FeatureCollection',
    features: merged
  };
  const centroidGeojson = {
    type: 'FeatureCollection',
    features: merged.map(buildCentroidFeature).filter(Boolean)
  };

  fs.writeFileSync(precinctGeojsonPath, `${JSON.stringify(precinctGeojson, null, 2)}\n`, 'utf8');
  fs.writeFileSync(centroidGeojsonPath, `${JSON.stringify(centroidGeojson, null, 2)}\n`, 'utf8');

  console.log(`Downloaded ${merged.length} official precinct features`);
  console.log(`Wrote ${precinctGeojsonPath}`);
  console.log(`Wrote ${centroidGeojsonPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
