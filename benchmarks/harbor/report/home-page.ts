import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_PLACEHOLDER = '__HOME_DATA__';

export interface HomeRunFile {
  run: { runId: string; cliVersion: string; date: string };
  trials: {
    task: string;
    status: string;
    agentSeconds: number | null;
    stepCount: number | null;
    tokens: number | null;
  }[];
}

export interface HomeInput {
  reference: HomeRunFile | null;
  recent: HomeRunFile[];
  former: { runId: string; version: string }[];
}

interface HomeTask {
  id: string;
  passed: number;
  total: number;
  steps: number | null;
  tokens: number | null;
  seconds: number | null;
}

interface HomeRun {
  runId: string;
  version: string;
  date: string;
  tasks: HomeTask[];
}

function median(values: (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(file: HomeRunFile): HomeRun {
  const byTask = new Map<string, HomeRunFile['trials']>();
  for (const trial of file.trials)
    byTask.set(trial.task, [...(byTask.get(trial.task) ?? []), trial]);
  return {
    runId: file.run.runId,
    version: file.run.cliVersion,
    date: file.run.date,
    tasks: [...byTask].map(([id, trials]) => ({
      id,
      passed: trials.filter((trial) => trial.status === 'PASS').length,
      total: trials.length,
      steps: median(trials.map((trial) => trial.stepCount)),
      tokens: median(trials.map((trial) => trial.tokens)),
      seconds: median(trials.map((trial) => trial.agentSeconds)),
    })),
  };
}

export function renderHomePage(input: HomeInput): string {
  const template = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'home-page-template.html'),
    'utf8',
  );
  if (!template.includes(DATA_PLACEHOLDER))
    throw new Error(`home-page-template.html has no ${DATA_PLACEHOLDER} placeholder`);
  const data = {
    reference: input.reference ? summarize(input.reference) : null,
    recent: input.recent.map(summarize),
    former: input.former,
  };
  const payload = encodeURIComponent(JSON.stringify(data)).replace(/'/g, '%27');
  return template.replace(DATA_PLACEHOLDER, () => payload);
}
