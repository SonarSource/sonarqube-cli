import { mkdirSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

import { createLmdbBackend } from './backends/lmdb-backend.ts';
import { createNdjsonBackend } from './backends/ndjson-backend.ts';
import { createSqliteJson1Backend } from './backends/sqlite-json1-backend.ts';
import type { StatsBackend } from './backends/stats-backend.ts';
import { generateSyntheticEvents } from './gen/synthetic-generator.ts';
import type { LoadRecord, QueryRecord } from './report.ts';
import { buildScaleContextSection, printConsoleReport, writeResultsMarkdown } from './report.ts';

const SEED = 0xc0ffee;
const DEFAULT_SCALES = [1_000_000, 10_000_000, 100_000_000];
const MS_PER_MINUTE = 60_000;
const STAGE_BUDGET_MS = 10 * MS_PER_MINUTE;
const QUERY_TIMEOUT_MS = 90 * 1000;
const LOAD_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const REPETITIONS = 5;
// NDJSON's full-file-scan cost already shows a clean ~10x-per-decade trend at 1M/10M; running
// it again at 100M adds ~20 minutes for a result that trend already predicts. Skip it there and
// only stress-test the two indexed backends at the largest tier.
const NDJSON_MAX_SCALE = 30_000_000;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const SINCE_MS = Date.now() - WINDOW_DAYS * DAY_MS;
const TOP_RULES_MIN_COUNT = 50;
const TOP_RULES_LIMIT = 5;

const BENCH_DIR = new URL('.', import.meta.url).pathname;
const DATA_DIR = join(BENCH_DIR, 'data');
const RESULTS_PATH = join(BENCH_DIR, 'RESULTS.md');

mkdirSync(DATA_DIR, { recursive: true });

interface BackendFactory {
  name: string;
  create: (scale: number) => StatsBackend;
}

const BACKEND_FACTORIES: BackendFactory[] = [
  {
    name: 'sqlite-json1',
    create: (scale) => createSqliteJson1Backend(join(DATA_DIR, `sqlite-${scale}.db`)),
  },
  { name: 'lmdb', create: (scale) => createLmdbBackend(join(DATA_DIR, `lmdb-${scale}`), scale) },
  {
    name: 'ndjson',
    create: (scale) => createNdjsonBackend(join(DATA_DIR, `events-${scale}.ndjson`)),
  },
];

interface QueryCase {
  name: string;
  run: (backend: StatsBackend) => Promise<unknown>;
}

const QUERIES: QueryCase[] = [
  { name: 'totals(30d)', run: (b) => b.totals(SINCE_MS) },
  { name: 'analyzerBreakdown(30d)', run: (b) => b.analyzerBreakdown(SINCE_MS) },
  { name: 'topRules(30d)', run: (b) => b.topRules(SINCE_MS, TOP_RULES_MIN_COUNT, TOP_RULES_LIMIT) },
  { name: 'allTimeTotals()', run: (b) => b.allTimeTotals() },
];

const TIMEOUT_SENTINEL = Symbol('timeout');

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT_SENTINEL> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function benchLoad(factory: BackendFactory, scale: number): Promise<LoadRecord> {
  const backend = factory.create(scale);
  console.log(`  loading ${factory.name} @ ${scale.toLocaleString('en-US')} records...`);
  const outcome = await withTimeout(
    backend.load(generateSyntheticEvents(scale, SEED)),
    LOAD_TIMEOUT_MS,
  );
  backend.close();
  if (outcome === TIMEOUT_SENTINEL) {
    return { backend: factory.name, scale, durationMs: null, bytesOnDisk: null, timedOut: true };
  }
  return {
    backend: factory.name,
    scale,
    durationMs: outcome.durationMs,
    bytesOnDisk: outcome.bytesOnDisk,
    timedOut: false,
  };
}

async function benchQuery(
  factory: BackendFactory,
  scale: number,
  query: QueryCase,
): Promise<QueryRecord> {
  const samples: number[] = [];
  let timedOut = false;
  for (let i = 0; i < REPETITIONS; i++) {
    const backend = factory.create(scale);
    const start = performance.now();
    const outcome = await withTimeout(query.run(backend), QUERY_TIMEOUT_MS);
    backend.close();
    if (outcome === TIMEOUT_SENTINEL) {
      timedOut = true;
      break;
    }
    samples.push(performance.now() - start);
  }
  return {
    backend: factory.name,
    scale,
    query: query.name,
    medianMs: samples.length > 0 ? median(samples) : null,
    timedOut,
  };
}

async function runStage(scale: number): Promise<{ loads: LoadRecord[]; queries: QueryRecord[] }> {
  const loads: LoadRecord[] = [];
  const queries: QueryRecord[] = [];

  const factories =
    scale > NDJSON_MAX_SCALE
      ? BACKEND_FACTORIES.filter((f) => f.name !== 'ndjson')
      : BACKEND_FACTORIES;
  if (factories.length < BACKEND_FACTORIES.length) {
    console.log(
      `  skipping ndjson at scale ${scale.toLocaleString('en-US')} (already-established trend)`,
    );
  }

  for (const factory of factories) {
    const load = await benchLoad(factory, scale);
    loads.push(load);
    if (load.timedOut) {
      console.warn(`  ${factory.name} load timed out at scale ${scale} — skipping its queries.`);
      continue;
    }
    for (const query of QUERIES) {
      console.log(`    ${factory.name} :: ${query.name}`);
      queries.push(await benchQuery(factory, scale, query));
    }
  }

  return { loads, queries };
}

function parseScalesArg(): number[] {
  const inlineArg = process.argv.find((a) => a.startsWith('--scales='));
  if (!inlineArg) return DEFAULT_SCALES;
  return inlineArg
    .slice('--scales='.length)
    .split(',')
    .map((s) => Number(s.trim()));
}

async function main(): Promise<void> {
  console.log(buildScaleContextSection());
  const scales = parseScalesArg();
  const allLoads: LoadRecord[] = [];
  const allQueries: QueryRecord[] = [];
  const completedScales: number[] = [];
  let stoppedEarly = false;

  for (const scale of scales) {
    console.log(`\n=== scale ${scale.toLocaleString('en-US')} ===`);
    const stageStart = performance.now();
    const { loads, queries } = await runStage(scale);
    const stageDurationMs = performance.now() - stageStart;

    allLoads.push(...loads);
    allQueries.push(...queries);
    completedScales.push(scale);
    console.log(
      `=== scale ${scale.toLocaleString('en-US')} took ${(stageDurationMs / 1000).toFixed(1)}s ===`,
    );

    if (stageDurationMs > STAGE_BUDGET_MS) {
      console.warn(
        `Stage for scale ${scale} took ${(stageDurationMs / MS_PER_MINUTE).toFixed(1)} min, ` +
          `exceeding the ${STAGE_BUDGET_MS / MS_PER_MINUTE}-minute budget. Stopping before the next scale.`,
      );
      stoppedEarly = true;
      break;
    }
  }

  printConsoleReport(allLoads, allQueries);
  writeResultsMarkdown(
    RESULTS_PATH,
    {
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      totalMemGiB: totalmem() / (1024 * 1024 * 1024),
    },
    allLoads,
    allQueries,
    completedScales,
    stoppedEarly,
  );
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

await main();
