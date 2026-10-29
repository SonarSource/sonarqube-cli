import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TrialResult {
  task_name: string;
  agent_info: { model_info?: { name?: string } } | null;
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
  model: string | null;
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

function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function errorRow(label: string, task: string, model: string | null): Row {
  return {
    label,
    task,
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

function crashedTrialRow(label: string, trialDir: string, trialName: string): Row {
  const config = readJson<{ agent?: { model_name?: string | null } }>(
    join(trialDir, 'config.json'),
  );
  const modelName = config?.agent?.model_name;
  const suffixStart = trialName.lastIndexOf('__');
  return errorRow(
    label,
    suffixStart > 0 ? trialName.slice(0, suffixStart) : trialName,
    modelName ? lastSegment(modelName) : null,
  );
}

function rowFor(label: string, trialDir: string, trialName: string): Row {
  const trial = readJson<TrialResult>(join(trialDir, 'result.json'));
  if (!trial?.task_name) return crashedTrialRow(label, trialDir, trialName);
  const trajectory = readJson<{ final_metrics?: FinalMetrics }>(
    join(trialDir, 'agent', 'trajectory.json'),
  );
  const metrics = trajectory?.final_metrics;
  return {
    label,
    task: lastSegment(trial.task_name),
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

function rowsFor(label: string, jobDir: string): Row[] {
  const rows = readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => rowFor(label, join(jobDir, entry.name), entry.name));
  return rows.length > 0 ? rows : [errorRow(label, 'no trials', null)];
}

function cell(value: number | null, format: (n: number) => string = String): string {
  return value === null ? '-' : format(value);
}

function renderTrial(row: Row): string[] {
  return [
    row.label,
    row.task,
    row.model ?? '-',
    row.status,
    cell(row.agentSeconds, (n) => `${n.toFixed(0)}s`),
    cell(row.steps),
    cell(row.promptTokens),
    cell(row.completionTokens),
    cell(row.cachedTokens),
    cell(row.costUsd, (n) => `$${n.toFixed(4)}`),
  ];
}

function total(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0);
}

function average(values: (number | null)[]): number | null {
  const count = values.filter((value) => value !== null).length;
  const sum = total(values);
  return sum === null ? null : sum / count;
}

function groupTrials(rows: Row[]): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = [row.task, row.model ?? '-', row.label].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function renderGroup(group: Row[]): string[] {
  const [first] = group;
  const passed = group.filter((row) => row.status === 'PASS').length;
  return [
    first.label,
    first.task,
    first.model ?? '-',
    `${passed}/${group.length}`,
    cell(average(group.map((row) => row.agentSeconds)), (n) => `${n.toFixed(0)}s`),
    cell(average(group.map((row) => row.steps)), (n) => n.toFixed(1)),
    cell(average(group.map((row) => row.promptTokens)), (n) => n.toFixed(0)),
    cell(average(group.map((row) => row.completionTokens)), (n) => n.toFixed(0)),
    cell(average(group.map((row) => row.cachedTokens)), (n) => n.toFixed(0)),
    cell(average(group.map((row) => row.costUsd)), (n) => `$${n.toFixed(4)}`),
  ];
}

function renderTable(header: string[], lines: string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...lines.map((line) => `| ${line.join(' | ')} |`),
  ];
}

function renderReport(rows: Row[]): string {
  const metrics = [
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
    'Averages over the trials of each task, model and OS.',
    '',
    ...renderTable(
      ['OS', 'Task', 'Model', 'Passed', ...metrics],
      groupTrials(rows).map(renderGroup),
    ),
    '',
    `Total cost of the ${rows.length} trials: ${cell(
      total(rows.map((row) => row.costUsd)),
      (n) => `$${n.toFixed(4)}`,
    )}`,
    '',
    '<details>',
    '<summary>Trials</summary>',
    '',
    ...renderTable(['OS', 'Task', 'Model', 'Status', ...metrics], rows.map(renderTrial)),
    '',
    '</details>',
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
