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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'bun:test';

import { commitFile, git, initGitRepo } from '../integration/specs/hook/git-test-helpers.js';

const root = mkdtempSync(join(tmpdir(), 'git fixtures with spaces '));
const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
afterAll(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  rmSync(root, { recursive: true, force: true });
});

it('isolates fresh fixtures and preserves configuration and branch behavior on reinitialization', () => {
  const hooks = join(root, 'global hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const globalConfig = join(root, 'global-config');
  git(['config', '--file', globalConfig, 'core.hooksPath', hooks], root);
  git(['config', '--file', globalConfig, 'init.defaultBranch', 'fixture-main'], root);
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  const first = join(root, 'first repo');
  const second = join(root, 'second repo');
  initGitRepo(first);
  initGitRepo(second);
  expect(git(['symbolic-ref', '--short', 'HEAD'], first)).toBe('fixture-main');
  const sha = commitFile(first, 'file with spaces.txt', 'fixture');
  expect(git(['show', '-s', '--format=%an <%ae>'], first)).toBe('Test User <test@example.com>');
  git(['config', 'user.name', 'Independent User'], second);
  expect(git(['config', 'user.name'], first)).toBe('Test User');
  expect(git(['config', 'user.name'], second)).toBe('Independent User');

  git(['config', 'fixture.keep', 'preserved'], first);
  git(['config', 'user.name', 'Reset Me'], first);
  git(['config', 'user.email', 'reset@example.com'], first);
  git(['config', 'core.hooksPath', hooks], first);
  git(['branch', '-m', 'retained-branch'], first);
  initGitRepo(first);
  expect(git(['config', 'fixture.keep'], first)).toBe('preserved');
  expect(git(['config', 'user.name'], first)).toBe('Test User');
  expect(git(['config', 'user.email'], first)).toBe('test@example.com');
  expect(git(['symbolic-ref', '--short', 'HEAD'], first)).toBe('retained-branch');
  expect(git(['rev-parse', 'HEAD'], first)).toBe(sha);
  expect(commitFile(first, 'another file.txt', 'fixture')).not.toBe(sha);
});
