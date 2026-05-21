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

import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type { RiskVM } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/dependency-risks-view-model.ts';

function risk(status: string): RiskVM {
  return { severity: 'HIGH', status };
}

const ALL_STATUSES = ['OPEN', 'NEW', 'CONFIRM', 'SAFE', 'FIXED', 'ACCEPT'] as const;

function keep(filter: ReturnType<typeof buildRiskFilter>): string[] {
  return ALL_STATUSES.filter((s) => filter(risk(s)));
}

describe('buildRiskFilter', () => {
  it("'including-safe' keeps every risk regardless of status", () => {
    expect(keep(buildRiskFilter('including-safe'))).toEqual([
      'OPEN',
      'NEW',
      'CONFIRM',
      'SAFE',
      'FIXED',
      'ACCEPT',
    ]);
  });

  it("'all' keeps every status except SAFE", () => {
    expect(keep(buildRiskFilter('all'))).toEqual(['OPEN', 'NEW', 'CONFIRM', 'FIXED', 'ACCEPT']);
  });

  it("'open' drops the resolved statuses (SAFE, FIXED, ACCEPT)", () => {
    expect(keep(buildRiskFilter('open'))).toEqual(['OPEN', 'NEW', 'CONFIRM']);
  });

  it("'new' keeps only NEW", () => {
    expect(keep(buildRiskFilter('new'))).toEqual(['NEW']);
  });
});
