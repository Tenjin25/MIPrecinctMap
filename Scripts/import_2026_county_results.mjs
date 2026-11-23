import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('Data');
const sourcePath = path.join(dataDir, '2026STATE_GENERAL_MI_CENR_BY_COUNTY.txt');
const aggregatePath = path.join(dataDir, 'mi_elections_aggregated.json');
const manifestPath = path.join(dataDir, 'contests', 'manifest.json');
const officeTypes = new Map([
  ['GOVERNOR AND LIEUTENANT GOVERNOR', 'governor'],
  ['UNITED STATES SENATOR', 'us_senate'],
  ['SECRETARY OF STATE', 'secretary_of_state'],
  ['ATTORNEY GENERAL', 'attorney_general']
]);

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function countyName(value) {
  return String(value || '').trim().toLowerCase().replace(/\b\w/g, char => char.toUpperCase())
    .replace(/^St (Clair|Joseph)$/, 'St. $1');
}

function candidateName(row) {
  return [row.CandidateFirstName, row.CandidateMiddleName, row.CandidateLastName]
    .filter(Boolean).join(' ').trim().toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function finalize(row) {
  const { dem_votes, rep_votes, other_votes } = row;
  const total_votes = dem_votes + rep_votes + other_votes;
  return {
    ...row,
    total_votes,
    margin: Math.abs(rep_votes - dem_votes),
    margin_pct: total_votes ? Number((((rep_votes - dem_votes) / total_votes) * 100).toFixed(6)) : 0,
    winner: dem_votes > rep_votes ? 'DEM' : (rep_votes > dem_votes ? 'REP' : 'TIE'),
    color: ''
  };
}

const text = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);
const headerLine = lines.find(line => line.startsWith('ElectionDate\t'));
if (!headerLine) throw new Error('2026 county export header is missing');
const headers = headerLine.split('\t');
const contests = new Map([...officeTypes.values()].map(type => [type, new Map()]));
let recordCount = 0;
for (const line of lines) {
  if (!line.startsWith('2026-11-03\t')) continue;
  const fields = line.split('\t');
  if (fields.length !== headers.length) throw new Error(`Malformed row ${recordCount + 1}`);
  recordCount += 1;
  const row = Object.fromEntries(headers.map((key, i) => [key, fields[i]]));
  const type = [...officeTypes].find(([prefix]) => row.OfficeDescription.startsWith(prefix))?.[1];
  if (!type) continue;
  const county = countyName(row.CountyName);
  const votes = Number(row.CandidateVotes);
  if (!county || !Number.isSafeInteger(votes) || votes < 0) throw new Error(`Invalid county or votes in row ${recordCount}`);
  const byCounty = contests.get(type);
  if (!byCounty.has(county)) {
    byCounty.set(county, { dem_votes: 0, rep_votes: 0, other_votes: 0, total_votes: 0, dem_candidate: '', rep_candidate: '' });
  }
  const result = byCounty.get(county);
  const party = row.PartyDescription.toUpperCase();
  if (party === 'DEMOCRATIC') {
    result.dem_votes += votes;
    if (!result.dem_candidate) result.dem_candidate = candidateName(row);
  } else if (party === 'REPUBLICAN') {
    result.rep_votes += votes;
    if (!result.rep_candidate) result.rep_candidate = candidateName(row);
  } else {
    result.other_votes += votes;
  }
}
const declaredCount = Number(lines.find(line => /^RECORDS:\s*\d+/i.test(line))?.match(/\d+/)?.[0]);
if (!Number.isSafeInteger(declaredCount) || recordCount !== declaredCount ||
    [...contests.values()].some(byCounty => byCounty.size !== 83)) {
  throw new Error(`Unexpected 2026 export coverage: ${recordCount} records`);
}

const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
aggregate.results_by_year['2026'] = {};
manifest.files = manifest.files.filter(entry => Number(entry.year) !== 2026);
for (const [type, byCounty] of contests) {
  const rows = [...byCounty].map(([county, result]) => ({ county, ...finalize(result) }))
    .sort((a, b) => a.county.localeCompare(b.county));
  const file = `${type}_2026.json`;
  writeJson(path.join(dataDir, 'contests', file), {
    meta: { year: 2026, contest_type: type, rows: rows.length, level: 'county' }, rows
  });
  manifest.files.push({ year: 2026, contest_type: type, file, rows: rows.length, level: 'county' });
  aggregate.results_by_year['2026'][type] = {
    general: { results: Object.fromEntries(rows.map(({ county, ...result }) => [county, result])) }
  };
  console.log(`${type}: ${rows.length} counties`);
}
manifest.files.sort((a, b) => a.contest_type.localeCompare(b.contest_type) || Number(a.year) - Number(b.year));
aggregate.metadata.generated_at = new Date().toISOString();
aggregate.metadata.source = 'Michigan precinct CSV files through 2024; 2026 state county export';
writeJson(manifestPath, manifest);
writeJson(aggregatePath, aggregate);
