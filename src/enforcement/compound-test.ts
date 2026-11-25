import type { EnforcementViolation, HarnessConfig } from '../types.js';

// Each command lists the complete npm lifecycle we expect before a failed test.
// A direct npx run has no npm script header or command echo.
const scriptsByCommand = new Map<string, string[]>([
  ['npm run build && npm test', ['build', 'test']],
  ['npm test && npm run lint', ['test']],
  ['npx vitest run && npm run lint', []],
]);
const ADVICE = 'The combined command failed and its output contains a Vitest summary reporting a failure. ' +
  'Run the test step separately to confirm its own exit status.';

const TRUNCATION = [
  /[[(<][^\])>]{0,80}\b(?:truncated|omitted)\b[^\])>]{0,80}[\])>]/i,
  /(?:^|…|\.{3})[ \t]*(?:output[ \t]+|\+?[\d,]+[ \t]+(?:lines?|characters?|bytes?|tokens?)[ \t]+)?(?:truncated\b|omitted\b|\(ctrl\+o)/i,
  /\boutput[ \t]+truncated[ \t]+to[ \t]+[\d,]+[ \t]+bytes?\b/i,
  /<\/?persisted-output(?:>|[ \t])/i,
];

function boundedLines(output: string): string[] | null {
  if (output.length > 128 * 1024) return null;
  const maxLines = 2048;
  const lines = output.split(/\r?\n/, maxLines + 2);
  if (lines.at(-1) === '') lines.pop(); // A terminator doesn't add a physical line.
  if (lines.length > maxLines) return null;
  for (const [i, raw] of lines.entries()) {
    if (raw.length > 2048) return null;
    const line = raw.replace(/\x1b\[[\d;:]*m/g, '');
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(line) || TRUNCATION.some(marker => marker.test(line))) return null;
    lines[i] = line;
  }
  return lines;
}

const BANNER = /^>[ \t]+((?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+)[ \t]+(\S+)[ \t]*$/;

function testSection(lines: string[], scripts: string[]): string[] | null {
  let seen = 0;
  let start = 1;
  let pkg: string | undefined;
  for (let i = start; i < lines.length; i++) {
    if (!/^>(?:[ \t]|$)/.test(lines[i])) continue;
    const banner = lines[i].match(BANNER);
    if (!banner || banner[2] !== scripts[seen] || (pkg && pkg !== banner[1])) return null;
    const echo = lines[++i] ?? '';
    if (!/^>[ \t]+\S/.test(echo) || BANNER.test(echo)) return null;
    pkg = banner[1];
    seen++;
    start = i + 1;
  }
  return seen === scripts.length ? lines.slice(start) : null;
}

// Non-whitespace endpoints keep padding out of the capture on near-misses.
const COUNTS = /^[ \t]*(Test Files|Tests)[ \t]+(\S(?:.*\S)?)[ \t]+\((\d+)\)[ \t]*$/;
const COUNT = /^[ \t]*(\d+)[ \t]+(failed|passed|skipped|todo|expected fail)[ \t]*$/;
const ERRORS = /^[ \t]*Errors[ \t]+\d+[ \t]+errors?[ \t]*$/;

function failedCount(line: string, label: string): number | null {
  const row = line.match(COUNTS);
  if (row?.[1] !== label) return null;
  const labels = new Set<string>();
  let sum = 0;
  let failed = 0;
  for (const part of row[2].split('|')) {
    const field = part.match(COUNT);
    if (!field || labels.has(field[2])) return null;
    labels.add(field[2]);
    const count = Number(field[1]);
    sum += count;
    if (field[2] === 'failed') failed = count;
  }
  return Number.isSafeInteger(sum) && sum === Number(row[3]) ? failed : null;
}

function hasFailedSummary(lines: string[]): boolean {
  const markers: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^[ \t]*(?:RUN[ \t]+v|(?:Test Files|Tests|Errors)(?=[: \t]|$))/.test(line)) markers.push(i);
  }
  if (markers.length !== 3 && markers.length !== 4) return false;
  const [header, files, tests, errors] = markers;
  if (!/^[ \t]*RUN[ \t]+v\d+\.\d+\.\d+(?:[-+][\w.+-]+)?(?:[ \t]|$)/.test(lines[header])) return false;
  if (tests !== files + 1) return false;
  if (errors !== undefined && (errors !== tests + 1 || !ERRORS.test(lines[errors]))) return false;
  // Teardown can fail a file even when all its individual tests passed.
  return (failedCount(lines[files], 'Test Files') ?? 0) > 0 && failedCount(lines[tests], 'Tests') !== null;
}

export function checkCompoundTestFailure(
  command: string, output: string, config: HarnessConfig,
): EnforcementViolation | null {
  if (config.rules.zero_defect?.unrelated_errors === 'silent') return null;
  const literal = command.replace(/[ \t]+/g, ' ').replace(/ ?&& ?/g, ' && ').replace(/^ | $/g, '');
  const scripts = scriptsByCommand.get(literal);
  if (!scripts) return null;
  const lines = boundedLines(output);
  if (!lines || !/^Exit code \d*[1-9]\d*[ \t]*$/.test(lines[0] ?? '')) return null;
  const section = testSection(lines, scripts);
  if (!section || !hasFailedSummary(section)) return null;
  // A preceding step can replay these bytes. Only the combined status is known.
  return { level: 'advise', message: ADVICE };
}
