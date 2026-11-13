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

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';
import { incompatibleResponse } from './errors.ts';
import type { FindingType } from './findings.ts';

export const SUMMARY_CATEGORIES = {
  deviations: ['structuralDeviation', 'relationshipDeviation'],
  flaws: ['tangle', 'oversizedComponent'],
  smells: ['weakTangle', 'splitResponsibility'],
} as const satisfies Record<string, readonly FindingType[]>;

export interface SummaryCounts {
  total: number;
  [type: string]: number;
}
export interface ProjectSummary {
  language: Ecosystem;
  deviations: SummaryCounts;
  flaws: SummaryCounts;
  smells: SummaryCounts;
}
export interface SummaryResult {
  summaries: ProjectSummary[];
  skippedSummaries?: number;
}

const invalid = () => incompatibleResponse('Invalid public architecture summary response.');

function parseCounts(value: unknown, types: readonly FindingType[]): SummaryCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const source = value as Record<string, unknown>;
  const result: SummaryCounts = { total: 0 };
  for (const key of ['total', ...types]) {
    const count = source[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalid();
    result[key] = count;
  }
  return result;
}

export function parseSummaries(value: unknown, language?: string): SummaryResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !('projectSummaries' in value) ||
    !Array.isArray(value.projectSummaries)
  )
    throw invalid();
  const seen = new Set<string>();
  let skippedSummaries = 0;
  const summaries: ProjectSummary[] = [];
  for (const item of value.projectSummaries as unknown[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('language' in item) ||
      typeof item.language !== 'string' ||
      (language && item.language !== language) ||
      seen.has(item.language)
    )
      throw invalid();
    seen.add(item.language);
    const ecosystem = ECOSYSTEMS.find((candidate) => candidate === item.language);
    if (!ecosystem) {
      skippedSummaries++;
      continue;
    }
    const row = item as Record<string, unknown>;
    summaries.push({
      language: ecosystem,
      deviations: parseCounts(row.deviations, SUMMARY_CATEGORIES.deviations),
      flaws: parseCounts(row.flaws, SUMMARY_CATEGORIES.flaws),
      smells: parseCounts(row.smells, SUMMARY_CATEGORIES.smells),
    });
  }
  return { summaries, ...(skippedSummaries ? { skippedSummaries } : {}) };
}
