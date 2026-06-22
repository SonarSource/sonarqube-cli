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

import { InvalidOptionError } from '../../../../../../src/cli/commands/_common/error.js';
import type { IntegrateGitOptions } from '../../../../../../src/cli/commands/integrate/git/options.js';
import {
  createDepRisksSubfeature,
  createSecretsSubfeature,
} from '../../../../../../src/cli/commands/integrate/git/tools/git-integration-subfeatures.js';

type PartialInvocation = {
  options?: Partial<IntegrateGitOptions>;
  nonInteractive?: boolean;
  scope?: 'project' | 'global';
};

function makeInvocation({
  options = {},
  nonInteractive = false,
  scope = 'project',
}: PartialInvocation = {}) {
  return {
    options,
    nonInteractive,
    scope,
    targetRoot: '/tmp',
    state: {} as never,
  };
}

describe('createSecretsSubfeature', () => {
  it('always installs with an explanatory message', () => {
    const sub = createSecretsSubfeature();
    expect(sub.shouldInstall!(makeInvocation())).toMatchObject({
      action: 'install',
      message: 'Secrets scan is required for other hook types and is enabled by default',
    });
  });
});

describe('createDepRisksSubfeature', () => {
  it('skips for global scope', () => {
    const sub = createDepRisksSubfeature();
    expect(sub.shouldInstall!(makeInvocation({ scope: 'global' }))).toMatchObject({
      action: 'skip',
    });
  });

  it('throws InvalidOptionError when --dependency-risks is set without a project key', () => {
    const sub = createDepRisksSubfeature();
    expect(() =>
      sub.shouldInstall!(makeInvocation({ options: { dependencyRisks: true } })),
    ).toThrow(InvalidOptionError);
  });

  it('skips with message when no project key is available', () => {
    const sub = createDepRisksSubfeature();
    const result = sub.shouldInstall!(makeInvocation());
    expect(result).toMatchObject({ action: 'skip' });
  });

  it('installs when --dependency-risks and project key are both set', () => {
    const sub = createDepRisksSubfeature();
    const result = sub.shouldInstall!(
      makeInvocation({ options: { dependencyRisks: true, project: 'my-project' } }),
    );
    expect(result).toMatchObject({ action: 'install' });
  });

  it('asks user when project key is set but --dependency-risks is not', () => {
    const sub = createDepRisksSubfeature();
    const result = sub.shouldInstall!(makeInvocation({ options: { project: 'my-project' } }));
    expect(result).toMatchObject({ action: 'ask' });
  });

  it('asks user in non-interactive mode when --dependency-risks is not set (installer converts ask+nonInteractive to install)', () => {
    const sub = createDepRisksSubfeature();
    const result = sub.shouldInstall!(
      makeInvocation({ options: { project: 'my-project' }, nonInteractive: true }),
    );
    expect(result).toMatchObject({ action: 'ask' });
  });
});
