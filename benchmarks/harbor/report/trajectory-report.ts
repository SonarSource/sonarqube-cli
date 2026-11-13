import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskTitle } from './tasks.ts';

interface Span {
  started_at: string | null;
  finished_at: string | null;
}

interface TrialResult {
  task_name: string;
  trial_name: string;
  started_at: string | null;
  exception_info: { exception_type?: string; exception_message?: string } | null;
  agent_info: { name?: string; version?: string; model_info?: { name?: string } } | null;
  agent_result: {
    n_input_tokens?: number;
    n_cache_tokens?: number;
    n_output_tokens?: number;
    cost_usd?: number;
  } | null;
  verifier_result: { rewards?: Record<string, number> } | null;
  environment_setup: Span | null;
  agent_setup: Span | null;
  agent_execution: Span | null;
  verifier: Span | null;
}

interface ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments?: Record<string, unknown>;
}

interface ObservationResult {
  source_call_id?: string;
  content?: string;
  extra?: { tool_result_is_error?: boolean };
}

interface Step {
  step_id: number;
  timestamp?: string;
  source: string;
  message?: string;
  tool_calls?: ToolCall[];
  observation?: { results?: ObservationResult[] };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    cost_usd?: number;
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

function seconds(span: Span | null): number | null {
  if (!span?.started_at || !span.finished_at) return null;
  return (Date.parse(span.finished_at) - Date.parse(span.started_at)) / 1000;
}

function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function stepOf(step: Step) {
  return {
    id: step.step_id,
    at: step.timestamp ?? null,
    source: step.source,
    message: step.message ?? '',
    calls: (step.tool_calls ?? []).map((call) => ({
      id: call.tool_call_id,
      name: call.function_name,
      arguments: call.arguments ?? {},
    })),
    results: (step.observation?.results ?? []).map((result) => ({
      callId: result.source_call_id ?? null,
      content: result.content ?? '',
      isError: result.extra?.tool_result_is_error === true,
    })),
    promptTokens: step.metrics?.prompt_tokens ?? null,
    completionTokens: step.metrics?.completion_tokens ?? null,
    cachedTokens: step.metrics?.cached_tokens ?? null,
    costUsd: step.metrics?.cost_usd ?? null,
  };
}

function trialOf(group: string, trialDir: string) {
  const result = readJson<TrialResult>(join(trialDir, 'result.json'));
  if (!result?.task_name) return null;
  const trajectory = readJson<{ steps?: Step[] }>(join(trialDir, 'agent', 'trajectory.json'));
  const agent = result.agent_info;
  const usage = result.agent_result;
  const task = lastSegment(result.task_name);
  return {
    group,
    name: result.trial_name,
    task,
    taskTitle: taskTitle(task),
    agent: agent?.name ?? null,
    agentVersion: agent?.version ?? null,
    model: agent?.model_info?.name ?? null,
    startedAt: result.started_at,
    exception: result.exception_info
      ? `${result.exception_info.exception_type ?? 'Error'}: ${result.exception_info.exception_message ?? ''}`
      : null,
    rewards: result.verifier_result?.rewards ?? null,
    costUsd: usage?.cost_usd ?? null,
    inputTokens: usage?.n_input_tokens ?? null,
    cachedTokens: usage?.n_cache_tokens ?? null,
    outputTokens: usage?.n_output_tokens ?? null,
    seconds: {
      environment: seconds(result.environment_setup),
      agentSetup: seconds(result.agent_setup),
      agent: seconds(result.agent_execution),
      verifier: seconds(result.verifier),
    },
    steps: (trajectory?.steps ?? []).map(stepOf),
  };
}

function trialsOf(jobDir: string) {
  const group = basename(jobDir);
  return readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => trialOf(group, join(jobDir, entry.name)))
    .filter((trial) => trial !== null);
}

function main(): void {
  const jobDirs = process.argv.slice(2);
  if (jobDirs.length === 0) throw new Error('Usage: trajectory-report.ts <jobDir>...');
  const trials = jobDirs.flatMap(trialsOf);
  if (trials.length === 0) throw new Error('No trial found');
  const template = readFileSync(join(HERE, 'trajectory-report-template.html'), 'utf8');
  const font = readFileSync(join(HERE, 'fonts', 'GoogleSansCode-VariableFont_wght.ttf'));
  const data = encodeURIComponent(JSON.stringify(trials));
  process.stdout.write(
    template
      .replace('__FONT_BASE64__', () => font.toString('base64'))
      .replace('__TRIALS_JSON__', () => data),
  );
}

main();
