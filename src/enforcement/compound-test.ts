import type { EnforcementViolation, HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';
import { isRelatedToChangedFile } from './zero-defect.js';

// No shell parsing here. Only these literal tokens and horizontal whitespace
// are allowed. The end assertion also rejects a final newline.
const commandPatterns = [
  ['build-test', /^[ \t]*npm[ \t]+run[ \t]+build[ \t]*&&[ \t]*npm[ \t]+test[ \t]*(?![\s\S])/],
  ['test-lint', /^[ \t]*npm[ \t]+test[ \t]*&&[ \t]*npm[ \t]+run[ \t]+lint[ \t]*(?![\s\S])/],
  ['vitest-lint', /^[ \t]*npx[ \t]+vitest[ \t]+run[ \t]*&&[ \t]*npm[ \t]+run[ \t]+lint[ \t]*(?![\s\S])/],
] as const;
type CompoundCommand = (typeof commandPatterns)[number][0];

const ADVICE = 'The combined command failed and its output contains a Vitest summary reporting a failure. ' +
  'Run the test step separately to confirm its own exit status.';

// String lengths (whole output and raw line width) are measured in UTF-16 code units.
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
  const banners: Array<{ pkg: string; script: string; echo: string; index: number }> = [];
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
    banners.push({ pkg: banner[1], script, echo, index });
    index++; // The next line is the echo.
  }

  const [first, second] = banners;
  if (command === 'build-test') {
    return banners.length === 2 && first.script === 'build' && second.script === 'test' && first.pkg === second.pkg
      ? second.index + 2 : null;
  }
  if (command === 'vitest-lint' && banners.length === 0) return 1;
  if (banners.length !== 1 || first.script !== 'test') return null;
  if (command === 'vitest-lint' && !/^vitest[ \t]+run[ \t]*$/.test(first.echo)) return null;
  // In either test-first chain the npm banner must be the first output.
  if (lines.slice(1, first.index).some(line => /[^ \t]/.test(line))) return null;
  return first.index + 2;
}

const RUN = /^[ \t]*RUN[ \t]+v/;
const VITEST_HEADER = /^[ \t]*RUN[ \t]+v\d+\.\d+\.\d+(?:[-+][\w.+-]+)?(?:[ \t]|$)/;
const SUMMARY_ROW = /^[ \t]*(?:Test Files|Tests|Errors)(?=[: \t]|$)/;
// Non-whitespace endpoints keep padding out of the counts capture.
const COUNTS = /^[ \t]*(Test Files|Tests)[ \t]+(\S(?:.*\S)?)[ \t]+\((\d+)\)[ \t]*$/;
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

interface FailureReport {
  header: number;
  summary: number;
  failedFiles: number;
  failedTests: number;
}

function failureReport(lines: string[], start: number): FailureReport | null {
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
  // A suite hook can fail a file even when every individual test passed.
  if (failedFiles === null || failedFiles === 0 || failedTests === null) return null;
  if (rows.length === 3) {
    const row = lines[errors].match(ERRORS);
    if (errors !== tests + 1 || !row) return null;
    const count = Number(row[1]);
    if (!Number.isSafeInteger(count) || count < 1 || row[2] !== (count === 1 ? 'error' : 'errors')) return null;
  }
  return { header, summary: files, failedFiles, failedTests };
}

const FAILURE_DIVIDER = /^⎯+ Failed (Tests|Suites) ([1-9]\d*) ⎯+$/;
const TEST_DIAGNOSTIC = /^ FAIL {2}((?=\S*[./\\])[^\s>]+) > \S.*$/;
const SUITE_DIAGNOSTIC = /^ FAIL {2}((?=\S*[./\\])[^\s>]+) \[ \1 \]$/;

function relatedReporterFailure(lines: string[], report: FailureReport, changedFiles: string[]): boolean {
  const paths = new Set<string>();
  let section: string | undefined;
  let remaining = 0;
  for (let index = report.header + 1; index < report.summary; index++) {
    const line = lines[index];
    const divider = line.match(FAILURE_DIVIDER);
    if (divider) {
      // Vitest prints Suites, then Tests, each at most once. A second copy in
      // a log or error body makes the boundaries ambiguous.
      if (remaining !== 0 || section === 'Tests' || section === divider[1]) return false;
      section = divider[1];
      remaining = Number(divider[2]);
      if (section === 'Tests' && remaining !== report.failedTests) return false;
      if (lines[index + 1] !== '' || !lines[index + 2]?.startsWith(' FAIL  ')) return false;
    } else if (section && line.startsWith(' FAIL ')) {
      // Count every reporter-shaped row, including unfamiliar ones. Skipping
      // an unknown path shape could let a quote take its place in the count.
      const diagnostic = line.match(section === 'Tests' ? TEST_DIAGNOSTIC : SUITE_DIAGNOSTIC);
      if (!diagnostic || remaining === 0) return false;
      remaining--;
      paths.add(diagnostic[1]);
    } else if (section && /^(?:stdout|stderr)[ \t]*\|/.test(line.trimStart())) {
      return false;
    }
  }
  if (remaining !== 0 || (report.failedTests > 0 && section !== 'Tests') || paths.size !== report.failedFiles) return false;
  return [...paths].some(path => isRelatedToChangedFile(path, changedFiles));
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

  if (config.rules.zero_defect?.unrelated_errors === 'silent' &&
      !relatedReporterFailure(lines, report, cache.getChangedFiles())) return null;

  // A preceding step can replay these bytes, so no setting can turn this
  // evidence into a block or put transcript text in the advisory.
  return { level: 'advise', message: ADVICE };
}
