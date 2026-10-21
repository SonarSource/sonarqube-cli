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

// Intended architecture as a value: its revision (a content hash standing in for an ETag)
// and a depth-limited view of its groups.

import { createHash } from 'node:crypto';

import { CommandFailedError } from '@/core/commands/command-error.ts';

import type {
  IntendedArchitecture,
  IntendedConstraint,
  IntendedGroup,
} from './architecture-api.ts';

/** Joins a group label to its parent's key: `Domain/Billing`. */
export const GROUP_KEY_SEPARATOR = '/';

export interface IntendedGroupView {
  key: string;
  patterns: string[];
  interface?: boolean;
  interfaceAccess?: boolean;
  /** Subgroups not shown because they are deeper than the requested depth. */
  hiddenSubgroups?: number;
  groups?: IntendedGroupView[];
}

export interface IntendedView {
  type: IntendedArchitecture['type'];
  language: IntendedArchitecture['language'];
  root: string;
  groups: IntendedGroupView[];
  constraints: IntendedConstraint[];
}

function canonicalGroup(group: IntendedGroup): unknown {
  return [
    group.label,
    [...(group.patterns ?? [])].sort(byCodeUnit),
    group.interface === true,
    group.interfaceAccess === true,
    (group.groups ?? []).map(canonicalGroup),
  ];
}

/** Two models with the same canonical form are analyzed and drawn the same. */
function canonical(models: IntendedArchitecture[]): unknown {
  return models
    .map((model) => [
      model.language,
      model.type,
      model.groups.map(canonicalGroup),
      model.constraints.map(({ from, to }) => JSON.stringify([from, to])).sort(byCodeUnit),
    ])
    .sort(
      (a, b) => byCodeUnit(String(a[0]), String(b[0])) || byCodeUnit(String(a[1]), String(b[1])),
    );
}

/** Locale-independent, so other clients (the SonarQube MCP server) compute the same revision. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function revisionOf(models: IntendedArchitecture[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(models)))
    .digest('hex');
}

/** The groups `depth` levels below the group `component` (or the top level) of one model. */
export function viewIntended(
  model: IntendedArchitecture,
  component: string | undefined,
  depth: number,
): IntendedView | undefined {
  const selected = component === undefined ? undefined : findGroup(model.groups, component);
  if (component !== undefined && selected === undefined) return undefined;
  const start = component === undefined ? model.groups : (selected?.groups ?? []);
  const prefix = component === undefined ? '' : `${component}${GROUP_KEY_SEPARATOR}`;
  return {
    type: model.type,
    language: model.language,
    root: component ?? '',
    groups: start.map((group) => viewGroup(group, prefix, depth)),
    constraints:
      component === undefined
        ? model.constraints
        : model.constraints.filter(
            ({ from, to }) => isWithin(from, component) || isWithin(to, component),
          ),
  };
}

/** Fails with the known top-level keys when `component` names no group of any model. */
export function assertGroupExists(models: IntendedArchitecture[], component: string): void {
  if (models.some((model) => findGroup(model.groups, component) !== undefined)) return;
  throw new CommandFailedError(`No group '${component}' in the intended architecture.`, {
    remediationHint:
      "Run 'sonar architecture intended get' without --component to list the top-level group keys.",
  });
}

function isWithin(key: string, component: string): boolean {
  return key === component || key.startsWith(`${component}${GROUP_KEY_SEPARATOR}`);
}

function findGroup(groups: IntendedGroup[], key: string, prefix = ''): IntendedGroup | undefined {
  for (const group of groups) {
    const groupKey = `${prefix}${group.label}`;
    if (groupKey === key) return group;
    if (key.startsWith(`${groupKey}${GROUP_KEY_SEPARATOR}`)) {
      const found = findGroup(group.groups ?? [], key, `${groupKey}${GROUP_KEY_SEPARATOR}`);
      if (found) return found;
    }
  }
  return undefined;
}

function viewGroup(group: IntendedGroup, prefix: string, depth: number): IntendedGroupView {
  const key = `${prefix}${group.label}`;
  const subgroups = group.groups ?? [];
  const view: IntendedGroupView = { key, patterns: group.patterns ?? [] };
  if (group.interface) view.interface = true;
  if (group.interfaceAccess) view.interfaceAccess = true;
  if (subgroups.length === 0) return view;
  if (depth <= 1) {
    view.hiddenSubgroups = subgroups.length;
    return view;
  }
  view.groups = subgroups.map((child) =>
    viewGroup(child, `${key}${GROUP_KEY_SEPARATOR}`, depth - 1),
  );
  return view;
}
