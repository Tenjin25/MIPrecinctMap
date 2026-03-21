import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const centroidGeojsonPath = path.join(dataDir, 'precinct_centroids.geojson');
const aliasOutputPath = path.join(dataDir, 'precinct_aliases.json');

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

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function canonicalCountyName(rawCounty) {
  const county = String(rawCounty || '').replace(/\s+/g, ' ').trim();
  if (!county) return '';
  if (/^Gd\.?\s+Traverse$/i.test(county)) return 'Grand Traverse';
  if (/^Shiawasse$/i.test(county)) return 'Shiawassee';
  if (/^St\.?\s*Joseph'?s$/i.test(county)) return 'St. Joseph';
  return county;
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
    .replace(/[\u2019']/g, '')
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

  const cityOfMatch = base.match(/^(CITY|VILLAGE|TOWNSHIP) OF (.+?) PRECINCT ([A-Z0-9]+)$/);
  if (cityOfMatch) {
    push(`${cityOfMatch[2]} ${cityOfMatch[1]} PRECINCT ${cityOfMatch[3]}`);
    push(`${cityOfMatch[2]} ${cityOfMatch[1]} ${cityOfMatch[3]}`);
    push(`${cityOfMatch[2]} PRECINCT ${cityOfMatch[3]}`);
  }

  const cityOfWardPrecinctMatch = base.match(/^(CITY|VILLAGE|TOWNSHIP) OF (.+?) WARD (\d+) PRECINCT ([A-Z0-9]+)$/);
  if (cityOfWardPrecinctMatch) {
    push(`${cityOfWardPrecinctMatch[2]} ${cityOfWardPrecinctMatch[1]} WARD ${cityOfWardPrecinctMatch[3]} PRECINCT ${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} ${cityOfWardPrecinctMatch[1]} ${cityOfWardPrecinctMatch[4]} WARD ${cityOfWardPrecinctMatch[3]}`);
    push(`${cityOfWardPrecinctMatch[2]} ${cityOfWardPrecinctMatch[4]} WARD ${cityOfWardPrecinctMatch[3]}`);
    push(`${cityOfWardPrecinctMatch[2]} WARD ${cityOfWardPrecinctMatch[3]} ${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} WARD ${cityOfWardPrecinctMatch[3]} PRECINCT ${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} PRECINCT ${cityOfWardPrecinctMatch[4]} WARD ${cityOfWardPrecinctMatch[3]}`);
    push(`${cityOfWardPrecinctMatch[2]} WARD${cityOfWardPrecinctMatch[3]} PRECINCT ${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} ${cityOfWardPrecinctMatch[4]} WARD${cityOfWardPrecinctMatch[3]}`);
    push(`${cityOfWardPrecinctMatch[2]} ${cityOfWardPrecinctMatch[3]}-${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} DISTRICT ${cityOfWardPrecinctMatch[3]} PRECINCT ${cityOfWardPrecinctMatch[4]}`);
    push(`${cityOfWardPrecinctMatch[2]} PRECINCT ${cityOfWardPrecinctMatch[4]}`);
  }

  const suffixTypeMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) PRECINCT ([A-Z0-9]+)$/);
  if (suffixTypeMatch) {
    push(`${suffixTypeMatch[2]} OF ${suffixTypeMatch[1]} PRECINCT ${suffixTypeMatch[3]}`);
    push(`${suffixTypeMatch[1]} ${suffixTypeMatch[2]} ${suffixTypeMatch[3]}`);
    push(`${suffixTypeMatch[1]} PRECINCT ${suffixTypeMatch[3]}`);
  }

  const numberedTypeMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) ([A-Z0-9]+)$/);
  if (numberedTypeMatch) {
    push(`${numberedTypeMatch[1]} ${numberedTypeMatch[2]} PRECINCT ${numberedTypeMatch[3]}`);
    push(`${numberedTypeMatch[2]} OF ${numberedTypeMatch[1]} PRECINCT ${numberedTypeMatch[3]}`);
    push(`${numberedTypeMatch[1]} PRECINCT ${numberedTypeMatch[3]}`);
    push(`${numberedTypeMatch[1]} ${numberedTypeMatch[3]}`);
  }

  const numberedTypeWardMatch = base.match(/^(.+?) (CITY|VILLAGE|TOWNSHIP) ([A-Z0-9]+) WARD (\d+)$/);
  if (numberedTypeWardMatch) {
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[2]} PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
    push(`${numberedTypeWardMatch[2]} OF ${numberedTypeWardMatch[1]} PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[2]} WARD ${numberedTypeWardMatch[4]} PRECINCT ${numberedTypeWardMatch[3]}`);
    push(`${numberedTypeWardMatch[2]} OF ${numberedTypeWardMatch[1]} WARD ${numberedTypeWardMatch[4]} PRECINCT ${numberedTypeWardMatch[3]}`);
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
    push(`${numberedTypeWardMatch[1]} WARD ${numberedTypeWardMatch[4]} ${numberedTypeWardMatch[3]}`);
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[3]} WARD${numberedTypeWardMatch[4]}`);
    push(`${numberedTypeWardMatch[1]} ${numberedTypeWardMatch[4]}-${numberedTypeWardMatch[3]}`);
    push(`${numberedTypeWardMatch[1]} DISTRICT ${numberedTypeWardMatch[4]} PRECINCT ${numberedTypeWardMatch[3]}`);
    push(`WARD ${numberedTypeWardMatch[4]} PRECINCT ${numberedTypeWardMatch[3]}`);
    push(`PRECINCT ${numberedTypeWardMatch[3]} WARD ${numberedTypeWardMatch[4]}`);
  }

  const townshipOfMatch = base.match(/^TOWNSHIP OF (.+)$/);
  if (townshipOfMatch) {
    push(`${townshipOfMatch[1]} TOWNSHIP`);
  }

  const wardLeadingMatch = base.match(/^WARD (\d+) PRECINCT ([A-Z0-9]+)$/);
  if (wardLeadingMatch) {
    push(`${wardLeadingMatch[1]}-${wardLeadingMatch[2]}`);
    push(`PRECINCT ${wardLeadingMatch[2]} WARD ${wardLeadingMatch[1]}`);
  }

  const wardTrailingMatch = base.match(/^PRECINCT ([A-Z0-9]+) WARD (\d+)$/);
  if (wardTrailingMatch) {
    push(`WARD ${wardTrailingMatch[2]} PRECINCT ${wardTrailingMatch[1]}`);
    push(`${wardTrailingMatch[2]}-${wardTrailingMatch[1]}`);
  }

  return aliases;
}

function expandIndexAlias(rawAlias) {
  const aliases = new Set();
  const upper = (rawAlias || '').toString().trim().toUpperCase();
  if (!upper) return aliases;
  aliases.add(upper);

  const wardJoined = upper
    .replace(/\bWARD\s+(\d+)\b/g, 'WARD$1')
    .replace(/\bPRECINCT\s+(\d+)\b/g, 'PRECINCT$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (wardJoined && wardJoined !== upper) aliases.add(wardJoined);

  const wardSpaced = upper
    .replace(/\bWARD(\d+)\b/g, 'WARD $1')
    .replace(/\bPRECINCT(\d+)\b/g, 'PRECINCT $1')
    .replace(/\s+/g, ' ')
    .trim();
  if (wardSpaced && wardSpaced !== upper) aliases.add(wardSpaced);

  if (upper.includes('GUN PLAIN')) aliases.add(upper.replace(/\bGUN PLAIN\b/g, 'GUNPLAIN'));
  if (upper.includes('GUNPLAIN')) aliases.add(upper.replace(/\bGUNPLAIN\b/g, 'GUN PLAIN'));

  return aliases;
}

function firstNonEmpty(...values) {
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (value) return value;
  }
  return '';
}

function addAliasMapping(aliasLookupByCounty, countyKey, aliasRaw, codeRaw) {
  const county = String(countyKey || '').trim().toUpperCase();
  const alias = String(aliasRaw || '').trim().toUpperCase();
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!county || !alias || !code) return;

  if (!aliasLookupByCounty.has(county)) aliasLookupByCounty.set(county, new Map());
  const aliasMap = aliasLookupByCounty.get(county);
  if (!aliasMap.has(alias)) aliasMap.set(alias, new Set());
  aliasMap.get(alias).add(code);
}

function toSortedObject(aliasLookupByCounty) {
  const countiesOut = {};
  let aliasCount = 0;
  let uniqueAliasCount = 0;

  for (const county of Array.from(aliasLookupByCounty.keys()).sort()) {
    const aliasMap = aliasLookupByCounty.get(county);
    const aliasOut = {};
    for (const alias of Array.from(aliasMap.keys()).sort()) {
      const codes = Array.from(aliasMap.get(alias)).filter(Boolean).sort();
      if (!codes.length) continue;
      aliasOut[alias] = codes;
      aliasCount += 1;
      if (codes.length === 1) uniqueAliasCount += 1;
    }
    if (Object.keys(aliasOut).length) {
      countiesOut[county] = aliasOut;
    }
  }

  return {
    countiesOut,
    stats: {
      counties: Object.keys(countiesOut).length,
      aliases: aliasCount,
      unique_aliases: uniqueAliasCount,
      ambiguous_aliases: aliasCount - uniqueAliasCount
    }
  };
}

function main() {
  if (!fileExists(centroidGeojsonPath)) {
    throw new Error(`Missing centroid file: ${centroidGeojsonPath}`);
  }

  const geojson = readJson(centroidGeojsonPath);
  const aliasLookupByCounty = new Map();
  let featureCount = 0;

  for (const feature of geojson.features || []) {
    const props = feature?.properties || {};
    const countyKey = normalizeCountyLookup(
      props.county_nam ||
      props.County_Name ||
      props.Jurisdiction_Name ||
      props.jurisdiction_name ||
      props.COUNTYNAME ||
      props.County ||
      props.NAME ||
      ''
    );
    if (!countyKey) continue;
    featureCount += 1;

    const canonicalCode = firstNonEmpty(
      props.prec_id,
      props.precinct_long_name,
      props.Precinct_Long_Name,
      props.precinct_short_name,
      props.Precinct_Short_Name,
      props.PRECINCTID,
      props.NAME
    );
    if (!canonicalCode) continue;

    const rawNames = new Set([
      canonicalCode,
      firstNonEmpty(props.precinct_long_name),
      firstNonEmpty(props.Precinct_Long_Name),
      firstNonEmpty(props.precinct_short_name),
      firstNonEmpty(props.Precinct_Short_Name),
      firstNonEmpty(props.PRECINCTID),
      firstNonEmpty(props.NAME)
    ]);

    const ward = String(props.ward || props.WARD || '').trim();
    const precinctNum = String(props.precinct || props.PRECINCT || '').trim();
    if (ward && precinctNum) {
      rawNames.add(`WARD ${ward} PRECINCT ${precinctNum}`);
      rawNames.add(`${ward}-${precinctNum}`);
    }

    for (const rawName of rawNames) {
      if (!rawName) continue;

      for (const alias of buildPrecinctAliases(rawName, countyKey)) {
        for (const candidate of expandIndexAlias(alias)) {
          addAliasMapping(aliasLookupByCounty, countyKey, candidate, canonicalCode);
        }
      }
    }
  }

  const { countiesOut, stats } = toSortedObject(aliasLookupByCounty);
  writeJson(aliasOutputPath, {
    metadata: {
      generated_at: new Date().toISOString(),
      source: 'precinct_centroids.geojson',
      features_seen: featureCount,
      ...stats
    },
    counties: countiesOut
  });

  console.log(`Processed ${featureCount} centroid features`);
  console.log(`Wrote ${stats.counties} counties and ${stats.aliases} alias keys to ${aliasOutputPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
