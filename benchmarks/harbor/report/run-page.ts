import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, TITLES } from './tasks.ts';

const META_PLACEHOLDER = '__TRIAL_META__';

function readTemplate(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
}

export function renderRunPage(): string {
  return readTemplate('run-page-template.html');
}

export function renderTrialPage(): string {
  const template = readTemplate('trial-page-template.html');
  if (!template.includes(META_PLACEHOLDER))
    throw new Error(`trial-page-template.html has no ${META_PLACEHOLDER} placeholder`);
  const meta = { checks: CHECKS, titles: TITLES };
  const payload = encodeURIComponent(JSON.stringify(meta)).replace(/'/g, '%27');
  return template.replace(META_PLACEHOLDER, () => payload);
}
