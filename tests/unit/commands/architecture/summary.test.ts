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

import { parseSummaries } from '@/commands/architecture/current/get/summary.ts';

const summary = {
  language: 'java',
  deviations: { total: 3, structuralDeviation: 1, relationshipDeviation: 2 },
  flaws: { total: 1, tangle: 0, oversizedComponent: 1 },
  smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
};

describe('architecture summary response', () => {
  it('returns per-language counts and ignores coverage', () => {
    expect(
      parseSummaries({
        projectSummaries: [
          { ...summary, coverage: { percentage: '50' } },
          { ...summary, language: 'py' },
        ],
      }),
    ).toEqual([summary, { ...summary, language: 'py' }]);
  });
  it('preserves an empty result without inventing zero counts', () => {
    expect(parseSummaries({ projectSummaries: [] })).toEqual([]);
  });
  it('rejects malformed, inconsistent or wrong-language counts', () => {
    for (const value of [
      null,
      {},
      { projectSummaries: [{ ...summary, deviations: { ...summary.deviations, total: 4 } }] },
      { projectSummaries: [{ ...summary, flaws: { ...summary.flaws, total: 1.5 } }] },
      { projectSummaries: [summary, summary] },
    ]) {
      expect(() => parseSummaries(value)).toThrow();
    }
    expect(() => parseSummaries({ projectSummaries: [summary] }, 'py')).toThrow();
  });
});
