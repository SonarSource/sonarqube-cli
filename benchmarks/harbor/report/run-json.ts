import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { lastSegment, readJson } from './read-json.ts';

const SCHEMA_VERSION = 2;
const MAX_TEXT_LENGTH = 2000;
const STOPPED_MESSAGE = 'Harbor stopped before it wrote result.json, so this trial has no verdict';
const NO_TRAJECTORY_MESSAGE = 'Harbor wrote no agent/trajectory.json for this trial';
const CODEX_NON_ZERO_EXIT = /Process exited with code [1-9]/;

interface TrialResult {
  task_name?: string;
  agent_info: { name?: string; model_info?: { name?: string } } | null;
  exception_info: { exception_type?: string } | null;
  verifier_result: { rewards?: Record<string, number> } | null;
  agent_execution: { started_at: string | null; finished_at: string | null } | null;
}

interface TrialConfig {
  task?: { path?: string | null };
  agent?: { name?: string | null; model_name?: string | null };
}

interface RawStep {
  source: string;
  message?: string;
  tool_calls?: {
    tool_call_id: string;
    function_name: string;
    arguments?: Record<string, unknown>;
  }[];
  observation?: {
    results?: {
      source_call_id?: string;
      content?: string;
      extra?: { tool_result_is_error?: boolean };
    }[];
  };
}

interface Trajectory {
  steps?: RawStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps?: number;
  };
}

type Status = 'PASS' | 'FAIL' | 'ERROR';

interface RunInfo {
  cliVersion: string;
  runId: string;
  date: string;
  attempts: number;
  isReference: boolean;
}

interface TrialSummary {
  id: string;
  task: string;
  agent: string | null;
  model: string | null;
  status: Status;
  agentSeconds: number | null;
  stepCount: number | null;
  tokens: number | null;
}

interface Call {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  isError: boolean;
}

interface Step {
  source: string;
  message: string;
  calls: Call[];
}

interface TrialDetail {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  task: string;
  status: Status;
  error: string | null;
  checks: { name: string; passed: boolean }[];
  steps: Step[];
}

interface RunSummary {
  schemaVersion: typeof SCHEMA_VERSION;
  run: RunInfo;
  trials: TrialSummary[];
}

interface Trial {
  summary: TrialSummary;
  detail: TrialDetail;
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TEXT_LENGTH)}… [${text.length - MAX_TEXT_LENGTH} more characters]`;
}

function truncateStrings(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' ? truncate(value) : value,
    ]),
  );
}

function failed(result: { content?: string; extra?: { tool_result_is_error?: boolean } }): boolean {
  return (
    result.extra?.tool_result_is_error === true || CODEX_NON_ZERO_EXIT.test(result.content ?? '')
  );
}

function reduceStep(step: RawStep): Step {
  const results = new Map(
    (step.observation?.results ?? []).map((result) => [result.source_call_id, result]),
  );
  return {
    source: step.source,
    message: truncate(step.message ?? ''),
    calls: (step.tool_calls ?? []).map((call) => {
      const result = results.get(call.tool_call_id);
      return {
        name: call.function_name,
        arguments: truncateStrings(call.arguments ?? {}),
        output: truncate(result?.content ?? ''),
        isError: result !== undefined && failed(result),
      };
    }),
  };
}

function secondsBetween(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  return (Date.parse(end) - Date.parse(start)) / 1000;
}

function statusOf(result: TrialResult): Status {
  const reward = result.verifier_result?.rewards?.reward;
  if (result.exception_info || reward === undefined) return 'ERROR';
  return reward >= 1 ? 'PASS' : 'FAIL';
}

function checksOf(result: TrialResult): TrialDetail['checks'] {
  return Object.entries(result.verifier_result?.rewards ?? {})
    .filter(([name]) => name !== 'reward')
    .map(([name, value]) => ({ name, passed: value >= 1 }));
}

function stoppedTrial(id: string, config: TrialConfig | null): Trial {
  const suffixStart = id.lastIndexOf('__');
  const path = config?.task?.path;
  const task = path
    ? lastSegment(path.replace(/\/+$/, ''))
    : suffixStart > 0
      ? id.slice(0, suffixStart)
      : id;
  const model = config?.agent?.model_name;
  return {
    summary: {
      id,
      task,
      agent: config?.agent?.name ?? null,
      model: model ? lastSegment(model) : null,
      status: 'ERROR',
      agentSeconds: null,
      stepCount: null,
      tokens: null,
    },
    detail: {
      schemaVersion: SCHEMA_VERSION,
      id,
      task,
      status: 'ERROR',
      error: STOPPED_MESSAGE,
      checks: [],
      steps: [],
    },
  };
}

function tokensOf(metrics: Trajectory['final_metrics']): number | null {
  const { total_prompt_tokens: prompt, total_completion_tokens: completion } = metrics ?? {};
  const cached = metrics?.total_cached_tokens;
  if (prompt === undefined || completion === undefined || cached === undefined) return null;
  return prompt - cached + completion;
}

function readTrial(trialDir: string): Trial {
  const id = basename(trialDir);
  const resultPath = join(trialDir, 'result.json');
  const result = readJson<TrialResult>(resultPath);
  if (!result) return stoppedTrial(id, readJson<TrialConfig>(join(trialDir, 'config.json')));
  if (!result.task_name) throw new Error(`No task_name in '${resultPath}'`);
  const trajectory = readJson<Trajectory>(join(trialDir, 'agent', 'trajectory.json'));
  const metrics = trajectory?.final_metrics;
  const task = lastSegment(result.task_name);
  const status = statusOf(result);
  return {
    summary: {
      id,
      task,
      agent: result.agent_info?.name ?? null,
      model: result.agent_info?.model_info?.name ?? null,
      status,
      agentSeconds: secondsBetween(
        result.agent_execution?.started_at,
        result.agent_execution?.finished_at,
      ),
      stepCount: metrics?.total_steps ?? null,
      tokens: tokensOf(metrics),
    },
    detail: {
      schemaVersion: SCHEMA_VERSION,
      id,
      task,
      status,
      error: result.exception_info?.exception_type ?? (trajectory ? null : NO_TRAJECTORY_MESSAGE),
      checks: checksOf(result),
      steps: (trajectory?.steps ?? []).map(reduceStep),
    },
  };
}

function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readJob(jobDir: string): Trial[] {
  const trials = subdirectories(jobDir).map((name) => readTrial(join(jobDir, name)));
  if (trials.length === 0) throw new Error(`No trial found in '${jobDir}'`);
  return trials;
}

function writeRun(outDir: string, runDir: string, run: RunInfo): void {
  const jobs = subdirectories(runDir);
  if (jobs.length === 0) throw new Error(`No folder in '${runDir}'`);
  const trials = jobs.flatMap((job) => readJob(join(runDir, job)));
  const ids = trials.map((trial) => trial.summary.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate trial ids in '${runDir}'`);
  const summary: RunSummary = {
    schemaVersion: SCHEMA_VERSION,
    run,
    trials: trials.map((trial) => trial.summary),
  };
  mkdirSync(join(outDir, 'trials'), { recursive: true });
  writeFileSync(join(outDir, 'run.json'), JSON.stringify(summary));
  for (const { detail } of trials)
    writeFileSync(join(outDir, 'trials', `${detail.id}.json`), JSON.stringify(detail));
}

function parseRun(values: Record<string, string | boolean | undefined>): RunInfo {
  for (const flag of ['cli-version', 'run-id', 'date', 'attempts', 'out']) {
    if (!values[flag]) throw new Error(`Missing --${flag}`);
  }
  const date = values.date as string;
  if (Number.isNaN(Date.parse(date))) throw new Error(`--date is not a date: '${date}'`);
  const attempts = Number(values.attempts);
  if (!/^\d+$/.test(values.attempts as string) || attempts < 1)
    throw new Error(`--attempts is not a positive integer: '${values.attempts}'`);
  return {
    cliVersion: values['cli-version'] as string,
    runId: values['run-id'] as string,
    date,
    attempts,
    isReference: values.reference === true,
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'cli-version': { type: 'string' },
      'run-id': { type: 'string' },
      date: { type: 'string' },
      attempts: { type: 'string' },
      reference: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const run = parseRun(values);
  if (positionals.length !== 1) throw new Error('Expected exactly one <runDir>');
  writeRun(values.out as string, positionals[0], run);
}

main();
