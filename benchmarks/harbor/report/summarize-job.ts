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

const PASSED_ICON = '✅';
const FAILED_ICON = '❌';

const STATUS_ICON: Record<Status, string> = {
  PASS: PASSED_ICON,
  FAIL: FAILED_ICON,
  ERROR: '⚠️',
  LEAK: '🚨',
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

const TOKENS_PER_THOUSAND = 1000;
const TOKENS_WITHOUT_DECIMAL = 10000;

function compactNumber(value: number): string {
  if (value < TOKENS_PER_THOUSAND) return String(value);
  const thousands = value / TOKENS_PER_THOUSAND;
  return `${thousands.toFixed(value < TOKENS_WITHOUT_DECIMAL ? 1 : 0)}k`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function tokensOf(row: Row): string | null {
  if (row.promptTokens === null || row.completionTokens === null) return null;
  return `${compactNumber(row.promptTokens)} in / ${compactNumber(row.completionTokens)} out`;
}

interface Column {
  header: string;
  cell: (row: Row) => string | null;
}

const TRIAL_COLUMNS: Column[] = [
  { header: '', cell: (row) => STATUS_ICON[row.status] },
  { header: 'Time', cell: (row) => present(row.agentSeconds, (n) => `⏱ ${n.toFixed(0)} s`) },
  { header: 'Steps', cell: (row) => present(row.steps, String) },
  { header: 'Tokens', cell: tokensOf },
  { header: 'Cost', cell: (row) => present(row.costUsd, (n) => `$${n.toFixed(4)}`) },
  { header: '', cell: trajectoryLink },
];

function renderTrialsTable(rows: Row[]): string[] {
  const columns = TRIAL_COLUMNS.filter(
    (column, index) => index === 0 || rows.some((row) => column.cell(row) !== null),
  );
  return [
    `| ${columns.map((column) => column.header).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${columns.map((column) => column.cell(row) ?? '').join(' | ')} |`),
  ];
}

const INDENT = '&emsp;&emsp;';
const GAP = '&emsp;';

function indented(level: number, line: string): string {
  return INDENT.repeat(level) + line;
}

function hardBreaks(lines: string[]): string[] {
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}  ` : line));
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

const FOLD_DEPTH = 5;
const OPEN_INDENT = '<dl><dd>'.repeat(FOLD_DEPTH);
const CLOSE_INDENT = '</dd></dl>'.repeat(FOLD_DEPTH);

function renderTaskSection(group: Row[]): string[] {
  const [first] = group;
  const passed = group.filter((row) => row.status === 'PASS').length;
  const time = present(
    average(group.map((row) => row.agentSeconds)),
    (n) => `Avg time ${n.toFixed(0)} s`,
  );
  const cost = present(
    average(group.map((row) => row.costUsd)),
    (n) => `Avg cost $${n.toFixed(4)}`,
  );
  const mark = passed === group.length ? PASSED_ICON : FAILED_ICON;
  const result = `${mark} ${passed} of ${group.length} passed`;
  const figures = [result, time, cost].filter(Boolean).join(GAP);
  return [
    ...hardBreaks([
      indented(1, `\`${first.task}\` ([link](${TASKS_PAGE_URL}#${first.task}))`),
      indented(2, taskTitle(first.task)),
      indented(2, figures),
    ]),
    '',
    OPEN_INDENT,
    '<details>',
    `<summary>${plural(group.length, 'trial')}, open one to read its trajectory</summary>`,
    '',
    ...renderTrialsTable(failuresFirst(group)),
    '',
    '</details>',
    CLOSE_INDENT,
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

function renderAgentSection(sectionRows: Row[]): string[] {
  const [first] = sectionRows;
  const passed = sectionRows.filter((row) => row.status === 'PASS').length;
  const groups = groupTrials(sectionRows);
  const mark = passed === sectionRows.length ? PASSED_ICON : FAILED_ICON;
  const cost = present(total(sectionRows.map((row) => row.costUsd)), (n) => `$${n.toFixed(4)}`);
  const result = `${passed} of ${plural(sectionRows.length, 'trial')} passed`;
  const figures = [result, cost && `${cost} in total`, plural(groups.length, 'task')];
  return [
    `### ${mark} Agent: ${agentLabel(first.agent)} (${first.model ?? 'unknown model'})`,
    '',
    figures.filter(Boolean).join(GAP),
    '',
    '#### Tasks',
    '',
    ...renderTaskSections(groups),
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
    .flatMap(([, sectionRows]) => renderAgentSection(sectionRows));
}

function renderIntro(): string[] {
  const pageUrl = process.env.TRAJECTORY_PAGE_URL;
  const sentence =
    'Each trial is one attempt by an AI coding agent at a task. An automatic check decides pass or fail.';
  if (!pageUrl) return [sentence, ''];
  return [...hardBreaks([sentence, `[Read every trajectory, step by step](${pageUrl})`]), ''];
}

function renderReport(rows: Row[]): string {
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const lines = [
    '## Harbor benchmark',
    '',
    ...renderIntro(),
    `${passed === rows.length ? PASSED_ICON : FAILED_ICON} ${passed} of ${plural(rows.length, 'trial')} passed, ${cell(
      total(rows.map((row) => row.costUsd)),
      (n) => `$${n.toFixed(4)}`,
    )} in total`,
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
