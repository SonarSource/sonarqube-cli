import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_PAGE_URL, taskTitle } from './tasks.ts';

interface TrialResult {
  task_name: string;
  agent_info: { name?: string; model_info?: { name?: string } } | null;
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

type Status = 'PASS' | 'FAIL' | 'ERROR' | 'LEAK';

const LEAK_MARKER_FILE = 'secrets-leak.json';

interface Row {
  label: string;
  trialName: string | null;
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

function errorRow(label: string, task: string, agent: string | null, model: string | null): Row {
  return {
    label,
    trialName: null,
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

function crashedTrialRow(label: string, trialDir: string, trialName: string): Row {
  const config = readJson<{ agent?: { name?: string | null; model_name?: string | null } }>(
    join(trialDir, 'config.json'),
  );
  const modelName = config?.agent?.model_name;
  const suffixStart = trialName.lastIndexOf('__');
  return errorRow(
    label,
    suffixStart > 0 ? trialName.slice(0, suffixStart) : trialName,
    config?.agent?.name ?? null,
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
    trialName,
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

function leakedRow(row: Row): Row {
  return { ...row, status: 'LEAK' };
}

function rowsFor(label: string, jobDir: string): Row[] {
  const rows = readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const trialDir = join(jobDir, entry.name);
      const row = rowFor(label, trialDir, entry.name);
      return existsSync(join(trialDir, LEAK_MARKER_FILE)) ? leakedRow(row) : row;
    });
  if (existsSync(join(jobDir, LEAK_MARKER_FILE)))
    rows.push(leakedRow(errorRow(label, 'job files', null, null)));
  return rows.length > 0 ? rows : [errorRow(label, 'no trials', null, null)];
}

function cell(value: number | null, format: (n: number) => string = String): string {
  return value === null ? '-' : format(value);
}

const STATUS_MARK: Record<Status, string> = {
  PASS: '✅ PASS',
  FAIL: '❌ FAIL',
  ERROR: '⚠️ ERROR',
  LEAK: '🚨 LEAK',
};

function present(value: number | null, format: (n: number) => string): string | null {
  return value === null ? null : format(value);
}

function trajectoryLink(row: Row): string | null {
  const pageUrl = process.env.TRAJECTORY_PAGE_URL;
  if (!pageUrl || row.trialName === null) return null;
  const trialKey = encodeURIComponent(row.label + '/' + row.trialName);
  return `[trajectory](${pageUrl}#${trialKey})`;
}

function renderTrialLine(row: Row): string {
  const tokens =
    row.promptTokens === null || row.completionTokens === null
      ? null
      : `${row.promptTokens.toLocaleString('en-US')} in / ${row.completionTokens.toLocaleString('en-US')} out`;
  return [
    `${STATUS_MARK[row.status]} · \`${row.task}\``,
    present(row.agentSeconds, (n) => `${n.toFixed(0)} s`),
    present(row.steps, (n) => `${n} steps`),
    tokens,
    present(row.costUsd, (n) => `$${n.toFixed(4)}`),
    trajectoryLink(row),
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

function failuresFirst(rows: Row[]): Row[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.status === 'PASS') - Number(b.status === 'PASS') || a.task.localeCompare(b.task),
  );
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
    const key = [row.task, row.agent ?? '-', row.model ?? '-', row.label].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function agentLabel(agent: string | null): string {
  if (agent === 'claude-code') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return agent ?? 'Unknown agent';
}

const TASKS_PER_MODEL_BEFORE_FOLD = 6;

function renderTaskSection(group: Row[]): string[] {
  const [first] = group;
  const passed = group.filter((row) => row.status === 'PASS').length;
  const time = present(average(group.map((row) => row.agentSeconds)), (n) => `${n.toFixed(0)} s`);
  const cost = present(average(group.map((row) => row.costUsd)), (n) => `$${n.toFixed(4)}`);
  return [
    `#### [${taskTitle(first.task)}](${TASKS_PAGE_URL}#${first.task}) · \`${first.task}\``,
    '',
    [
      `**${passed} of ${group.length} passed**`,
      time && `average time ${time}`,
      cost && `average cost ${cost}`,
    ]
      .filter(Boolean)
      .join(' · '),
    '',
  ];
}

function renderTaskSections(groups: Row[][]): string[] {
  const sections = groups.flatMap(renderTaskSection);
  if (groups.length <= TASKS_PER_MODEL_BEFORE_FOLD) return sections;
  return [
    '<details>',
    `<summary>Show the ${groups.length} tasks</summary>`,
    '',
    ...sections,
    '</details>',
    '',
  ];
}

function renderAgentSections(rows: Row[]): string[] {
  const sections = new Map<string, Row[]>();
  for (const row of rows) {
    const key = [row.agent ?? '-', row.model ?? '-'].join('|');
    sections.set(key, [...(sections.get(key) ?? []), row]);
  }
  return [...sections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, sectionRows]) => {
      const [first] = sectionRows;
      return [
        `### ${agentLabel(first.agent)} · model ${first.model ?? 'unknown'}`,
        '',
        ...renderTaskSections(groupTrials(sectionRows)),
        '',
        '<details>',
        `<summary>Trials (${sectionRows.length})</summary>`,
        '',
        ...failuresFirst(sectionRows).flatMap((row) => [renderTrialLine(row), '']),
        '',
        '</details>',
        '',
      ];
    });
}

function renderReport(rows: Row[]): string {
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const lines = [
    '## Harbor benchmark',
    '',
    `**Total: ${passed} of ${rows.length} trials passed** · cost ${cell(
      total(rows.map((row) => row.costUsd)),
      (n) => `$${n.toFixed(4)}`,
    )}`,
    '',
    `An agent gets one request on a clean machine, then an automatic check decides pass or fail. A trial passes when its check gives a reward of 1. [What each task tests](${TASKS_PAGE_URL}).`,
    '',
    ...renderAgentSections(rows),
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
