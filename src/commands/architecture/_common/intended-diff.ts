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
  description?: string;
  patternId?: string;
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
    const before = current.filter((model) => model.language === language);
    const after = next.filter((model) => model.language === language);
    if (before.length <= 1 && after.length <= 1) {
      diffPerspective(language, before[0], after[0], diff);
      continue;
    }
    const types = [...new Set([...before, ...after].map(({ type }) => type))].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const type of types) {
      diffPerspective(
        `${language} (${type})`,
        before.find((model) => model.type === type),
        after.find((model) => model.type === type),
        diff,
      );
    }
  }

  return diff;
}

function diffPerspective(
  language: string,
  before: IntendedArchitecture | undefined,
  after: IntendedArchitecture | undefined,
  diff: IntendedDiff,
): void {
  if (!after) diff.removed.push(`model ${language}`);
  if (!before) diff.added.push(`model ${language}`);
  if (before && after && before.type !== after.type)
    diff.changed.push(`model ${language}: type ${before.type} -> ${after.type}`);
  if (before && after) {
    for (const field of ['label', 'description'] as const) {
      if (before[field] !== after[field])
        diff.changed.push(
          `model ${language}: ${field} ${JSON.stringify(before[field] ?? null)} -> ${JSON.stringify(after[field] ?? null)}`,
        );
    }
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
    if (previous && previous.patternId === undefined && group.patternId === undefined) {
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
    flat.set(JSON.stringify(path), {
      path,
      description: group.description,
      patternId: group.patternId?.toLowerCase(),
      patterns: group.patterns ?? [],
      interface: group.interface === true,
      interfaceAccess: group.interfaceAccess === true,
    });
    const children = flattenGroups(group.patternId === undefined ? (group.groups ?? []) : [], path);
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
  const previousByDisplayKey = new Map<string, { identity: string; group: FlatGroup }[]>();
  const nextCounts = new Map<string, number>();
  for (const [identity, group] of before) {
    const displayKey = group.path.join(GROUP_KEY_SEPARATOR);
    const entries = previousByDisplayKey.get(displayKey) ?? [];
    entries.push({ identity, group });
    previousByDisplayKey.set(displayKey, entries);
  }
  for (const group of after.values()) {
    const key = group.path.join(GROUP_KEY_SEPARATOR);
    nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
  }
  const matched = new Set<string>();
  for (const [identity, group] of after) {
    const key = group.path.join(GROUP_KEY_SEPARATOR);
    const candidates = previousByDisplayKey.get(key) ?? [];
    const exact = before.get(identity);
    let previous: { identity: string; group: FlatGroup } | undefined;
    if (exact) previous = { identity, group: exact };
    else if (candidates.length === 1 && nextCounts.get(key) === 1) previous = candidates[0];
    if (!previous) {
      diff.added.push(`group ${language} ${key} [${group.patterns.join(', ')}]`);
      continue;
    }
    matched.add(previous.identity);
    diffExistingGroup(language, key, previous.group, group, diff);
  }
  for (const [identity, group] of before) {
    if (!matched.has(identity))
      diff.removed.push(`group ${language} ${group.path.join(GROUP_KEY_SEPARATOR)}`);
  }
}

function diffExistingGroup(
  language: string,
  key: string,
  old: FlatGroup,
  group: FlatGroup,
  diff: IntendedDiff,
): void {
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
  for (const field of ['description', 'patternId'] as const) {
    if (old[field] !== group[field])
      diff.changed.push(
        `group ${language} ${key}: ${field} ${JSON.stringify(old[field] ?? null)} -> ${JSON.stringify(group[field] ?? null)}`,
      );
  }
  for (const flag of ['interface', 'interfaceAccess'] as const) {
    if (old[flag] !== group[flag]) {
      diff.changed.push(`group ${language} ${key}: ${flag} ${old[flag]} -> ${group[flag]}`);
    }
  }
}

function diffConstraints(
  language: string,
  before: IntendedConstraint[],
  after: IntendedConstraint[],
  diff: IntendedDiff,
): void {
  const keyOf = ({ from, to }: IntendedConstraint): string => JSON.stringify([from, to]);
  const describe = ({ from, to }: IntendedConstraint): string =>
    `constraint ${language} ${constraintEndpoint(from)} -> ${constraintEndpoint(to)}`;
  const beforePairs = new Set(before.map(keyOf));
  const afterPairs = new Set(after.map(keyOf));
  for (const constraint of before) {
    if (!afterPairs.has(keyOf(constraint))) diff.removed.push(describe(constraint));
  }
  for (const constraint of after) {
    if (!beforePairs.has(keyOf(constraint))) diff.added.push(describe(constraint));
  }
}

function constraintEndpoint(key: string): string {
  return key.includes(' -> ') ? JSON.stringify(key) : key;
}
