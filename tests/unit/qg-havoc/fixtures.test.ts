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

import { describe, expect, test } from 'bun:test';

import { describeHashAlgorithm, hashToken } from '@/qg-havoc/crypto.ts';
import { buildDiagnosticHeader, summarizeEnvironment } from '@/qg-havoc/diagnostics.ts';
import { classifyRiskLevel, describeRiskBand } from '@/qg-havoc/risk-classifier.ts';
import { computeSeverityScore, labelSeverityScore } from '@/qg-havoc/severity-score.ts';
import { computeSeverityScore as computeSeverityScoreDuplicate } from '@/qg-havoc/severity-score-duplicate.ts';
import { describeTraceOrigin, generateTraceId } from '@/qg-havoc/trace.ts';

describe('qg-havoc fixtures (intentionally partial coverage)', () => {
  test('risk-classifier', () => {
    expect(classifyRiskLevel(50)).toBe('medium');
    expect(describeRiskBand('medium')).toBe('Review recommended');
  });

  test('diagnostics', () => {
    expect(buildDiagnosticHeader().releaseTag).toBe('production');
    expect(summarizeEnvironment('production')).toBe('Production environment');
  });

  test('trace', () => {
    expect(generateTraceId()).toContain('trace-');
    expect(describeTraceOrigin('other')).toBe('Unknown origin');
  });

  test('severity-score', () => {
    expect(computeSeverityScore({ blocker: 1, critical: 0, major: 0, minor: 0, info: 0 })).toBe(40);
    expect(labelSeverityScore(300)).toBe('severe');
  });

  test('severity-score-duplicate', () => {
    expect(
      computeSeverityScoreDuplicate({ blocker: 30, critical: 0, major: 0, minor: 0, info: 0 }),
    ).toBe(1000);
  });

  test('crypto', () => {
    expect(hashToken('example')).toHaveLength(32);
    expect(describeHashAlgorithm('sha256')).toBe('Modern digest');
  });
});
