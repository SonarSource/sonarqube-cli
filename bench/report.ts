import { appendFileSync, writeFileSync } from 'node:fs';

export interface LoadRecord {
  backend: string;
  scale: number;
  durationMs: number | null;
  bytesOnDisk: number | null;
  timedOut: boolean;
}

export interface QueryRecord {
  backend: string;
  scale: number;
  query: string;
  medianMs: number | null;
  timedOut: boolean;
}

export interface MachineInfo {
  platform: string;
  arch: string;
  bunVersion: string;
  totalMemGiB: number;
}

const BYTES_PER_GIB = 1024 * 1024 * 1024;

function fmtScale(scale: number): string {
  return scale.toLocaleString('en-US');
}

function fmtMs(ms: number | null, timedOut: boolean): string {
  if (timedOut) return 'TIMEOUT';
  if (ms === null) return '-';
  return ms < 1000 ? `${ms.toFixed(2)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${(bytes / BYTES_PER_GIB).toFixed(2)} GiB`;
}

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerLine, separator, ...bodyLines].join('\n');
}

function buildLoadTable(loads: readonly LoadRecord[]): string {
  const rows = loads.map((l) => [
    l.backend,
    fmtScale(l.scale),
    fmtMs(l.durationMs, l.timedOut),
    fmtBytes(l.bytesOnDisk),
  ]);
  return toMarkdownTable(['backend', 'scale', 'load time', 'size on disk'], rows);
}

function buildQueryTable(queries: readonly QueryRecord[]): string {
  const rows = queries.map((q) => [
    q.backend,
    fmtScale(q.scale),
    q.query,
    fmtMs(q.medianMs, q.timedOut),
  ]);
  return toMarkdownTable(['backend', 'scale', 'query', 'median latency'], rows);
}

export function printConsoleReport(
  loads: readonly LoadRecord[],
  queries: readonly QueryRecord[],
): void {
  console.log('\n--- Load ---');
  console.table(loads.map((l) => ({ ...l, durationMs: fmtMs(l.durationMs, l.timedOut) })));
  console.log('\n--- Queries (median of repetitions) ---');
  console.table(queries.map((q) => ({ ...q, medianMs: fmtMs(q.medianMs, q.timedOut) })));
}

// Real-world sizing context: how many events would a single-machine ledger actually
// accumulate under plausible agent usage, so the 1M/10M/100M tiers read as more than
// arbitrary round numbers.
const WORKDAYS_PER_YEAR = 220;
const HOURS_PER_WORKDAY = 8;
const SECONDS_PER_HOUR = 3600;
const HOOK_INTERVAL_SECONDS = 6;

export function buildScaleContextSection(): string {
  const workingSecondsPerYear = WORKDAYS_PER_YEAR * HOURS_PER_WORKDAY * SECONDS_PER_HOUR;
  const eventsPerAgentPerYear = workingSecondsPerYear / HOOK_INTERVAL_SECONDS;
  const agentYearsFor10M = 10_000_000 / eventsPerAgentPerYear;
  const agentYearsFor100M = 100_000_000 / eventsPerAgentPerYear;
  const sustainedEventsPerSecondFor100M = 100_000_000 / workingSecondsPerYear;

  return [
    '## Scale in context',
    '',
    `Assumption: one agent works ${HOURS_PER_WORKDAY}h/day, ${WORKDAYS_PER_YEAR} workdays/year, ` +
      `and triggers a hook roughly every ${HOOK_INTERVAL_SECONDS}s while working ` +
      `(${workingSecondsPerYear.toLocaleString('en-US')} working seconds/year).`,
    '',
    `- **1M** ≈ ${eventsPerAgentPerYear.toLocaleString('en-US', { maximumFractionDigits: 0 })} events/agent/year ` +
      '→ **one agent, one full year** of normal working-hours usage.',
    `- **10M** ≈ ${agentYearsFor10M.toFixed(1)} agent-years → e.g. **5 agents working in parallel for 2 years**.`,
    `- **100M** ≈ ${agentYearsFor100M.toFixed(0)} agent-years — implausible for a single-machine ledger under ` +
      `normal human-triggered usage. Squeezed into one working-year it would need a sustained ` +
      `~${sustainedEventsPerSecondFor100M.toFixed(1)} events/second, every working second, all year — only ` +
      'reachable via a continuously-running script or synthetic seeding, which is exactly how this benchmark ' +
      'produces it. Included as an upper-bound stress test, not a realistic single-machine scenario.',
    '',
  ].join('\n');
}

export function writeResultsMarkdown(
  path: string,
  machine: MachineInfo,
  loads: readonly LoadRecord[],
  queries: readonly QueryRecord[],
  completedScales: readonly number[],
  stoppedEarly: boolean,
): void {
  const lines: string[] = [
    '# Storage backend benchmark results',
    '',
    '## Machine',
    '',
    `- Platform: ${machine.platform}/${machine.arch}`,
    `- Bun: ${machine.bunVersion}`,
    `- RAM: ${machine.totalMemGiB.toFixed(1)} GiB`,
    `- Completed scales: ${completedScales.map(fmtScale).join(', ')}`,
    stoppedEarly
      ? `- **Note**: the ${fmtScale(completedScales.at(-1)!)}-record stage exceeded ` +
        'the 10-minute per-stage budget. Any further requested scales beyond it were not run.'
      : '',
    '',
    buildScaleContextSection(),
    '## Load (write throughput + storage footprint)',
    '',
    buildLoadTable(loads),
    '',
    '## Query latency (median of repetitions, fresh handle per repetition)',
    '',
    buildQueryTable(queries),
    '',
  ];
  writeFileSync(path, lines.filter((l) => l !== '').join('\n') + '\n');
}

export function appendStageLog(path: string, message: string): void {
  appendFileSync(path, `${message}\n`);
}
