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

import { formatMetricValue } from '@/commands/quality-gate/status/format-metric-value.ts';

describe('formatMetricValue', () => {
  it.each([
    ['1', 'A'],
    ['2', 'B'],
    ['3', 'C'],
    ['4', 'D'],
    ['5', 'E'],
  ])('maps RATING %s to letter grade %s', (raw, expected) => {
    expect(formatMetricValue('RATING', raw)).toBe(expected);
  });

  it('falls back to the raw value for an unrecognized RATING value', () => {
    expect(formatMetricValue('RATING', '6')).toBe('6');
  });

  it('appends a % suffix for PERCENT, already at one decimal place', () => {
    expect(formatMetricValue('PERCENT', '95.4')).toBe('95.4%');
    expect(formatMetricValue('PERCENT', '100.0')).toBe('100.0%');
  });

  it('does not invent a decimal place for a whole-number PERCENT threshold', () => {
    expect(formatMetricValue('PERCENT', '80')).toBe('80%');
  });

  it('rounds a PERCENT value to one decimal place by default - component_tree measures are not pre-rounded, unlike project_status conditions', () => {
    expect(formatMetricValue('PERCENT', '38.84615384615385')).toBe('38.8%');
    expect(formatMetricValue('PERCENT', '74.609375')).toBe('74.6%');
  });

  it("rounds a PERCENT value to the metric catalog's own decimalScale instead of always one", () => {
    expect(formatMetricValue('PERCENT', '38.84615384615385', 2)).toBe('38.85%');
    expect(formatMetricValue('PERCENT', '38.84615384615385', 0)).toBe('39%');
  });

  it('does not invent decimal places to match a non-zero decimalScale', () => {
    expect(formatMetricValue('PERCENT', '80', 2)).toBe('80%');
  });

  it('appends a min suffix for WORK_DUR', () => {
    expect(formatMetricValue('WORK_DUR', '150')).toBe('150 min');
  });

  it.each(['INT', 'MILLISEC', 'FLOAT', 'LEVEL', 'DATA', 'DISTRIB', 'BOOL', 'STRING'])(
    'returns %s values unchanged',
    (type) => {
      expect(formatMetricValue(type, '42')).toBe('42');
    },
  );

  it('returns the raw value unchanged for a type it has never seen before', () => {
    expect(formatMetricValue('SOME_FUTURE_TYPE', '42')).toBe('42');
  });
});
