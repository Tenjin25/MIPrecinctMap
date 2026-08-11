import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootUrl = 'https://www2.census.gov/geo/tiger/TIGER2008/26_MICHIGAN/';
const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const downloadDir = path.join(dataDir, 'tiger2008_vtd', 'zips');
const tempDir = path.join(dataDir, 'tiger2008_vtd', 'tmp');
const precinctGeojsonPath = path.join(dataDir, 'Voting_Precincts.geojson');
const centroidGeojsonPath = path.join(dataDir, 'precinct_centroids.geojson');

fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

function runMapshaper(inputPath, outputPath) {
  const result = spawnSync(
    'cmd.exe',
    ['/c', 'npx.cmd', '--yes', 'mapshaper', inputPath, '-o', 'format=geojson', outputPath],
    { cwd: rootDir, stdio: 'inherit', shell: false }
  );
  if (result.status !== 0) {
    throw new Error(`mapshaper failed for ${path.basename(inputPath)}`);
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Codex/MI-Precinct-Map' }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

async function downloadFile(url, outPath) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Codex/MI-Precinct-Map' }
    });
    if (res.ok) {
      const file = fs.createWriteStream(outPath);
      await new Promise((resolve, reject) => {
        res.body.pipeTo(new WritableStream({
          write(chunk) {
            return new Promise((resWrite, rejWrite) => {
              file.write(Buffer.from(chunk), (err) => err ? rejWrite(err) : resWrite());
            });
          },
          close() {
            file.end(() => resolve());
          },
          abort(err) {
            file.destroy(err);
            reject(err);
          }
        })).catch(reject);
      });
      return;
    }
    lastErr = new Error(`Download failed ${res.status} for ${url}`);
    if (![403, 429, 500, 502, 503, 504].includes(res.status) || attempt === 4) {
      throw lastErr;
    }
    await sleep(1000 * attempt);
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function parseCountyEntries(indexHtml) {
  const matches = [...indexHtml.matchAll(/href="(\d{5}_[^"/]+_County\/)"/gi)];
  return unique(matches.map(m => m[1])).map(entry => {
    const countyFips = entry.slice(0, 5);
    const countyName = entry
      .slice(6, -8)
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      dirName: entry,
      countyFips,
      countyName
    };
  });
}

function pickPrecinctId(props) {
  const candidates = [
    'NAMELSAD00',
    'NAMELSAD',
    'NAME00',
    'NAME',
    'VTDST00',
    'VTDST',
    'VTD00',
    'GEOID00',
    'GEOID'
  ];
  for (const key of candidates) {
    const raw = props?.[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return '';
}

function normalizeFeature(feature, countyName) {
  const props = feature?.properties || {};
  const precId = pickPrecinctId(props);
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      ...props,
      county_nam: countyName,
      prec_id: precId
    }
  };
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
    if (best) {
      return centroidOfRing(best[0]) || bboxCenter(best);
    }
    return null;
  }
  return null;
}

function buildCentroidFeature(feature) {
  const center = featureCentroid(feature.geometry);
  if (!center) return null;
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: center
    },
    properties: { ...feature.properties }
  };
}

async function main() {
  const rootIndex = await fetchText(rootUrl);
  const counties = parseCountyEntries(rootIndex);
  if (!counties.length) {
    throw new Error('No Michigan county directories found in TIGER 2008 index');
  }

  const mergedFeatures = [];
  const skipped = [];

  for (const county of counties) {
    try {
      const countyUrl = `${rootUrl}${county.dirName}`;
      const countyIndex = await fetchText(countyUrl);
      const zipMatch = countyIndex.match(new RegExp(`href="(tl_2008_${county.countyFips}_vtd00\\.zip)"`, 'i'));
      if (!zipMatch) {
        console.warn(`Skipping ${county.countyName}: no tl_2008_${county.countyFips}_vtd00.zip link found`);
        skipped.push(`${county.countyFips} ${county.countyName} (no vtd00 zip link)`);
        continue;
      }

      const zipName = zipMatch[1];
      const zipUrl = `${countyUrl}${zipName}`;
      const zipPath = path.join(downloadDir, zipName);
      const tempGeojsonPath = path.join(tempDir, zipName.replace(/\.zip$/i, '.geojson'));

      if (!fs.existsSync(zipPath)) {
        console.log(`Downloading ${zipName}`);
        await downloadFile(zipUrl, zipPath);
        await sleep(250);
      }

      if (!fs.existsSync(tempGeojsonPath)) {
        console.log(`Converting ${zipName}`);
        runMapshaper(zipPath, tempGeojsonPath);
      }

      const geojson = JSON.parse(fs.readFileSync(tempGeojsonPath, 'utf8'));
      for (const feature of geojson.features || []) {
        mergedFeatures.push(normalizeFeature(feature, county.countyName));
      }
    } catch (err) {
      console.warn(`Skipping ${county.countyName}: ${err.message}`);
      skipped.push(`${county.countyFips} ${county.countyName} (${err.message})`);
    }
  }

  const precinctGeojson = {
    type: 'FeatureCollection',
    features: mergedFeatures
  };

  const centroidGeojson = {
    type: 'FeatureCollection',
    features: mergedFeatures.map(buildCentroidFeature).filter(Boolean)
  };

  fs.writeFileSync(precinctGeojsonPath, `${JSON.stringify(precinctGeojson, null, 2)}\n`, 'utf8');
  fs.writeFileSync(centroidGeojsonPath, `${JSON.stringify(centroidGeojson, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${mergedFeatures.length} precinct polygons to ${precinctGeojsonPath}`);
  console.log(`Wrote ${centroidGeojson.features.length} centroid points to ${centroidGeojsonPath}`);
  if (skipped.length) {
    console.warn(`Skipped ${skipped.length} counties`);
    skipped.forEach(msg => console.warn(`  - ${msg}`));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
