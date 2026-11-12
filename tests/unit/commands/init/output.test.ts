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
import { renderInitOutcome, renderProjectDashboards } from '@/commands/init/output.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const AUTH = { serverUrl: 'https://sonarcloud.io/' } as ResolvedAuth;
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
      { kind: 'complete', projectKeys: ['k'] },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a monorepo with several projects',
      { kind: 'complete', projectKeys: ['a', 'b'] },
      [`Project dashboard (a): ${URL('a')}`, `Project dashboard (b): ${URL('b')}`],
    ],
    [
      'a linked existing project',
      { kind: 'linked', projectKey: 'k' },
      [`Project dashboard: ${URL('k')}`],
    ],
    ['a bound new project', { kind: 'bound', projectKey: 'k' }, [`Project dashboard: ${URL('k')}`]],
    [
      'a created or mapped unbound project',
      { kind: 'unbound', projectKey: 'k' },
      [`Project dashboard: ${URL('k')}`],
    ],
    [
      'a project key that needs escaping',
      { kind: 'unbound', projectKey: 'a b' },
      [`Project dashboard: ${URL('a%20b')}`],
    ],
  ])('prints the link for %s', (_name, outcome, expected) => {
    expect(render(outcome)).toEqual(expected);
  });

  it('prints nothing for a declined creation', () => {
    expect(render({ kind: 'declined' })).toEqual([]);
  });

  it('prints nothing when the account has no organization', () => {
    expect(render({ kind: 'no-organization' })).toEqual([]);
  });

  it('prints the link of each root that ended configured, and none for the others', () => {
    expect(
      render({
        kind: 'monorepo',
        roots: [
          { path: 'a', kind: 'configured', projectKey: 'a' },
          { path: 'b', kind: 'linked', projectKey: 'b' },
          { path: 'c', kind: 'bound', projectKey: 'c' },
          { path: 'f', kind: 'unbound', projectKey: 'f' },
          { path: 'd', kind: 'skipped' },
          { path: 'e', kind: 'failed', reason: 'boom' },
        ],
      }),
    ).toEqual([
      `Project dashboard (a): ${URL('a')}`,
      `Project dashboard (b): ${URL('b')}`,
      `Project dashboard (c): ${URL('c')}`,
      `Project dashboard (f): ${URL('f')}`,
    ]);
  });
});

describe('renderInitOutcome', () => {
  it('renders a no-organization run without credentials and without any integrate hint', () => {
    const console = new FakeConsole();

    renderInitOutcome({ kind: 'no-organization' }, undefined, console);

    const printed = console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printed).toEqual(['No organization was created.']);
  });

  it('summarizes a monorepo run by outcome and explains how to resume', () => {
    const console = new FakeConsole();

    renderInitOutcome(
      {
        kind: 'monorepo',
        roots: [
          { path: 'api', kind: 'unbound', projectKey: 'api-key' },
          { path: 'web', kind: 'skipped' },
          { path: 'docs', kind: 'failed', reason: 'Key is taken\nChoose another key.' },
        ],
      },
      undefined,
      console,
    );

    const printed = console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printed.slice(0, 7)).toEqual([
      'Monorepo onboarding summary:',
      '  Configured (1):',
      '    api: api-key (created)',
      '  Skipped (1):',
      '    web',
      '  Failed (1):',
      '    docs: Key is taken\n      Choose another key.',
    ]);
    expect(printed).toHaveLength(8);
    expect(printed[7]).toContain("run 'sonar init --monorepo' again");
  });

  it('does not suggest resuming when every root is configured', () => {
    const console = new FakeConsole();

    renderInitOutcome(
      { kind: 'monorepo', roots: [{ path: '.', kind: 'configured', projectKey: 'k' }] },
      undefined,
      console,
    );

    const printed = console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printed.join('\n')).not.toContain('resume');
  });

  it('points to sonar link --monorepo when no root is mapped', () => {
    const console = new FakeConsole();

    renderInitOutcome({ kind: 'no-monorepo-roots' }, undefined, console);

    const printed = console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printed.join('\n')).toContain('sonar link --monorepo');
  });

  it('says in the summary when a root got a project bound to the repository', () => {
    const console = new FakeConsole();

    renderInitOutcome(
      { kind: 'monorepo', roots: [{ path: 'api', kind: 'bound', projectKey: 'api-key' }] },
      undefined,
      console,
    );

    const printed = console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printed).toContain('    api: api-key (created and bound to the repository)');
  });
});
