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

import { describe, expect, it } from 'bun:test';

import { aggregateCoverage, parseSummaries } from '@/commands/architecture/_common/summary.ts';

const summary = {
  language: 'java' as const,
  deviations: { total: 3, structuralDeviation: 1, relationshipDeviation: 2 },
  flaws: { total: 1, tangle: 0, oversizedComponent: 1 },
  smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
};

describe('architecture summary response', () => {
  it('reads per-language coverage and returns combined artifact counts without inventing a cross-language score', () => {
    const rows = parseSummaries({
      projectSummaries: [
        { ...summary, coverage: { coverage: 50, coveredArtifacts: 1, totalArtifacts: 2 } },
        {
          ...summary,
          language: 'py',
          coverage: { coverage: 90, coveredArtifacts: 9, totalArtifacts: 10 },
        },
      ],
    }).summaries;
    expect(rows[0].coverage).toEqual({ coverage: 50, coveredArtifacts: 1, totalArtifacts: 2 });
    expect(aggregateCoverage(rows)).toEqual({
      coveredArtifacts: 10,
      totalArtifacts: 12,
    });
    expect(aggregateCoverage(rows, 1)).toBeUndefined();
    expect(
      aggregateCoverage([
        { ...rows[0], coverage: { coverage: 41, coveredArtifacts: 10, totalArtifacts: 10 } },
      ]),
    ).toBeUndefined();
    expect(
      aggregateCoverage([{ ...rows[0], coverage: { coveredArtifacts: 1, totalArtifacts: 2 } }]),
    ).toBeUndefined();
    expect(aggregateCoverage([rows[0], { ...rows[1], coverage: undefined }])).toBeUndefined();
    const huge = {
      ...rows[0],
      coverage: {
        coverage: 100,
        coveredArtifacts: Number.MAX_SAFE_INTEGER,
        totalArtifacts: Number.MAX_SAFE_INTEGER,
      },
    };
    expect(() => aggregateCoverage([huge, rows[0]])).toThrow(
      'Invalid public architecture summary response',
    );
  });

  it('distinguishes unavailable data and zero totals, and refuses incomplete aggregates', () => {
    const rows = parseSummaries({
      projectSummaries: [
        { ...summary, coverage: { coverage: null, coveredArtifacts: 0, totalArtifacts: 0 } },
      ],
    }).summaries;
    expect(aggregateCoverage(rows)).toEqual({
      coveredArtifacts: 0,
      totalArtifacts: 0,
    });
    const missing = parseSummaries({
      projectSummaries: [
        { ...summary, coverage: { coverage: null, coveredArtifacts: null, totalArtifacts: null } },
      ],
    }).summaries;
    expect(missing[0].coverage?.coverage).toBeUndefined();
    expect(aggregateCoverage(missing)).toBeUndefined();
  });

  it('rejects malformed coverage and impossible counts', () => {
    for (const coverage of [
      { coverage: '50' },
      { coverage: 101 },
      { coveredArtifacts: -1 },
      { coveredArtifacts: 1.5 },
      { coveredArtifacts: 2, totalArtifacts: 1 },
    ]) {
      expect(() => parseSummaries({ projectSummaries: [{ ...summary, coverage }] })).toThrow(
        'Invalid public architecture summary response',
      );
    }
  });

  it('returns per-language counts and ignores coverage', () => {
    expect(
      parseSummaries({
        projectSummaries: [
          { ...summary, coverage: null },
          { ...summary, language: 'py' },
        ],
      }),
    ).toEqual({ summaries: [summary, { ...summary, language: 'py' }] });
  });
  it('preserves an empty result without inventing zero counts', () => {
    expect(parseSummaries({ projectSummaries: [] })).toEqual({ summaries: [] });
  });
  it('skips future languages and preserves backend totals', () => {
    const inconsistent = { ...summary, deviations: { ...summary.deviations, total: 9 } };
    expect(
      parseSummaries({ projectSummaries: [inconsistent, { ...summary, language: 'go' }] }),
    ).toEqual({
      summaries: [inconsistent],
      skippedSummaries: 1,
    });
  });
  it('rejects malformed or wrong-language counts', () => {
    for (const value of [
      null,
      {},
      { projectSummaries: [{ ...summary, deviations: undefined }] },
      { projectSummaries: [{ ...summary, flaws: { ...summary.flaws, total: -1 } }] },
      { projectSummaries: [{ ...summary, flaws: { ...summary.flaws, total: '1' } }] },
      { projectSummaries: [{ ...summary, flaws: { ...summary.flaws, total: 1.5 } }] },
      { projectSummaries: [summary, summary] },
    ]) {
      expect(() => parseSummaries(value)).toThrow('Invalid public architecture summary response');
    }
    for (const language of [123, true]) {
      expect(() => parseSummaries({ projectSummaries: [{ ...summary, language }] })).toThrow(
        'Invalid public architecture summary response',
      );
    }
    expect(
      parseSummaries({ projectSummaries: [{ language: 'go', deviations: { total: 'future' } }] }),
    ).toEqual({ summaries: [], skippedSummaries: 1 });
    expect(() => parseSummaries({ projectSummaries: [summary] }, 'py')).toThrow(
      'Invalid public architecture summary response',
    );
  });
});
