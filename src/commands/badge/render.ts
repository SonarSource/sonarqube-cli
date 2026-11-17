/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { InvalidOptionError } from '@/core/commands/command-error.ts';

const METRICS = [
  ['quality-gate', 'alert_status', 'Quality Gate Status'],
  ['coverage', 'coverage', 'Coverage'],
  ['bugs', 'bugs', 'Bugs'],
  ['vulnerabilities', 'vulnerabilities', 'Vulnerabilities'],
  ['code-smells', 'code_smells', 'Code Smells'],
  ['security-hotspots', 'security_hotspots', 'Security Hotspots'],
  ['duplications', 'duplicated_lines_density', 'Duplications'],
  ['lines', 'ncloc', 'Lines of Code'],
  ['maintainability-rating', 'sqale_rating', 'Maintainability Rating'],
  ['reliability-rating', 'reliability_rating', 'Reliability Rating'],
  ['security-rating', 'security_rating', 'Security Rating'],
  ['technical-debt', 'sqale_index', 'Technical Debt'],
] as const;

type Metric = (typeof METRICS)[number];
export const METRIC_NAMES = [...METRICS.map(([name]) => name), 'all'];
export const BADGE_FORMATS = ['markdown', 'html', 'url', 'json'] as const;

export function selectMetrics(input: string[] | undefined, isCloud: boolean): Metric[] {
  const catalog = METRICS.filter(([name]) => !isCloud || name !== 'security-hotspots');
  const selected: Metric[] = [];
  for (const name of (input ?? ['quality-gate']).flatMap((value) =>
    value.split(',').map((s) => s.trim()),
  )) {
    if (name === 'all') {
      selected.push(...catalog);
      continue;
    }
    const metric = catalog.find(([alias]) => alias === name);
    if (!metric) {
      throw new InvalidOptionError(
        `Invalid --metric value: '${name}'. Available badges: ${catalog.map(([alias]) => alias).join(', ')}, all. Security hotspots are only available on SonarQube Server.`,
      );
    }
    selected.push(metric);
  }
  return [...new Set(selected)];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderBadges(options: {
  project: string;
  branch?: string;
  baseUrl: string;
  isCloud: boolean;
  token?: string;
  metrics: Metric[];
  format: string;
}): string {
  const { project, branch, baseUrl, isCloud, token, metrics, format } = options;
  const projectUrl = new URL(`${baseUrl}/${isCloud ? 'summary/new_code' : 'dashboard'}`);
  projectUrl.searchParams.set('id', project);
  if (branch !== undefined) projectUrl.searchParams.set('branch', branch);
  const badges = metrics.map(([metric, apiMetric, label]) => {
    const imageUrl = new URL(`${baseUrl}/api/project_badges/measure`);
    imageUrl.searchParams.set('project', project);
    imageUrl.searchParams.set('metric', apiMetric);
    if (branch !== undefined) imageUrl.searchParams.set('branch', branch);
    if (token !== undefined) imageUrl.searchParams.set('token', token);
    const image = imageUrl.toString();
    const target = projectUrl.toString();
    return {
      metric,
      label,
      imageUrl: image,
      projectUrl: target,
      markdown: `[![${label}](${image})](${target})`,
      html: `<a href="${escapeHtml(target)}"><img alt="${escapeHtml(label)}" src="${escapeHtml(image)}"></a>`,
    };
  });
  if (format === 'json') return JSON.stringify({ project, branch, badges }, null, 2);
  return badges
    .map((badge) => (format === 'url' ? badge.imageUrl : badge[format as 'markdown' | 'html']))
    .join('\n');
}
