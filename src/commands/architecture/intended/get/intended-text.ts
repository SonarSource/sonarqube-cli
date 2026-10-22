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

// Human-readable `sonar architecture intended get --format text`.

import type {
  IntendedArchitecture,
  IntendedGroup,
} from '@/commands/architecture/_common/architecture-api.ts';
import {
  GROUP_KEY_SEPARATOR,
  type IntendedGroupView,
  type IntendedView,
} from '@/commands/architecture/_common/intended-model.ts';
import { bold, dim } from '@/core/ui/colors.ts';

const MAX_TEXT_LINES = 120;

/** Per language, the groups tree with its patterns and the allowed dependencies, then the revision. */
export function formatIntendedText(
  projectKey: string,
  revision: string,
  models: IntendedArchitecture[],
  views: IntendedView[],
): string {
  const lines = [`${projectKey}: intended architecture`];
  for (const view of views) {
    const model = models.find(
      ({ language, type }) => language === view.language && type === view.type,
    );
    const groups = countGroups(model?.groups ?? []);
    const constraints = model?.constraints.length ?? 0;
    const below = view.root ? `, showing below ${view.root}` : '';
    lines.push(
      bold(
        `${view.language} (${view.type}): ${groups} group(s), ${constraints} constraint(s)${below}`,
      ),
      ...view.groups.flatMap((group) => groupLines(group, view.root, 1)),
    );
    if (view.constraints.length > 0) {
      lines.push('  allowed:', ...view.constraints.map(({ from, to }) => `    ${from} -> ${to}`));
    }
  }
  const shown =
    lines.length > MAX_TEXT_LINES
      ? [
          ...lines.slice(0, MAX_TEXT_LINES),
          `… ${lines.length - MAX_TEXT_LINES} more line(s); narrow with --component or --depth, or use --format json.`,
        ]
      : lines;
  return [...shown, dim(`revision ${revision}`)].join('\n');
}

function groupLines(group: IntendedGroupView, parentKey: string, depth: number): string[] {
  const label = parentKey
    ? group.key.slice(parentKey.length + GROUP_KEY_SEPARATOR.length)
    : group.key;
  const flags = [
    group.interface && 'interface',
    group.interfaceAccess && 'interface-access',
  ].filter(Boolean);
  const hidden = group.hiddenSubgroups
    ? ` (+${group.hiddenSubgroups} subgroup(s), raise --depth)`
    : '';
  return [
    `${'  '.repeat(depth)}${label}` +
      (group.patterns.length > 0 ? ` [${group.patterns.join(', ')}]` : '') +
      (flags.length > 0 ? ` (${flags.join(', ')})` : '') +
      hidden,
    ...(group.groups ?? []).flatMap((child) => groupLines(child, group.key, depth + 1)),
  ];
}

function countGroups(groups: IntendedGroup[]): number {
  return groups.reduce((total, group) => total + 1 + countGroups(group.groups ?? []), 0);
}
