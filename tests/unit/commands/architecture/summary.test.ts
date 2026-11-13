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

import { parseSummaries } from '@/commands/architecture/_common/summary.ts';

const summary = {
  language: 'java' as const,
  deviations: { total: 3, structuralDeviation: 1, relationshipDeviation: 2 },
  flaws: { total: 1, tangle: 0, oversizedComponent: 1 },
  smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
};

describe('architecture summary response', () => {
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
