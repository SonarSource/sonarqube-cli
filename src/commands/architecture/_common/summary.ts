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
export interface Coverage {
  coverage?: number;
  coveredArtifacts?: number;
  totalArtifacts?: number;
}
export interface ProjectSummary {
  language: Ecosystem;
  coverage?: Coverage;
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

function parseCoverage(value: unknown): Coverage | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const source = value as Record<string, unknown>;
  const percentage = source.coverage ?? null;
  const covered = source.coveredArtifacts ?? null;
  const total = source.totalArtifacts ?? null;
  if (
    percentage !== null &&
    (typeof percentage !== 'number' ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100)
  )
    throw invalid();
  for (const count of [covered, total]) {
    if (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))
      throw invalid();
  }
  if (typeof covered === 'number' && typeof total === 'number' && covered > total) throw invalid();
  if (percentage === null && covered === null && total === null) return undefined;
  return {
    ...(percentage !== null ? { coverage: percentage } : {}),
    ...(covered !== null ? { coveredArtifacts: covered as number } : {}),
    ...(total !== null ? { totalArtifacts: total as number } : {}),
  };
}

export function aggregateCoverage(
  summaries: ProjectSummary[],
  skippedSummaries?: number,
): Coverage | undefined {
  if (!summaries.length || skippedSummaries) return undefined;
  let covered = 0;
  let total = 0;
  let nonEmptyLanguages = 0;
  let singleCoverage: number | undefined;
  for (const summary of summaries) {
    const data = summary.coverage;
    if (data?.coveredArtifacts == null || data.totalArtifacts == null) return undefined;
    if (
      data.totalArtifacts > 0 &&
      (data.coverage == null ||
        Math.abs(data.coverage - (data.coveredArtifacts / data.totalArtifacts) * 100) > 1e-8)
    )
      return undefined;
    if (data.totalArtifacts > 0) {
      nonEmptyLanguages++;
      singleCoverage = data.coverage;
    }
    covered += data.coveredArtifacts;
    total += data.totalArtifacts;
    if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total)) throw invalid();
  }
  return {
    ...(total === 0 || nonEmptyLanguages > 1 ? {} : { coverage: singleCoverage }),
    coveredArtifacts: covered,
    totalArtifacts: total,
  };
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
    const coverage = parseCoverage(row.coverage);
    summaries.push({
      language: ecosystem,
      ...(coverage ? { coverage } : {}),
      deviations: parseCounts(row.deviations, SUMMARY_CATEGORIES.deviations),
      flaws: parseCounts(row.flaws, SUMMARY_CATEGORIES.flaws),
      smells: parseCounts(row.smells, SUMMARY_CATEGORIES.smells),
    });
  }
  return { summaries, ...(skippedSummaries ? { skippedSummaries } : {}) };
}
