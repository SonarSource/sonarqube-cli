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

// What applying one intended architecture over another changes, one line per change.

import type {
  IntendedArchitecture,
  IntendedConstraint,
  IntendedGroup,
} from './architecture-api.ts';
import { GROUP_KEY_SEPARATOR } from './intended-model.ts';

export interface IntendedDiff {
  removed: string[];
  added: string[];
  changed: string[];
}

interface FlatGroup {
  path: string[];
  patterns: string[];
  interface: boolean;
  interfaceAccess: boolean;
}

export function diffIntended(
  current: IntendedArchitecture[],
  next: IntendedArchitecture[],
): IntendedDiff {
  const diff: IntendedDiff = { removed: [], added: [], changed: [] };
  const languages = [...new Set([...current, ...next].map(({ language }) => language))].sort(
    (a, b) => a.localeCompare(b),
  );
  for (const language of languages) {
    const before = current.find((model) => model.language === language);
    const after = next.find((model) => model.language === language);
    if (!after) diff.removed.push(`model ${language}`);
    if (!before) diff.added.push(`model ${language}`);
    if (before && after && before.type !== after.type) {
      diff.changed.push(`model ${language}: type ${before.type} -> ${after.type}`);
    }
    diffGroups(
      language,
      flattenGroups(before?.groups ?? []),
      flattenGroups(after?.groups ?? []),
      diff,
    );
    diffGroupOrder(language, before?.groups ?? [], after?.groups ?? [], '', diff);
    diffConstraints(language, before?.constraints ?? [], after?.constraints ?? [], diff);
  }
  return diff;
}

function diffGroupOrder(
  language: string,
  before: IntendedGroup[],
  after: IntendedGroup[],
  parent: string,
  diff: IntendedDiff,
): void {
  const beforeByLabel = new Map(before.map((group) => [group.label, group]));
  const afterLabels = new Set(after.map(({ label }) => label));
  const previousOrder = before
    .filter(({ label }) => afterLabels.has(label))
    .map(({ label }) => label);
  const nextOrder = after.filter(({ label }) => beforeByLabel.has(label)).map(({ label }) => label);
  if (JSON.stringify(previousOrder) !== JSON.stringify(nextOrder)) {
    diff.changed.push(
      `group order ${language} ${parent || '<root>'}: ${previousOrder.join(', ')} -> ${nextOrder.join(', ')}`,
    );
  }
  for (const group of after) {
    const previous = beforeByLabel.get(group.label);
    if (previous) {
      const key = parent ? `${parent}${GROUP_KEY_SEPARATOR}${group.label}` : group.label;
      diffGroupOrder(language, previous.groups ?? [], group.groups ?? [], key, diff);
    }
  }
}

export function isEmptyDiff(diff: IntendedDiff): boolean {
  return diff.removed.length + diff.added.length + diff.changed.length === 0;
}

function flattenGroups(groups: IntendedGroup[], parent: string[] = []): Map<string, FlatGroup> {
  const flat = new Map<string, FlatGroup>();
  for (const group of groups) {
    const path = [...parent, group.label];
    flat.set(path.join(GROUP_KEY_SEPARATOR), {
      path,
      patterns: group.patterns ?? [],
      interface: group.interface === true,
      interfaceAccess: group.interfaceAccess === true,
    });
    const children = flattenGroups(group.groups ?? [], path);
    for (const [childKey, child] of children) flat.set(childKey, child);
  }
  return flat;
}

function diffGroups(
  language: string,
  before: Map<string, FlatGroup>,
  after: Map<string, FlatGroup>,
  diff: IntendedDiff,
): void {
  for (const key of before.keys()) {
    if (!after.has(key)) diff.removed.push(`group ${language} ${key}`);
  }
  for (const [key, group] of after) {
    const old = before.get(key);
    if (!old) {
      diff.added.push(`group ${language} ${key} [${group.patterns.join(', ')}]`);
      continue;
    }
    if (JSON.stringify(old.path) !== JSON.stringify(group.path)) {
      diff.changed.push(
        `group ${language} ${key}: hierarchy ${JSON.stringify(old.path)} -> ${JSON.stringify(group.path)}`,
      );
    }
    const oldPatterns = new Set(old.patterns);
    const newPatterns = new Set(group.patterns);
    for (const pattern of oldPatterns) {
      if (!newPatterns.has(pattern)) diff.removed.push(`pattern ${language} ${key} ${pattern}`);
    }
    for (const pattern of newPatterns) {
      if (!oldPatterns.has(pattern)) diff.added.push(`pattern ${language} ${key} ${pattern}`);
    }
    for (const flag of ['interface', 'interfaceAccess'] as const) {
      if (old[flag] !== group[flag]) {
        diff.changed.push(`group ${language} ${key}: ${flag} ${old[flag]} -> ${group[flag]}`);
      }
    }
  }
}

function diffConstraints(
  language: string,
  before: IntendedConstraint[],
  after: IntendedConstraint[],
  diff: IntendedDiff,
): void {
  const describe = ({ from, to }: IntendedConstraint): string =>
    `constraint ${language} ${from} -> ${to}`;
  const beforeLines = new Set(before.map(describe));
  const afterLines = new Set(after.map(describe));
  for (const line of beforeLines) {
    if (!afterLines.has(line)) diff.removed.push(line);
  }
  for (const line of afterLines) {
    if (!beforeLines.has(line)) diff.added.push(line);
  }
}
