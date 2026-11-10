import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

interface ReleaseReport {
  schemaVersion: number;
  release: { cliVersion: string; runId: string; commit: string; date: string };
  trials: { model: string | null }[];
}

const MAX_MODELS = 8;
const DATA_PLACEHOLDER = '__RELEASES_JSON__';

function loadReports(dataDir: string): ReleaseReport[] {
  const files = readdirSync(dataDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`No release JSON in '${dataDir}'`);
  return files.map((file) => {
    const report = JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as ReleaseReport;
    if (report.schemaVersion !== 1)
      throw new Error(`${file}: unsupported schemaVersion ${report.schemaVersion}`);
    if (!Array.isArray(report.trials) || report.trials.length === 0)
      throw new Error(`${file}: no trials`);
    return report;
  });
}

function checkModelCount(reports: ReleaseReport[]): void {
  const models = new Set(reports.flatMap((report) => report.trials.map((trial) => trial.model)));
  if (models.size > MAX_MODELS)
    throw new Error(
      `${models.size} models found, the palette has ${MAX_MODELS} colors: fold the tail into "Other" first`,
    );
}

function resolveDataDir(argument: string | undefined): string {
  if (!argument) throw new Error('Usage: dashboard.ts <dataDir> > dashboard.html');
  const dataDir = resolve(argument);
  if (!statSync(dataDir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`'${argument}' is not a directory`);
  return dataDir;
}

function main(): void {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true });
  const reports = loadReports(resolveDataDir(positionals[0]));
  checkModelCount(reports);
  const template = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'dashboard-template.html'),
    'utf8',
  );
  if (!template.includes(DATA_PLACEHOLDER))
    throw new Error(`dashboard-template.html has no ${DATA_PLACEHOLDER} placeholder`);
  const payload = encodeURIComponent(JSON.stringify(reports));
  process.stdout.write(template.replace(DATA_PLACEHOLDER, () => payload));
}

main();
