import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderHomePage } from './home-page.ts';
import { readJson } from './read-json.ts';
import { readTaskDescriptions, type TaskDescription } from './task-descriptions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(HERE, '..', 'tasks');
const TASK_PAGE_TEMPLATE = join(HERE, 'task-page-template.html');
const RUN_PAGE_TEMPLATE = join(HERE, 'run-page-template.html');
const TRIAL_PAGE_TEMPLATE = join(HERE, 'trial-page-template.html');
const EVOLUTION_TEMPLATE = join(HERE, 'evolution-page-template.html');
const NOT_CHECKS = new Set(['trajectory_present', 'trajectory_ok']);
const SCHEMA_VERSION = 2;
const MAX_RECENT_RUNS = 10;
const SAFE_ID = /^[\w.-]+$/;
const REDACTED = '[redacted]';
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsq[apu]_[0-9a-f]{40}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk_live_[A-Za-z0-9]{10,}/g,
];

interface RunFile {
  schemaVersion: number;
  run: {
    cliVersion: string;
    runId: string;
    date: string;
    attempts: number;
    isReference: boolean;
  };
  trials: {
    id: string;
    task: string;
    status: string;
    agentSeconds: number | null;
    stepCount: number | null;
    tokens: number | null;
  }[];
}

interface Index {
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
  reference: string | null;
  recent: string[];
  formerReferences: string[];
}

function load<T>(path: string): T {
  const value = readJson<T>(path);
  if (value === null) throw new Error(`Missing '${path}'`);
  return value;
}

function checkIds(ids: unknown, where: string): void {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && SAFE_ID.test(id)))
    throw new Error(`Malformed list of run ids in '${where}'`);
}

function loadIndex(siteDir: string): Index {
  const path = join(siteDir, 'index.json');
  const index = load<Index>(path);
  if (index.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`Unsupported schemaVersion ${index.schemaVersion} in '${path}'`);
  checkIds(index.recent, path);
  checkIds(index.formerReferences, path);
  checkIds(index.reference === null ? [] : [index.reference], path);
  return index;
}

function loadRun(path: string): RunFile {
  const file = load<RunFile>(path);
  if (file.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`Unsupported schemaVersion ${file.schemaVersion} in '${path}'`);
  checkIds([file.run?.runId], path);
  if (typeof file.run.isReference !== 'boolean' || !Array.isArray(file.trials))
    throw new Error(`Malformed run in '${path}'`);
  return file;
}

function rotate(previous: Index, run: RunFile['run']): Index {
  const { runId, isReference, date } = run;
  if (previous.reference === runId && !isReference)
    throw new Error(
      `Run ${runId} is the current reference: run it again with the reference box checked`,
    );
  const others = {
    reference: previous.reference === runId ? null : previous.reference,
    recent: previous.recent.filter((id) => id !== runId),
    formerReferences: previous.formerReferences.filter((id) => id !== runId),
  };
  if (!isReference) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: date,
      ...others,
      recent: [runId, ...others.recent].slice(0, MAX_RECENT_RUNS),
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: date,
    reference: runId,
    recent: others.recent,
    formerReferences: others.reference
      ? [others.reference, ...others.formerReferences]
      : others.formerReferences,
  };
}

function renderPage(outDir: string, index: Index): string {
  const full = (id: string) => loadRun(join(outDir, 'runs', id, 'run.json'));
  return renderHomePage({
    reference: index.reference ? full(index.reference) : null,
    recent: index.recent.map(full),
    former: index.formerReferences.map((id) => ({
      runId: id,
      version: loadRun(join(outDir, 'references', `${id}.json`)).run.cliVersion,
    })),
  });
}

function redact(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

function redactTrials(trialsDir: string): void {
  for (const name of readdirSync(trialsDir)) {
    const path = join(trialsDir, name);
    writeFileSync(path, redact(readFileSync(path, 'utf8')));
  }
}

function checkDescriptions(outDir: string, runId: string, tasks: TaskDescription[]): void {
  const described = new Map(tasks.map((task) => [task.id, task.checks.map((check) => check.key)]));
  const runDir = join(outDir, 'runs', runId);
  for (const { id } of loadRun(join(runDir, 'run.json')).trials) {
    const trial = load<{ task: string; status: string; checks: { name: string }[] }>(
      join(runDir, 'trials', `${id}.json`),
    );
    if (trial.status === 'ERROR') continue;
    const keys = described.get(trial.task);
    if (!keys)
      throw new Error(
        `Task '${trial.task}' has no description: add tasks/${trial.task}/description.md`,
      );
    const verified = trial.checks
      .map((check) => check.name)
      .filter((name) => !NOT_CHECKS.has(name));
    if ([...verified].sort().join() !== [...keys].sort().join())
      throw new Error(
        `The checks of tasks/${trial.task}/description.md (${keys.join(', ')}) differ from the ones the verifier wrote in trial ${id} (${verified.join(', ')})`,
      );
  }
}

function checkTrials(outDir: string, id: string): void {
  const runDir = join(outDir, 'runs', id);
  for (const { id: trialId } of loadRun(join(runDir, 'run.json')).trials) {
    if (!SAFE_ID.test(trialId)) throw new Error(`Unsafe trial id '${trialId}' in run ${id}`);
    const path = join(runDir, 'trials', `${trialId}.json`);
    if (readJson(path) === null) throw new Error(`Missing trial file '${path}'`);
  }
}

function build(publishedDir: string, newRunDir: string, outDir: string): void {
  const tasks = readTaskDescriptions(TASKS_DIR);
  const newRun = loadRun(join(newRunDir, 'run.json'));
  const { runId } = newRun.run;
  const previous = loadIndex(publishedDir);
  const index = rotate(previous, newRun.run);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'runs'), { recursive: true });
  mkdirSync(join(outDir, 'references'), { recursive: true });
  const kept = [index.reference, ...index.recent].filter((id): id is string => id !== null);
  for (const id of kept) {
    const target = join(outDir, 'runs', id);
    if (id === runId) {
      mkdirSync(target);
      cpSync(join(newRunDir, 'run.json'), join(target, 'run.json'));
      cpSync(join(newRunDir, 'trials'), join(target, 'trials'), { recursive: true });
      redactTrials(join(target, 'trials'));
      checkDescriptions(outDir, runId, tasks);
    } else {
      cpSync(join(publishedDir, 'runs', id), target, { recursive: true });
    }
    checkTrials(outDir, id);
  }
  for (const id of index.formerReferences) {
    const source =
      id === previous.reference
        ? join(publishedDir, 'runs', id, 'run.json')
        : join(publishedDir, 'references', `${id}.json`);
    cpSync(source, join(outDir, 'references', `${id}.json`));
  }
  cpSync(RUN_PAGE_TEMPLATE, join(outDir, 'run.html'));
  cpSync(TRIAL_PAGE_TEMPLATE, join(outDir, 'trial.html'));
  cpSync(EVOLUTION_TEMPLATE, join(outDir, 'evolution.html'));
  writeFileSync(
    join(outDir, 'tasks.json'),
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      tasks: tasks.map((task) => ({ ...task, request: redact(task.request) })),
    }),
  );
  cpSync(TASK_PAGE_TEMPLATE, join(outDir, 'task.html'));
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
  writeFileSync(join(outDir, 'index.html'), renderPage(outDir, index));
}

function main(): void {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true });
  if (positionals.length !== 3)
    throw new Error('Usage: build-site.ts <published dir> <new run dir> <out dir>');
  build(positionals[0], positionals[1], positionals[2]);
}

main();
