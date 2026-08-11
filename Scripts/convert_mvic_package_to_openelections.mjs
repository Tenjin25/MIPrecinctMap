import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const [, , inputDirArg, outputFileArg] = process.argv;

if (!inputDirArg || !outputFileArg) {
  console.error('Usage: node Scripts/convert_mvic_package_to_openelections.mjs <inputDir> <outputCsv>');
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), inputDirArg);
const outputFile = path.resolve(process.cwd(), outputFileArg);

function ensureInputDir(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) return targetPath;
  if (!stat.isFile() || path.extname(targetPath).toLowerCase() !== '.zip') {
    throw new Error(`Unsupported input: ${targetPath}`);
  }
  const extractRoot = path.join(path.dirname(targetPath), '.mvic_extract');
  const extractDir = path.join(extractRoot, path.basename(targetPath, '.zip'));
  fs.mkdirSync(extractDir, { recursive: true });
  const ps = [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${targetPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
  ];
  let result = spawnSync('powershell.exe', ps, { stdio: 'pipe', encoding: 'utf8' });
  if (result.error) {
    result = spawnSync('powershell', ps, { stdio: 'pipe', encoding: 'utf8' });
  }
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${targetPath}: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  }
  return extractDir;
}

const inputDir = ensureInputDir(inputPath);

function resolveMvicFile(kind) {
  if (kind === 'county' || kind === 'readme') {
    const file = path.join(inputDir, `${kind}.txt`);
    if (fs.existsSync(file)) return file;
  }
  const matches = fs.readdirSync(inputDir)
    .filter(name => new RegExp(`^\\d{4}${kind}\\.txt$`, 'i').test(name))
    .sort();
  if (matches.length) return path.join(inputDir, matches[0]);
  throw new Error(`Could not find ${kind} file in ${inputDir}`);
}

const countyFile = resolveMvicFile('county');
const cityFile = resolveMvicFile('city');
const officeFile = resolveMvicFile('offc');
const nameFile = resolveMvicFile('name');
const voteFile = resolveMvicFile('vote');

function key(...parts) {
  return parts.map(v => String(v ?? '').trim()).join('|');
}

function canonicalCountyName(name) {
  const raw = String(name || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  if (/^GD\.?\s+TRAVERSE$/i.test(raw)) return 'Grand Traverse';
  if (/^ST\.?\s+CLAIR$/i.test(raw)) return 'St. Clair';
  if (/^ST\.?\s+JOSEPH'?S?$/i.test(raw)) return 'St. Joseph';
  if (/^SHIAWASSE$/i.test(raw)) return 'Shiawassee';
  return raw
    .toLowerCase()
    .replace(/\b\w/g, m => m.toUpperCase())
    .replace(/\bOf\b/g, 'of')
    .replace(/\bUs\b/g, 'US')
    .replace(/\bU S\b/g, 'U.S.');
}

function normalizeOffice(officeCode, officeDesc, districtCode) {
  const code = String(officeCode || '').trim();
  const desc = String(officeDesc || '').trim().replace(/\s+/g, ' ');
  switch (code) {
    case '1': return 'President';
    case '2': return 'Governor';
    case '3': return 'Secretary of State';
    case '4': return 'Attorney General';
    case '5': return 'U.S. Senate';
    case '6': return 'U.S. House';
    case '7': return 'State Senate';
    case '8': return 'State House';
    case '9': return 'State Board of Education';
    case '10': return 'University of Michigan Board of Regents';
    case '11': return 'Michigan State University Board of Trustees';
    case '12': return 'Wayne State University Board of Governors';
    case '13': return desc || 'Supreme Court';
    case '14': return desc || 'Court of Appeals';
    case '15': return desc || 'Circuit Court';
    case '16': return desc || 'Probate Court';
    case '17': return desc || 'Probate District Court';
    case '18': return desc || 'District Court';
    case '19': return desc || 'Municipal Court';
    case '90': return desc || `Ballot Proposal ${districtCode || ''}`.trim();
    default: return desc || `Office ${code}`;
  }
}

function normalizeDistrict(officeCode, districtCode) {
  const raw = String(districtCode || '').trim();
  if (!raw || raw === '00000') return '';
  if (officeCode === '6' || officeCode === '7' || officeCode === '8') {
    return raw.replace(/^0+/, '').replace(/0+$/, '') || '0';
  }
  return raw;
}

function normalizeParty(party) {
  const raw = String(party || '').trim();
  if (!raw) return '';
  if (raw === 'NP') return 'NPA';
  return raw;
}

function normalizePlaceName(rawPlace) {
  const value = String(rawPlace || '').trim().replace(/\s+/g, ' ');
  if (!value || value.startsWith('{')) return '';
  let text = value;
  if (/^VILLAGE OF /i.test(text) && / CITY$/i.test(text)) {
    text = text.replace(/ CITY$/i, '');
  } else if (/ CITY$/i.test(text)) {
    text = `CITY OF ${text.replace(/ CITY$/i, '')}`;
  }
  if (/ TOWNSHIP$/i.test(text)) {
    return text
      .toLowerCase()
      .replace(/\b\w/g, m => m.toUpperCase())
      .replace(/\bOf\b/g, 'of');
  }
  return text
    .toLowerCase()
    .replace(/\b\w/g, m => m.toUpperCase())
    .replace(/\bOf\b/g, 'of');
}

function buildPrecinctName(placeName, wardRaw, precinctRaw, labelRaw) {
  const place = normalizePlaceName(placeName);
  if (!place) return '';
  const wardNum = Number(String(wardRaw || '').trim() || 0);
  const precinctNumRaw = String(precinctRaw || '').trim();
  const precinctNum = precinctNumRaw ? String(Number(precinctNumRaw)) : '';
  const label = String(labelRaw || '').trim();

  if (label) {
    if (wardNum > 0 && precinctNum) return `${place}, Ward ${wardNum}, ${label} ${precinctNum}`.replace(/\s+/g, ' ').trim();
    if (precinctNum) return `${place}, ${label} ${precinctNum}`.replace(/\s+/g, ' ').trim();
    return `${place}, ${label}`.replace(/\s+/g, ' ').trim();
  }

  if (wardNum > 0 && precinctNum) return `${place}, Ward ${wardNum}, Precinct ${precinctNum}`;
  if (precinctNum) return `${place}, Precinct ${precinctNum}`;
  return place;
}

function buildCandidateName(last, first, middle) {
  const parts = [String(first || '').trim(), String(middle || '').trim(), String(last || '').trim()].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function readTabFile(filePath, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    await onRow(line.split('\t'));
  }
}

const counties = new Map();
const cities = new Map();
const offices = new Map();
const names = new Map();

await readTabFile(countyFile, async ([countyCode, countyName]) => {
  counties.set(String(countyCode).trim(), canonicalCountyName(countyName));
});

await readTabFile(cityFile, async ([year, electionType, countyCode, cityTownCode, cityTownDesc]) => {
  cities.set(key(year, electionType, countyCode, cityTownCode), cityTownDesc);
});

await readTabFile(officeFile, async ([year, electionType, officeCode, districtCode, statusCode, officeDesc]) => {
  offices.set(key(year, electionType, officeCode, districtCode, statusCode), officeDesc);
});

await readTabFile(nameFile, async ([year, electionType, officeCode, districtCode, statusCode, candidateId, last, first, middle, party]) => {
  names.set(
    key(year, electionType, officeCode, districtCode, statusCode, candidateId),
    {
      candidate: buildCandidateName(last, first, middle),
      party: normalizeParty(party)
    }
  );
});

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
const out = fs.createWriteStream(outputFile, { encoding: 'utf8' });
out.write('county,precinct,office,district,candidate,party,votes,election_day,absentee\n');

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

await readTabFile(voteFile, async (fields) => {
  const [
    year,
    electionType,
    officeCode,
    districtCode,
    statusCode,
    candidateId,
    countyCode,
    cityTownCode,
    wardNumber,
    precinctNumber,
    precinctLabel,
    voteTotal
  ] = fields;

  if (String(officeCode).trim() === '0') return;
  if (String(candidateId).trim() === '0') return;

  const county = counties.get(String(countyCode).trim()) || String(countyCode).trim();
  const cityDesc = cities.get(key(year, electionType, countyCode, cityTownCode)) || '';
  const officeDesc = offices.get(key(year, electionType, officeCode, districtCode, statusCode)) || '';
  const candidateInfo = names.get(key(year, electionType, officeCode, districtCode, statusCode, candidateId));
  if (!candidateInfo) return;

  const precinct = buildPrecinctName(cityDesc, wardNumber, precinctNumber, precinctLabel);
  if (!precinct) return;

  const office = normalizeOffice(String(officeCode).trim(), officeDesc, String(districtCode).trim());
  const district = normalizeDistrict(String(officeCode).trim(), String(districtCode).trim());
  const votes = String(Number(String(voteTotal || '0').trim() || 0));

  const row = [
    county,
    precinct,
    office,
    district,
    candidateInfo.candidate,
    candidateInfo.party,
    votes,
    '',
    ''
  ].map(csvEscape).join(',');

  out.write(`${row}\n`);
});

await new Promise(resolve => out.end(resolve));
console.log(`Wrote ${path.relative(process.cwd(), outputFile)}`);
