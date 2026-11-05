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

import type { InitOutcome } from '@/commands/init/init-outcome.ts';
import { renderProjectDashboards } from '@/commands/init/output.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const AUTH = { serverUrl: 'https://sonarcloud.io/' } as ResolvedAuth;
const ROOT = '/repo';
const URL = (key: string) => `https://sonarcloud.io/project/overview?id=${key}`;

function render(outcome: InitOutcome): string[] {
  const console = new FakeConsole();
  renderProjectDashboards(outcome, AUTH, console);
  return console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
}

describe('renderProjectDashboards', () => {
  it.each<[string, InitOutcome, string[]]>([
    [
      'an already set up directory',
      { path: 'complete', projectRoot: ROOT, projectKeys: ['k'] },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a monorepo with several projects',
      { path: 'complete', projectRoot: ROOT, projectKeys: ['a', 'b'] },
      [`Project dashboard (a): ${URL('a')}`, `Project dashboard (b): ${URL('b')}`],
    ],
    [
      'a linked existing project',
      { path: 'link-existing', projectRoot: ROOT, remote: 'r', projectKey: 'k', linked: true },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a bound new project',
      { path: 'bound-new', projectRoot: ROOT, remote: 'r', repositorySlug: 'o/r', projectKey: 'k' },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a created or mapped unbound project',
      { path: 'unbound-new', projectRoot: ROOT, projectKey: 'k' },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a project key that needs escaping',
      { path: 'unbound-new', projectRoot: ROOT, projectKey: 'a b' },
      [`Project dashboard: ${URL('a%20b')}`],
    ],
  ])('prints the link for %s', (_name, outcome, expected) => {
    expect(render(outcome)).toEqual(expected);
  });

  it.each<[string, InitOutcome]>([
    ['a declined creation', { path: 'unbound-new', projectRoot: ROOT, declined: true }],
    [
      'a link that was selected but not run',
      { path: 'link-existing', projectRoot: ROOT, remote: 'r', projectKey: 'k' },
    ],
    [
      'a binding that was selected but not run',
      { path: 'bound-new', projectRoot: ROOT, remote: 'r', repositorySlug: 'o/r' },
    ],
  ])('prints nothing for %s', (_name, outcome) => {
    expect(render(outcome)).toEqual([]);
  });
});
