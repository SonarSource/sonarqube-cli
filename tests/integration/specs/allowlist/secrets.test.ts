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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { IS_WINDOWS, TestHarness } from '../../harness';

describe('allowlist secrets show', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'lists an empty allowlist when binary is installed, with no authentication set up',
    async () => {
      // No harness.withAuth(...) call: this doubles as proof the command needs
      // no authentication or network setup before running the binary.
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('allowlist secrets show');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Allowlist is empty');
    },
    { timeout: 15000 },
  );

  it(
    'auto-installs sonar-secrets and lists the allowlist when binary is absent',
    async () => {
      await harness.newFakeBinariesServer().start();

      const result = await harness.run('allowlist secrets show');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Allowlist is empty');
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
    },
    { timeout: 30000 },
  );

  it(
    'reports an unknown subcommand with a "Did you mean?" suggestion',
    async () => {
      const result = await harness.run('allowlist secrets shw');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("error: unknown command 'shw'");
      expect(output).toContain('(Did you mean show?)');
    },
    { timeout: 15000 },
  );
});

describe('allowlist secrets add', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    // harness.run() gives the child process no stdin at all, so this exercises the real,
    // unmocked non-TTY path. The TTY-allowed path is covered separately below via a real pty
    // (also unit-tested directly in tests/unit/commands/allowlist/secrets/add.test.ts).
    'refuses to run without a real interactive terminal, and never installs or invokes the binary',
    async () => {
      const result = await harness.run('allowlist secrets add');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'sonar allowlist secrets add requires a human at an interactive terminal; it cannot be run by an agent or script.',
      );
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 15000 },
  );

  it.skipIf(IS_WINDOWS)(
    // Real pty via harness.runWithRealTty() (script(1) — no Windows equivalent, hence the
    // skip). Proves the TTY gate genuinely passes control to the real binary end-to-end, not
    // just that our own code would call it (that part is what the unit test mocks and checks).
    // Empty stdin makes the real binary's own prompt fail deterministically, which is enough to
    // prove it was reached: the refusal test above proves what happens when it is NOT reached,
    // so seeing sonar-secrets-cli's own prompt text here — not our refusal message — is the
    // proof this test exists for.
    'with a real TTY, passes the gate and lets the real binary run interactively',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.runWithRealTty('allowlist secrets add');

      const output = result.stdout + result.stderr;
      expect(output).toContain('Enter secret value to add to allowlist');
      expect(output).not.toContain('requires a human at an interactive terminal');
      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );
});
