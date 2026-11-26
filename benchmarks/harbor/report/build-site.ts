import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson } from './read-json.ts';

const SCHEMA_VERSION = 2;
const EVOLUTION_TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  'evolution-page-template.html',
);
const MAX_RECENT_RUNS = 10;
const SAFE_ID = /^[\w.-]+$/;
const REDACTED = '[redacted]';
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsq[apu]_[0-9a-f]{40}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
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
  trials: { id: string; status: string }[];
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

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function runItem(file: RunFile, href: string): string {
  const { run, trials } = file;
  const passed = trials.filter((trial) => trial.status === 'PASS').length;
  return `<li><a href="${escapeHtml(href)}">${escapeHtml(run.date)} - CLI ${escapeHtml(run.cliVersion)} - run ${escapeHtml(run.runId)}</a>: ${passed} of ${trials.length} trials passed</li>`;
}

function runSection(title: string, items: string[]): string {
  return items.length === 0 ? '' : `<h2>${title}</h2><ul>${items.join('')}</ul>`;
}

function renderPage(outDir: string, index: Index): string {
  const full = (id: string) =>
    runItem(loadRun(join(outDir, 'runs', id, 'run.json')), `runs/${id}/run.json`);
  const former = (id: string) =>
    runItem(loadRun(join(outDir, 'references', `${id}.json`)), `references/${id}.json`);
  const sections = [
    runSection('Reference run', index.reference ? [full(index.reference)] : []),
    runSection('Latest runs', index.recent.map(full)),
    runSection('Former references', index.formerReferences.map(former)),
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbor benchmark</title></head><body><h1>Harbor benchmark</h1><p><a href="evolution.html">Evolution by CLI version</a></p>${sections}</body></html>\n`;
}

function redactTrials(trialsDir: string): void {
  for (const name of readdirSync(trialsDir)) {
    const path = join(trialsDir, name);
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), text),
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
  cpSync(EVOLUTION_TEMPLATE, join(outDir, 'evolution.html'));
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
