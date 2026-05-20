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

// Integration tests for `sonar context <action>` — the passthrough wrapper to
// the locally-installed sonar-context-augmentation binary.

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../harness';

// CAG stub spawn + temp-dir teardown on Windows can exceed Bun's default hook timeout.
setDefaultTimeout(30_000);

interface CagInvocation {
  argv: string[];
  env: { SONAR_TOKEN?: string };
}

function readInvocations(harness: TestHarness): CagInvocation[] {
  const file = harness.cliHome.file('cag-invocations.jsonl');
  if (!file.exists()) return [];
  return file
    .asText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CagInvocation);
}

describe('sonar context passthrough', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each([
    [
      'forwards args verbatim and injects SONAR_TOKEN from auth',
      'context get-source --file foo.ts --line 42',
      ['get-source', '--file', 'foo.ts', '--line', '42'],
    ],
    [
      'forwards <action> --help to CAG with SONAR_TOKEN injected',
      'context get-source --help',
      ['get-source', '--help'],
    ],
  ])(
    '%s',
    async (_title, command, expectedArgv) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), 'expected-token');
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(command);

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].argv).toEqual(expectedArgv);
      expect(invocations[0].env.SONAR_TOKEN).toBe('expected-token');
    },
    { timeout: 30000 },
  );

  it(
    'fails with a helpful message when the CAG binary is not installed',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not installed');
      expect(result.stderr).toContain('sonar integrate');
    },
    { timeout: 30000 },
  );

  it(
    'requires authentication',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not authenticated');
    },
    { timeout: 30000 },
  );

  it.each([
    ['forwards --help to CAG without requiring authentication', 'context --help', ['--help']],
    ['forwards -h to CAG without requiring authentication', 'context -h', ['-h']],
    ['forwards --help to CAG when no action is given (bare sonar context)', 'context', ['--help']],
  ])(
    '%s',
    async (_title, command, expectedArgv) => {
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(command);

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].argv).toEqual(expectedArgv);
      expect(invocations[0].env.SONAR_TOKEN).toBe('');
    },
    { timeout: 30000 },
  );

  it(
    'fails with a helpful message when CAG is not installed and --help is requested',
    async () => {
      const result = await harness.run('context --help');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not installed');
      expect(result.stderr).toContain('sonar integrate');
    },
    { timeout: 30000 },
  );
});
