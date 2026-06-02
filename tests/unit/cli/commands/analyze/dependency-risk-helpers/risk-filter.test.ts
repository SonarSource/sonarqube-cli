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

import {
  buildRiskFilter,
  type RiskFilterPredicate,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type {
  EffectiveStatus,
  RiskVM,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';

function risk(status: EffectiveStatus): RiskVM {
  return { severity: 'HIGH', status };
}

const ALL_STATUSES: readonly EffectiveStatus[] = [
  'OPEN',
  'NEW',
  'CONFIRM',
  'SAFE',
  'FIXED',
  'ACCEPT',
];

function keep(predicate: RiskFilterPredicate): string[] {
  return ALL_STATUSES.filter((s) => predicate(risk(s)));
}

function predicateFor(input: string): RiskFilterPredicate {
  return buildRiskFilter(input)!.predicate;
}

describe('buildRiskFilter — predicate', () => {
  it("'all' preset keeps every status", () => {
    expect(keep(predicateFor('all'))).toEqual([
      'OPEN',
      'NEW',
      'CONFIRM',
      'SAFE',
      'FIXED',
      'ACCEPT',
    ]);
  });

  it("'to_fix,fixed' keeps every status except SAFE", () => {
    expect(keep(predicateFor('to_fix,fixed'))).toEqual([
      'OPEN',
      'NEW',
      'CONFIRM',
      'FIXED',
      'ACCEPT',
    ]);
  });

  it("'active' preset keeps new, open, confirmed (drops SAFE, FIXED, ACCEPT)", () => {
    expect(keep(predicateFor('active'))).toEqual(['OPEN', 'NEW', 'CONFIRM']);
  });

  it("'new' individual status keeps only NEW", () => {
    expect(keep(predicateFor('new'))).toEqual(['NEW']);
  });
});

describe('buildRiskFilter — vm', () => {
  it("'active' expands to NEW, OPEN, CONFIRM in canonical order", () => {
    expect(buildRiskFilter('active')?.description.effectiveStatuses).toEqual([
      'NEW',
      'OPEN',
      'CONFIRM',
    ]);
  });

  it('raw input keeps the listed statuses, deduplicated and in canonical order', () => {
    expect(buildRiskFilter('confirm,new')?.description.effectiveStatuses).toEqual([
      'NEW',
      'CONFIRM',
    ]);
  });

  it('preset + raw merges and deduplicates (active,safe)', () => {
    expect(buildRiskFilter('active,safe')?.description.effectiveStatuses).toEqual([
      'NEW',
      'OPEN',
      'CONFIRM',
      'SAFE',
    ]);
  });

  it('returns null for an unknown token', () => {
    expect(buildRiskFilter('bogus')).toBeNull();
  });
});
