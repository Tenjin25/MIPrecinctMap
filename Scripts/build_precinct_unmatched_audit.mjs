import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'Data');
const contestsDir = path.join(dataDir, 'contests');
const aliasPath = path.join(dataDir, 'precinct_aliases.json');
const centroidPath = path.join(dataDir, 'precinct_centroids.geojson');
const outCsvPath = path.join(dataDir, 'precinct_unmatched_pre2018_audit.csv');

const canonicalFiles = [
  'president_2008.json',
  'governor_2010.json',
  'president_2012.json',
  'governor_2014.json',
  'president_2016.json',
  'governor_2018.json'
];

function normalizeToken(value) {
  return String(value || '')
    .replace(/[^a-z0-9 .\-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizePrecinctAliasToken(value) {
  let t = String(value || '').trim().toUpperCase();
  if (!t) return '';
  ['PRECINCT', 'PCT', 'WARD', 'DISTRICT', 'TOWNSHIP', 'BOX', 'VOTING', 'LOCATION'].forEach(word => {
    t = t.replace(new RegExp(word, 'g'), ' ');
  });
  t = t.replace(/[-_.]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function compactPrecinctAliasToken(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractPrecinctAliasCandidates(rawPrecinctValue) {
  const aliases = new Set();
  const p = String(rawPrecinctValue || '').trim().toUpperCase();
  if (!p) return aliases;
  const pn = normalizePrecinctAliasToken(p);

  aliases.add(p);
  const pCompact = compactPrecinctAliasToken(p);
  if (pCompact) aliases.add(pCompact);
  if (pn) {
    aliases.add(pn);
    const pnCompact = compactPrecinctAliasToken(pn);
    if (pnCompact) aliases.add(pnCompact);
  }

  const noHash = p.replace(/#\s*\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (noHash && noHash !== p) {
    aliases.add(noHash);
    const noHashCompact = compactPrecinctAliasToken(noHash);
    if (noHashCompact) aliases.add(noHashCompact);
    const noHashNorm = normalizePrecinctAliasToken(noHash);
    if (noHashNorm) {
      aliases.add(noHashNorm);
      const noHashNormCompact = compactPrecinctAliasToken(noHashNorm);
      if (noHashNormCompact) aliases.add(noHashNormCompact);
    }
  }

  if (p.includes('/')) {
    p.split('/').forEach(part => {
      const partTrim = String(part || '').trim().toUpperCase();
      if (!partTrim) return;
      aliases.add(partTrim);
      const partCompact = compactPrecinctAliasToken(partTrim);
      if (partCompact) aliases.add(partCompact);
    });
  }

  if (p.includes('_')) {
    const [left, ...restParts] = p.split('_');
    const right = restParts.join('_').trim();
    if (left && left.trim()) {
      aliases.add(left.trim().toUpperCase());
      const leftCompact = compactPrecinctAliasToken(left);
      if (leftCompact) aliases.add(leftCompact);
    }
    if (right) {
      aliases.add(right.toUpperCase());
      const rightCompact = compactPrecinctAliasToken(right);
      if (rightCompact) aliases.add(rightCompact);
    }
  }

  const parts = (pn || '').split(' ').filter(Boolean);
  if (parts.length) {
    const first = parts[0];
    if (/[0-9]/.test(first)) {
      aliases.add(first);
      const firstCompact = compactPrecinctAliasToken(first);
      if (firstCompact) aliases.add(firstCompact);
      const rest = parts.slice(1).join(' ').trim().toUpperCase();
      if (rest) {
        aliases.add(rest);
        const restCompact = compactPrecinctAliasToken(rest);
        if (restCompact) aliases.add(restCompact);
      }
    }
  }

  const dotVariant = p.replace(/-/g, '.');
  if (dotVariant.includes('.')) {
    const [aRaw, bRaw] = dotVariant.split('.', 2);
    if (/^\d+$/.test(aRaw || '') && /^\d+$/.test(bRaw || '')) {
      const a = Number(aRaw);
      const b = Number(bRaw);
      const z2 = n => String(n).padStart(2, '0');
      aliases.add(`${a}.${b}`);
      aliases.add(`${z2(a)}.${b}`);
      aliases.add(`${z2(a)}${b}`);
      aliases.add(`${z2(a)}${z2(b)}`);
    }
  }

  if (/^\d+$/.test(p)) {
    aliases.add(String(Number(p)));
    aliases.add(p.padStart(4, '0'));
  }

  return aliases;
}

function resolveUniquePrecinctCodeByAlias(countyAliases, rawPrecinctValue) {
  if (!countyAliases) return null;
  const candidates = Array.from(extractPrecinctAliasCandidates(rawPrecinctValue));
  if (!candidates.length) return null;

  for (const cand of candidates) {
    const alias = String(cand || '').trim().toUpperCase();
    if (!alias) continue;
    const codes = countyAliases.get(alias);
    if (codes && codes.length === 1) {
      return String(codes[0] || '').trim().toUpperCase() || null;
    }
  }

  const hits = new Set();
  candidates.forEach(cand => {
    const alias = String(cand || '').trim().toUpperCase();
    if (!alias) return;
    const codes = countyAliases.get(alias);
    if (!codes) return;
    codes.forEach(code => hits.add(String(code || '').trim().toUpperCase()));
  });
  if (hits.size === 1) return Array.from(hits)[0];
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
  ) return true;

  if (upper.includes('AVCB') || upper.includes(' ACB') || upper.includes(' CB')) return true;
  if (/\b(?:EV|AVCB|ACB|CB)\s*\d+\b/.test(upper)) return true;
  if (/,\s*CB\s*\d+\b/.test(upper)) return true;
  if (/\bPRECINCTS\b/.test(upper)) return true;
  return false;
}

function writeCsv(rows) {
  const header = ['county', 'county_norm', 'precinct_label', 'unmatched_rows', 'unmatched_vote_volume', 'years'];
  const lines = [header.join(',')];

  for (const row of rows) {
    const values = header.map(key => {
      const value = String(row[key] ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    });
    lines.push(values.join(','));
  }

  fs.writeFileSync(outCsvPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  if (!fs.existsSync(aliasPath)) throw new Error(`Missing alias file: ${aliasPath}`);
  if (!fs.existsSync(centroidPath)) throw new Error(`Missing centroid file: ${centroidPath}`);

  const aliasPayload = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
  const aliasByCounty = new Map();
  for (const [county, aliasObj] of Object.entries(aliasPayload.counties || {})) {
    const aliasMap = new Map();
    for (const [alias, codes] of Object.entries(aliasObj || {})) {
      aliasMap.set(String(alias || '').toUpperCase(), Array.isArray(codes) ? codes : []);
    }
    aliasByCounty.set(String(county || '').toUpperCase(), aliasMap);
  }

  const centroidGeo = JSON.parse(fs.readFileSync(centroidPath, 'utf8'));
  const centroidNormSet = new Set();
  for (const feature of centroidGeo.features || []) {
    const props = feature?.properties || {};
    const county = String(props.county_nam || props.COUNTYNAME || props.County || props.NAME || '').trim();
    const prec = String(props.prec_id || props.PREC_ID || '').trim();
    const key = normalizeToken(county && prec ? `${county} - ${prec}` : county);
    if (key) centroidNormSet.add(key);
  }

  const unmatchedByCountyPrec = new Map();
  let totalRows = 0;
  let matchedRows = 0;

  for (const file of canonicalFiles) {
    const filePath = path.join(contestsDir, file);
    if (!fs.existsSync(filePath)) continue;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = payload.rows || [];
    const year = Number((file.match(/_(\d{4})\.json$/) || [])[1] || 0);

    for (const row of rows) {
      const rowName = String(row.county || '');
      if (!rowName.includes(' - ')) continue;
      const [county, precinct] = rowName.split(' - ', 2);
      if (isNonGeographicPrecinctName(precinct)) continue;
      totalRows += 1;

      const countyNorm = normalizeToken(county);
      const directNorm = normalizeToken(`${county} - ${precinct}`);
      let matched = centroidNormSet.has(directNorm);
      if (!matched) {
        const countyAliases = aliasByCounty.get(countyNorm);
        const resolved = resolveUniquePrecinctCodeByAlias(countyAliases, precinct);
        if (resolved) {
          matched = centroidNormSet.has(normalizeToken(`${county} - ${resolved}`));
        }
      }
      if (matched) {
        matchedRows += 1;
        continue;
      }

      const key = `${countyNorm}|${String(precinct).toUpperCase()}`;
      if (!unmatchedByCountyPrec.has(key)) {
        unmatchedByCountyPrec.set(key, {
          county,
          county_norm: countyNorm,
          precinct_label: precinct,
          unmatched_rows: 0,
          unmatched_vote_volume: 0,
          years: new Set()
        });
      }
      const node = unmatchedByCountyPrec.get(key);
      node.unmatched_rows += 1;
      node.unmatched_vote_volume += Number(row.total_votes || 0);
      if (year) node.years.add(year);
    }
  }

  const outRows = Array.from(unmatchedByCountyPrec.values())
    .map(node => ({
      county: node.county,
      county_norm: node.county_norm,
      precinct_label: node.precinct_label,
      unmatched_rows: node.unmatched_rows,
      unmatched_vote_volume: Math.round(node.unmatched_vote_volume),
      years: Array.from(node.years).sort((a, b) => a - b).join('|')
    }))
    .sort((a, b) =>
      b.unmatched_vote_volume - a.unmatched_vote_volume ||
      b.unmatched_rows - a.unmatched_rows ||
      a.county.localeCompare(b.county) ||
      a.precinct_label.localeCompare(b.precinct_label)
    );

  writeCsv(outRows);

  const matchedPct = Number((totalRows > 0 ? (matchedRows / totalRows) * 100 : 0).toFixed(2));
  console.log(`Wrote ${outRows.length} rows to ${outCsvPath}`);
  console.log(`Pre-2018 geographic rows matched: ${matchedRows}/${totalRows} (${matchedPct}%)`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
