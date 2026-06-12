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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  buildCagFlags,
  CAG_NON_AUTH_FULL_NAMES,
  type CagCliTree,
  type ClidocCommand,
  mapCagOptions,
  mergeCagTree,
} from '../../../../build-scripts/docs/merge-cag-tree';

const fixtureTree: CagCliTree = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', 'fixtures', 'cag-cli-tree.json'), 'utf-8'),
);

function makeContextEntry(): ClidocCommand {
  return {
    id: 'sonar-context',
    name: 'context',
    fullName: 'sonar context',
    description: 'Context augmentation passthrough',
    isGroup: false,
    isRoot: false,
    requiresAuth: false,
    depth: 1,
    parentId: 'sonar',
    arguments: [
      { name: 'action', description: '', required: false, variadic: false },
      { name: 'args', description: '', required: false, variadic: true },
    ],
    options: [],
    examples: [],
    children: [],
  };
}

function runMerge(): { allCommands: ClidocCommand[]; byId: Map<string, ClidocCommand> } {
  const contextEntry = makeContextEntry();
  const allCommands: ClidocCommand[] = [contextEntry];
  mergeCagTree(fixtureTree, allCommands);
  const byId = new Map(allCommands.map((c) => [c.id, c]));
  return { allCommands, byId };
}

describe('mergeCagTree', () => {
  it('sets sonar-context isGroup to true', () => {
    const { byId } = runMerge();
    expect(byId.get('sonar-context')!.isGroup).toBe(true);
  });

  it('clears the passthrough positional arguments', () => {
    const { byId } = runMerge();
    expect(byId.get('sonar-context')!.arguments).toHaveLength(0);
  });

  it('sets sonar-context children to top-level CAG group IDs', () => {
    const { byId } = runMerge();
    const children = byId.get('sonar-context')!.children;
    expect(children).toContain('sonar-context-tool');
    expect(children).toContain('sonar-context-guidelines');
    expect(children).toContain('sonar-context-dependencies');
    expect(children).toContain('sonar-context-architecture');
    expect(children).toContain('sonar-context-navigation');
  });

  it('adds group entries for each top-level CAG command', () => {
    const { byId } = runMerge();
    expect(byId.has('sonar-context-tool')).toBe(true);
    expect(byId.has('sonar-context-guidelines')).toBe(true);
    expect(byId.has('sonar-context-navigation')).toBe(true);
  });

  it('marks groups as isGroup: true and leaf commands as isGroup: false', () => {
    const { byId } = runMerge();
    expect(byId.get('sonar-context-guidelines')!.isGroup).toBe(true);
    expect(byId.get('sonar-context-guidelines-get')!.isGroup).toBe(false);
  });

  it('assigns correct depth relative to sonar-context', () => {
    const { byId } = runMerge();
    // sonar-context is depth 1, so its CAG children are depth 2
    expect(byId.get('sonar-context-tool')!.depth).toBe(2);
    // leaf commands are depth 3
    expect(byId.get('sonar-context-guidelines-get')!.depth).toBe(3);
    expect(byId.get('sonar-context-tool-start')!.depth).toBe(3);
  });

  it('assigns correct parentId to CAG subcommands', () => {
    const { byId } = runMerge();
    expect(byId.get('sonar-context-tool')!.parentId).toBe('sonar-context');
    expect(byId.get('sonar-context-tool-integrate')!.parentId).toBe('sonar-context-tool');
    expect(byId.get('sonar-context-guidelines-get')!.parentId).toBe('sonar-context-guidelines');
  });

  it('marks non-auth lifecycle commands as requiresAuth: false', () => {
    const { byId } = runMerge();
    for (const id of [
      'sonar-context-tool-start',
      'sonar-context-tool-stop',
      'sonar-context-tool-status',
      'sonar-context-tool-print-skill',
    ]) {
      expect(byId.get(id)!.requiresAuth).toBe(false);
    }
  });

  it('marks all other CAG commands as requiresAuth: true', () => {
    const { byId } = runMerge();
    for (const id of [
      'sonar-context-guidelines-get',
      'sonar-context-dependencies-check',
      'sonar-context-architecture-get-current',
      'sonar-context-navigation-search-signatures',
      'sonar-context-tool-integrate',
    ]) {
      expect(byId.get(id)!.requiresAuth).toBe(true);
    }
  });

  it('maps CAG options to ClidocOption shape', () => {
    const { byId } = runMerge();
    const getCmd = byId.get('sonar-context-guidelines-get')!;
    expect(getCmd.options.length).toBeGreaterThan(0);
    const categoriesOpt = getCmd.options.find((o) => o.long === '--categories');
    expect(categoriesOpt).toBeDefined();
    expect(categoriesOpt!.type).toBe('string');
    expect(categoriesOpt!.required).toBe(false);
  });

  it('sets fullName to the space-joined path', () => {
    const { byId } = runMerge();
    expect(byId.get('sonar-context-navigation-search-signatures')!.fullName).toBe(
      'sonar context navigation search-signatures',
    );
  });

  it('throws when sonar-context entry is missing from allCommands', () => {
    expect(() => mergeCagTree(fixtureTree, [])).toThrow('sonar-context entry not found');
  });

  it('adds all expected navigation subcommands', () => {
    const { byId } = runMerge();
    const expected = [
      'sonar-context-navigation-search-signatures',
      'sonar-context-navigation-search-bodies',
      'sonar-context-navigation-get-source',
      'sonar-context-navigation-trace-callers',
      'sonar-context-navigation-trace-callees',
      'sonar-context-navigation-get-type-hierarchy',
      'sonar-context-navigation-get-references',
    ];
    for (const id of expected) {
      expect(byId.has(id)).toBe(true);
    }
  });
});

describe('buildCagFlags', () => {
  it('formats a long-only flag with value', () => {
    expect(buildCagFlags({ long: 'pattern', value_name: 'PATTERN', required: true })).toBe(
      '--pattern <PATTERN>',
    );
  });

  it('formats a boolean flag (no value_name)', () => {
    expect(buildCagFlags({ long: 'json', required: false })).toBe('--json');
  });

  it('formats a flag with short alias', () => {
    expect(buildCagFlags({ long: 'verbose', short: 'v', required: false })).toBe('-v, --verbose');
  });

  it('marks variadic options with an ellipsis', () => {
    expect(
      buildCagFlags({
        long: 'categories',
        value_name: 'CATEGORIES',
        num_args: '1+',
        required: false,
      }),
    ).toBe('--categories <CATEGORIES>...');
  });
});

describe('mapCagOptions', () => {
  it('reports boolean type when value_name is absent (real fixture --json)', () => {
    const opts = mapCagOptions([{ long: 'json', required: false, default: 'false' }]);
    expect(opts).toHaveLength(1);
    expect(opts[0].type).toBe('boolean');
    expect(opts[0].flags).toBe('--json');
  });

  it('reports string type for value-taking options', () => {
    const opts = mapCagOptions([{ long: 'workspace', value_name: 'WORKSPACE', required: false }]);
    expect(opts[0].type).toBe('string');
    expect(opts[0].flags).toBe('--workspace <WORKSPACE>');
  });
});

describe('CAG_NON_AUTH_FULL_NAMES', () => {
  it('contains the four daemon lifecycle commands', () => {
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context tool start')).toBe(true);
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context tool stop')).toBe(true);
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context tool status')).toBe(true);
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context tool print-skill')).toBe(true);
  });

  it('does not contain commands that require SonarQube access', () => {
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context guidelines get')).toBe(false);
    expect(CAG_NON_AUTH_FULL_NAMES.has('sonar context tool integrate')).toBe(false);
  });
});
