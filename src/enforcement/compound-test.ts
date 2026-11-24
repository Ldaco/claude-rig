import type { EnforcementViolation, HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';
import { classifyFailures } from './zero-defect.js';

// No shell parsing here. Only these literal tokens and horizontal whitespace
// are allowed. The end assertion also rejects a final newline.
const commandPatterns = [
  ['build-test', /^[ \t]*npm[ \t]+run[ \t]+build[ \t]*&&[ \t]*npm[ \t]+test[ \t]*(?![\s\S])/],
  ['test-lint', /^[ \t]*npm[ \t]+test[ \t]*&&[ \t]*npm[ \t]+run[ \t]+lint[ \t]*(?![\s\S])/],
  ['vitest-lint', /^[ \t]*npx[ \t]+vitest[ \t]+run[ \t]*&&[ \t]*npm[ \t]+run[ \t]+lint[ \t]*(?![\s\S])/],
] as const;
type CompoundCommand = (typeof commandPatterns)[number][0];

const ADVICE = 'The combined command failed and its output contains a Vitest summary reporting failed tests. ' +
  'Run the test step separately to confirm its own exit status.';

const MAX_OUTPUT = 128 * 1024;
const MAX_LINES = 2048;
const MAX_LINE = 2048;
const SGR = /\x1b\[[\d;:]*m/g;
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/;
const TRUNCATION_MARKERS = [
  /[[(<][^\])>]{0,80}\b(?:truncated|omitted)\b[^\])>]{0,80}[\])>]/i,
  /(?:^|…|\.{3})[ \t]*(?:output[ \t]+|\+?[\d,]+[ \t]+(?:lines?|characters?|bytes?|tokens?)[ \t]+)?(?:truncated\b|omitted\b|\(ctrl\+o)/i,
  /\boutput[ \t]+truncated[ \t]+to[ \t]+[\d,]+[ \t]+bytes?\b/i,
  /<\/?persisted-output(?:>|[ \t])/i,
];

function boundedLines(output: string): string[] | null {
  if (output.length > MAX_OUTPUT) return null;
  const lines = output.split('\n', MAX_LINES + 2);
  // A final line terminator does not add an empty physical line.
  if (lines.length > MAX_LINES + 1) return null;
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) return null;

  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') && (index < lines.length - 1 || output.endsWith('\n'))
      ? raw.slice(0, -1) : raw;
    if (line.length > MAX_LINE) return null;
    const plain = line.replace(SGR, '');
    if (CONTROL.test(plain) || TRUNCATION_MARKERS.some(marker => marker.test(plain))) return null;
    lines[index] = plain;
  }
  return lines;
}

const PACKAGE_BANNER = /^>[ \t]+((?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+)(?=[ \t]|$)/;

function testSectionStart(lines: string[], command: CompoundCommand): number | null {
  const banners: Array<{ pkg: string; script: string; echo: string; afterEcho: number }> = [];
  // Consume each lifecycle header and its command echo together. An unclaimed
  // "> " line (including npm's versionless "> lint") makes attribution unclear.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!/^>[ \t]+/.test(line)) continue;
    const banner = line.match(PACKAGE_BANNER);
    if (!banner) return null;
    const script = line.slice(banner[0].length).match(/^[ \t]+(\S+)[ \t]*$/)?.[1];
    const next = lines[index + 1] ?? '';
    const echo = next.match(/^>[ \t]+([^ \t].*)$/)?.[1];
    if (!script || !echo || PACKAGE_BANNER.test(next)) return null;
    banners.push({ pkg: banner[1], script, echo, afterEcho: index + 2 });
    index++; // The next line is the echo.
  }

  const [first, second] = banners;
  if (command === 'build-test') {
    return banners.length === 2 && first.script === 'build' && second.script === 'test' && first.pkg === second.pkg
      ? second.afterEcho : null;
  }
  if (command === 'vitest-lint' && banners.length === 0) return 1;
  if (banners.length !== 1 || first.script !== 'test') return null;
  if (command === 'vitest-lint') {
    if (!/^vitest[ \t]+run[ \t]*$/.test(first.echo)) return null;
    if (lines.slice(1, first.afterEcho).some(line => RUN.test(line) || SUMMARY_ROW.test(line))) return null;
  }
  return first.afterEcho;
}

const RUN = /^[ \t]*RUN[ \t]+v/;
const VITEST_HEADER = /^[ \t]*RUN[ \t]+v\d+\.\d+\.\d+(?:[-+][\w.+-]+)?(?:[ \t]|$)/;
const SUMMARY_ROW = /^[ \t]*(?:Test Files|Tests|Errors)(?=[: \t]|$)/;
const COUNTS = /^[ \t]*(Test Files|Tests)[ \t]+(.+?)[ \t]+\((\d+)\)[ \t]*$/;
const COUNT = /^[ \t]*(\d+)[ \t]+(failed|passed|skipped|todo|expected fail)[ \t]*$/;
const ERRORS = /^[ \t]*Errors[ \t]+(\d+)[ \t]+(errors?)[ \t]*$/;

function failedCount(line: string, label: string): number | null {
  const row = line.match(COUNTS);
  if (row?.[1] !== label) return null;
  const labels = new Set<string>();
  let sum = 0;
  let failed = 0;
  for (const part of row[2].split('|')) {
    const field = part.match(COUNT);
    if (!field || labels.has(field[2])) return null;
    const count = Number(field[1]);
    labels.add(field[2]);
    sum += count;
    if (field[2] === 'failed') failed = count;
  }
  return Number.isSafeInteger(sum) && sum === Number(row[3]) ? failed : null;
}

function failureReport(lines: string[], start: number): { header: number; summary: number } | null {
  const headers: number[] = [];
  const rows: number[] = [];
  for (let index = start; index < lines.length; index++) {
    if (RUN.test(lines[index])) headers.push(index);
    if (SUMMARY_ROW.test(lines[index])) rows.push(index);
  }
  const [header] = headers;
  const [files, tests, errors] = rows;
  if (headers.length !== 1 || !VITEST_HEADER.test(lines[header]) ||
      (rows.length !== 2 && rows.length !== 3) || files <= header || tests !== files + 1) return null;

  const failedFiles = failedCount(lines[files], 'Test Files');
  const failedTests = failedCount(lines[tests], 'Tests');
  if (failedFiles === null || failedTests === null || failedFiles + failedTests === 0) return null;
  if (rows.length === 3) {
    const row = lines[errors].match(ERRORS);
    if (errors !== tests + 1 || !row) return null;
    const count = Number(row[1]);
    if (!Number.isSafeInteger(count) || count < 1 || row[2] !== (count === 1 ? 'error' : 'errors')) return null;
  }
  return { header, summary: files };
}

export function checkCompoundTestFailure(
  command: string,
  output: string,
  cache: SessionCache,
  config: HarnessConfig,
  isInterrupt: unknown,
): EnforcementViolation | null {
  if (isInterrupt === true) return null;
  const kind = commandPatterns.find(([, pattern]) => pattern.test(command))?.[0];
  if (!kind) return null;
  const lines = boundedLines(output);
  if (!lines || !/^Exit code \d*[1-9]\d*[ \t]*$/.test(lines[0] ?? '')) return null;
  const start = testSectionStart(lines, kind);
  if (start === null) return null;
  const report = failureReport(lines, start);
  if (!report) return null;

  if (config.rules.zero_defect?.unrelated_errors === 'silent') {
    const named: string[] = [];
    for (let index = start; index < report.summary; index++) {
      const line = lines[index].trimStart();
      // Vitest prints captured text verbatim, including blank lines. There
      // is no reliable delimiter at which to resume trusting FAIL paths.
      if (/^(?:stdout|stderr)[ \t]*\|/.test(line)) break;
      if (index > report.header && /^FAIL[ \t]+(?=\S*[./\\])[^ \t>]+(?:[ \t]|$)/.test(line)) named.push(line);
    }
    const { regressions } = classifyFailures(named.join('\n'), cache.getChangedFiles());
    if (regressions.length === 0) return null;
  }

  // A preceding step can replay these bytes, so no setting can turn this
  // evidence into a block or put transcript text in the advisory.
  return { level: 'advise', message: ADVICE };
}
