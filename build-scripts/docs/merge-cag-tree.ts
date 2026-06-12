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

/**
 * Merge a sonar-context-augmentation CLI tree (obtained via `tool dump-cli-tree`)
 * into the flat ClidocCommand list produced by generate-docs.ts.
 */

import type { CagCliTree, CagCommand, CagOption } from './dump-cag-tree';
export type { CagCliTree, CagOption } from './dump-cag-tree';
import { EXAMPLES } from './examples';

export interface ClidocArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
}

export interface ClidocOption {
  flags: string;
  long: string;
  short: string | undefined;
  description: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  allowedValues?: string[];
}

export interface ClidocCommand {
  id: string;
  name: string;
  fullName: string;
  description: string;
  isGroup: boolean;
  isRoot: boolean;
  requiresAuth: boolean;
  depth: number;
  parentId: string | null;
  arguments: ClidocArgument[];
  options: ClidocOption[];
  examples: { command: string; description: string }[];
  children: string[];
}

/**
 * Commands (by full name) that do not require a SonarQube connection.
 * Every other CAG command is marked requiresAuth: true.
 */
export const CAG_NON_AUTH_FULL_NAMES = new Set([
  'sonar context tool start',
  'sonar context tool stop',
  'sonar context tool status',
  'sonar context tool print-skill',
]);

export function buildCagFlags(opt: CagOption): string {
  const valuePart = opt.value_name ? ` <${opt.value_name}>` : '';
  const longFlag = `--${opt.long}${valuePart}`;
  return opt.short ? `-${opt.short}, ${longFlag}` : longFlag;
}

export function mapCagOptions(opts: CagOption[] | undefined): ClidocOption[] {
  if (!opts) return [];
  return opts.map((o) => ({
    flags: buildCagFlags(o),
    long: `--${o.long}`,
    short: o.short ? `-${o.short}` : undefined,
    description: o.help ?? '',
    type: o.value_name ? 'string' : 'boolean',
    required: o.required,
    defaultValue: o.default,
    allowedValues: undefined,
  }));
}

function addCagCommand(
  cmd: CagCommand,
  parentId: string,
  parentFullName: string,
  parentDepth: number,
  allCommands: ClidocCommand[],
): void {
  const fullName = `${parentFullName} ${cmd.name}`;
  const id = fullName.replaceAll(/\s+/g, '-');
  const hasChildren = (cmd.subcommands?.length ?? 0) > 0;

  const entry: ClidocCommand = {
    id,
    name: cmd.name,
    fullName,
    description: cmd.about ?? '',
    isGroup: hasChildren,
    isRoot: false,
    requiresAuth: !CAG_NON_AUTH_FULL_NAMES.has(fullName),
    depth: parentDepth + 1,
    parentId,
    arguments: [],
    options: mapCagOptions(cmd.options),
    examples: EXAMPLES[fullName] ?? [],
    children: (cmd.subcommands ?? []).map((c) => `${id}-${c.name}`),
  };

  allCommands.push(entry);

  for (const child of cmd.subcommands ?? []) {
    addCagCommand(child, id, fullName, parentDepth + 1, allCommands);
  }
}

/**
 * Stitch the CAG command tree into `allCommands` under the `sonar-context` entry.
 *
 * - Sets `sonar-context.isGroup = true` and replaces its passthrough `arguments`.
 * - Recursively adds a `ClidocCommand` for every visible CAG subcommand.
 * - Auth flags follow `CAG_NON_AUTH_FULL_NAMES` — everything else is `requiresAuth: true`.
 *
 * Throws if the `sonar-context` entry is missing from `allCommands`.
 */
export function mergeCagTree(cagTree: CagCliTree, allCommands: ClidocCommand[]): void {
  const contextEntry = allCommands.find((c) => c.id === 'sonar-context');
  if (!contextEntry) {
    throw new Error('sonar-context entry not found in allCommands — cannot merge CAG tree');
  }

  contextEntry.isGroup = true;
  contextEntry.arguments = [];
  contextEntry.children = cagTree.subcommands.map((c) => `sonar-context-${c.name}`);

  for (const cmd of cagTree.subcommands) {
    addCagCommand(cmd, 'sonar-context', 'sonar context', 1, allCommands);
  }
}
