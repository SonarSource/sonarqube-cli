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

import type { EffectiveStatus, RiskVM } from './view-model';

export type RiskFilterPredicate = (risk: RiskVM) => boolean;

export interface RiskFilterDescription {
  effectiveStatuses: EffectiveStatus[];
  discardedStatuses: EffectiveStatus[];
}
export interface RiskFilter {
  description: RiskFilterDescription;
  predicate: RiskFilterPredicate;
}

const EFFECTIVE_STATUSES = [
  'NEW',
  'OPEN',
  'CONFIRM',
  'ACCEPT',
  'SAFE',
  'FIXED',
] as const satisfies readonly EffectiveStatus[];

export const STATUS_PRESETS = ['active', 'to_fix', 'all'] as const;
export type StatusPreset = (typeof STATUS_PRESETS)[number];

const PRESET_EXPANSIONS: Record<StatusPreset, EffectiveStatus[]> = {
  active: ['NEW', 'OPEN', 'CONFIRM'],
  to_fix: ['NEW', 'OPEN', 'CONFIRM', 'ACCEPT'],
  all: [...EFFECTIVE_STATUSES],
};

export function buildRiskFilter(input: string): RiskFilter | null {
  const tokens = input.split(',').map((s) => s.trim().toLowerCase());
  const set = new Set<EffectiveStatus>();

  for (const token of tokens) {
    if ((STATUS_PRESETS as readonly string[]).includes(token)) {
      for (const status of PRESET_EXPANSIONS[token as StatusPreset]) {
        set.add(status);
      }
    } else {
      const status = EFFECTIVE_STATUSES.find((s) => s.toLowerCase() === token);
      if (!status) return null;
      set.add(status);
    }
  }

  if (set.size === 0) return null;
  return {
    description: {
      effectiveStatuses: EFFECTIVE_STATUSES.filter((s) => set.has(s)),
      discardedStatuses: EFFECTIVE_STATUSES.filter((s) => !set.has(s)),
    },
    predicate: (risk) => set.has(risk.status),
  };
}
