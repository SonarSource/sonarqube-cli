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

function canonicalGroup(group: IntendedGroup, writable = false): unknown {
  return [
    group.label,
    [...(group.patterns ?? [])].sort(byCodeUnit),
    group.interface === true,
    group.interfaceAccess === true,
    writable && group.patternId !== undefined
      ? []
      : (group.groups ?? []).map((child) => canonicalGroup(child, writable)),
    group.description ?? null,
    group.patternId?.toLowerCase() ?? null,
  ];
}

/** Two models with the same canonical form are analyzed and drawn the same. */
function canonical(models: IntendedArchitecture[], writable = false): unknown {
  return models
    .map((model) => [
      model.language,
      model.type,
      model.groups.map((group) => canonicalGroup(group, writable)),
      model.constraints.map(({ from, to }) => JSON.stringify([from, to])).sort(byCodeUnit),
      model.label ?? null,
      model.description ?? null,
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

export function writableRevisionOf(models: IntendedArchitecture[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(models, true)))
    .digest('hex');
}

export function recoveryModels(models: IntendedArchitecture[]): IntendedArchitecture[] {
  return models.map((model) => ({ ...model, groups: recoveryGroups(model.groups) }));
}

function recoveryGroups(groups: IntendedGroup[]): IntendedGroup[] {
  return groups.map(({ groups: children, ...group }) => ({
    ...group,
    ...(group.patternId !== undefined || children === undefined
      ? {}
      : { groups: recoveryGroups(children) }),
  }));
}

export function assertImportedGroupsUnchanged(
  current: IntendedArchitecture[],
  next: IntendedArchitecture[],
): void {
  for (const model of next) {
    const previous = current.find(
      (candidate) => candidate.type === model.type && candidate.language === model.language,
    );
    if (previous) checkImportedGroups(previous.groups, model.groups, []);
  }
}

function checkImportedGroups(
  before: IntendedGroup[],
  after: IntendedGroup[],
  parent: string[],
): void {
  const previous = new Map(before.map((group) => [group.label, group]));
  for (const group of after) {
    const old = previous.get(group.label);
    if (!old) continue;
    const path = [...parent, group.label];
    if (
      group.groups !== undefined &&
      old.patternId !== undefined &&
      old.patternId.toLowerCase() === group.patternId?.toLowerCase() &&
      JSON.stringify((old.groups ?? []).map((child) => canonicalGroup(child))) !==
        JSON.stringify((group.groups ?? []).map((child) => canonicalGroup(child)))
    ) {
      throw new CommandFailedError(
        `Cannot edit expanded children of pattern-linked group ${JSON.stringify(path)}; the server resolves them from patternId. Nothing was changed.`,
      );
    }
    if (group.patternId === undefined)
      checkImportedGroups(old.groups ?? [], group.groups ?? [], path);
  }
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

function findGroup(groups: IntendedGroup[], key: string): IntendedGroup | undefined {
  const matches: IntendedGroup[] = [];
  function visit(children: IntendedGroup[], prefix: string): void {
    for (const group of children) {
      const groupKey = `${prefix}${group.label}`;
      if (groupKey === key) matches.push(group);
      visit(group.groups ?? [], `${groupKey}${GROUP_KEY_SEPARATOR}`);
    }
  }
  visit(groups, '');
  if (matches.length > 1)
    throw new CommandFailedError(
      `Ambiguous group key '${key}'; use a complete intended export without --component.`,
    );
  return matches[0];
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
