import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface TrialResult {
  task_name: string;
  agent_info: { name?: string; model_info?: { name?: string } } | null;
  exception_info: { exception_type?: string } | null;
  verifier_result: { rewards?: { reward?: number } } | null;
  agent_execution: { started_at: string | null; finished_at: string | null } | null;
}

interface TrialConfig {
  agent?: { name?: string | null; model_name?: string | null };
}

interface FinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
}

type Status = 'PASS' | 'FAIL' | 'ERROR' | 'LEAK';

interface TrialRecord {
  os: string;
  task: string;
  agent: string | null;
  model: string | null;
  status: Status;
  agentSeconds: number | null;
  steps: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
}

interface Release {
  cliVersion: string;
  runId: string;
  commit: string;
  date: string;
  iteration?: string;
}

interface ReleaseReport {
  schemaVersion: 1;
  release: Release;
  trials: TrialRecord[];
}

const LEAK_MARKER_FILE = 'secrets-leak.json';

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

function secondsBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  return (Date.parse(end) - Date.parse(start)) / 1000;
}

function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function statusOf(trial: TrialResult): Status {
  const reward = trial.verifier_result?.rewards?.reward;
  if (trial.exception_info || reward === undefined) return 'ERROR';
  return reward >= 1 ? 'PASS' : 'FAIL';
}

function errorRecord(
  os: string,
  task: string,
  agent: string | null,
  model: string | null,
): TrialRecord {
  return {
    os,
    task,
    agent,
    model,
    status: 'ERROR',
    agentSeconds: null,
    steps: null,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    costUsd: null,
  };
}

function crashedTrialRecord(os: string, trialDir: string, trialName: string): TrialRecord {
  const agent = readJson<TrialConfig>(join(trialDir, 'config.json'))?.agent;
  const suffixStart = trialName.lastIndexOf('__');
  return errorRecord(
    os,
    suffixStart > 0 ? trialName.slice(0, suffixStart) : trialName,
    agent?.name ?? null,
    agent?.model_name ? lastSegment(agent.model_name) : null,
  );
}

function trialRecord(os: string, trialDir: string, trialName: string): TrialRecord {
  const trial = readJson<TrialResult>(join(trialDir, 'result.json'));
  if (!trial?.task_name) return crashedTrialRecord(os, trialDir, trialName);
  const metrics = readJson<{ final_metrics?: FinalMetrics }>(
    join(trialDir, 'agent', 'trajectory.json'),
  )?.final_metrics;
  return {
    os,
    task: lastSegment(trial.task_name),
    agent: trial.agent_info?.name ?? null,
    model: trial.agent_info?.model_info?.name ?? null,
    status: statusOf(trial),
    agentSeconds: secondsBetween(
      trial.agent_execution?.started_at,
      trial.agent_execution?.finished_at,
    ),
    steps: metrics?.total_steps ?? null,
    promptTokens: metrics?.total_prompt_tokens ?? null,
    completionTokens: metrics?.total_completion_tokens ?? null,
    cachedTokens: metrics?.total_cached_tokens ?? null,
    costUsd: metrics?.total_cost_usd ?? null,
  };
}

function leaked(record: TrialRecord): TrialRecord {
  return { ...record, status: 'LEAK' };
}

function recordsFor(os: string, jobDir: string): TrialRecord[] {
  const records = readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const trialDir = join(jobDir, entry.name);
      const record = trialRecord(os, trialDir, entry.name);
      return existsSync(join(trialDir, LEAK_MARKER_FILE)) ? leaked(record) : record;
    });
  if (existsSync(join(jobDir, LEAK_MARKER_FILE)))
    records.push(leaked(errorRecord(os, 'job files', null, null)));
  if (records.length === 0) throw new Error(`No trial found in '${jobDir}'`);
  return records;
}

function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function jobsOf(runDir: string): { os: string; jobDir: string }[] {
  const folders = subdirectories(runDir);
  if (folders.length === 0) throw new Error(`No folder in '${runDir}'`);
  return folders.map((os) => ({ os, jobDir: join(runDir, os) }));
}

function parseRelease(values: Record<string, string | undefined>): Release {
  const flags = ['cli-version', 'run-id', 'commit', 'date'] as const;
  for (const flag of flags) {
    if (!values[flag]) throw new Error(`Missing --${flag}`);
  }
  const date = values.date as string;
  if (Number.isNaN(Date.parse(date))) throw new Error(`--date is not a date: '${date}'`);
  const iteration = values.iteration;
  if (iteration !== undefined && !iteration) throw new Error('--iteration is empty');
  return {
    cliVersion: values['cli-version'] as string,
    runId: values['run-id'] as string,
    commit: values.commit as string,
    date,
    ...(iteration ? { iteration } : {}),
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'cli-version': { type: 'string' },
      'run-id': { type: 'string' },
      commit: { type: 'string' },
      date: { type: 'string' },
      iteration: { type: 'string' },
    },
  });
  const release = parseRelease(values);
  if (positionals.length !== 1) throw new Error('Expected exactly one <runDir>');
  const trials = jobsOf(positionals[0]).flatMap(({ os, jobDir }) => recordsFor(os, jobDir));
  const report: ReleaseReport = { schemaVersion: 1, release, trials };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main();
