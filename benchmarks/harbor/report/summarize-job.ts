import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TrialResult {
  task_name: string;
  started_at: string | null;
  finished_at: string | null;
  exception_info: { exception_type?: string } | null;
  verifier_result: { rewards?: { reward?: number } } | null;
  agent_execution: { started_at: string | null; finished_at: string | null } | null;
}

interface FinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
}

type Status = 'PASS' | 'FAIL' | 'ERROR';

interface Row {
  label: string;
  task: string;
  status: Status;
  agentSeconds: number | null;
  steps: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
}

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

function statusOf(trial: TrialResult): Status {
  const reward = trial.verifier_result?.rewards?.reward;
  if (trial.exception_info || reward === undefined) return 'ERROR';
  return reward >= 1 ? 'PASS' : 'FAIL';
}

function errorRow(label: string, task: string): Row {
  return {
    label,
    task,
    status: 'ERROR',
    agentSeconds: null,
    steps: null,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    costUsd: null,
  };
}

function rowFor(label: string, trialDir: string, trialName: string): Row {
  const trial = readJson<TrialResult>(join(trialDir, 'result.json'));
  if (!trial?.task_name) return errorRow(label, trialName);
  const trajectory = readJson<{ final_metrics?: FinalMetrics }>(
    join(trialDir, 'agent', 'trajectory.json'),
  );
  const metrics = trajectory?.final_metrics;
  return {
    label,
    task: trial.task_name,
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

function rowsFor(label: string, jobDir: string): Row[] {
  const rows = readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => rowFor(label, join(jobDir, entry.name), entry.name));
  return rows.length > 0 ? rows : [errorRow(label, 'no trials')];
}

function cell(value: number | null, format: (n: number) => string = String): string {
  return value === null ? '-' : format(value);
}

function renderRow(row: Row): string {
  return [
    row.label,
    row.task,
    row.status,
    cell(row.agentSeconds, (n) => `${n.toFixed(0)}s`),
    cell(row.steps),
    cell(row.promptTokens),
    cell(row.completionTokens),
    cell(row.cachedTokens),
    cell(row.costUsd, (n) => `$${n.toFixed(4)}`),
  ].join(' | ');
}

function renderReport(rows: Row[]): string {
  const header = [
    'OS',
    'Task',
    'Status',
    'Agent time',
    'Steps',
    'Prompt tokens',
    'Completion tokens',
    'Cached tokens',
    'Cost',
  ];
  const lines = [
    '## Harbor benchmark',
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${renderRow(row)} |`),
  ];
  return lines.join('\n') + '\n';
}

function main(): void {
  const targets = process.argv.slice(2).map((arg) => {
    const separator = arg.indexOf('=');
    if (separator <= 0) throw new Error(`Expected <label>=<jobDir>, got '${arg}'`);
    return { label: arg.slice(0, separator), jobDir: arg.slice(separator + 1) };
  });
  const rows = targets.flatMap(({ label, jobDir }) => rowsFor(label, jobDir));
  process.stdout.write(renderReport(rows));
  if (rows.length === 0 || rows.some((row) => row.status !== 'PASS')) process.exitCode = 1;
}

main();
