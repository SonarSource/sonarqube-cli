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

import { TestHarness } from '../../harness';

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

describe('allowlist secrets remove', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    // No entry to seed a success case with: `add` (CLI-1185, #923) has a TTY gate the harness
    // can never satisfy, so this exercises the one path reachable here — the real binary's own
    // "not found" exit — which still proves the key and exit code are forwarded correctly
    // end-to-end.
    'forwards the exit code when the binary reports the key was not found',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('allowlist secrets remove nonexistent-key');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No entry found with key: nonexistent-key');
    },
    { timeout: 15000 },
  );
});

describe('allowlist secrets clear', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each(['allowlist secrets clear', 'allowlist secrets clear --force'])(
    'on an empty allowlist, exits 0 and lets the binary report it is already empty (%s)',
    async (command) => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run(command);

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Allowlist is already empty');
    },
    { timeout: 15000 },
  );

  it(
    // Seeds one real entry via the fixture binary directly (bypassing our own `add`, which has
    // a TTY gate the harness can never satisfy — CLI-1185, #923) so this exercises the
    // security-relevant case: the binary's own confirm-or-force gate refusing a non-interactive
    // `clear` when there is something to lose. No code of ours is involved in that refusal —
    // inherited stdio means this exact wording is sonar-secrets-cli's own output.
    'without --force, lets the binary refuse non-interactively when entries exist',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      await seedAllowlistEntry(harness, 'seed-key', 'seed-secret-value');

      const result = await harness.run('allowlist secrets clear');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('use --force to skip');
    },
    { timeout: 15000 },
  );
});

/**
 * Adds one entry to the allowlist by invoking the real fixture binary directly, bypassing our
 * own `add` (which has a TTY gate the test harness can never satisfy — CLI-1185, #923). Spawns
 * with the harness's own composed environment, not the test runner's ambient one, so it writes
 * to the exact same isolated allowlist the CLI-under-test will read via `harness.run(...)`.
 * `harness.env()` also performs the harness's lazy setup (writing state.json and copying the
 * fixture binary into place), so no separate throwaway CLI call is needed to trigger it first.
 */
async function seedAllowlistEntry(
  harness: TestHarness,
  key: string,
  secret: string,
): Promise<void> {
  const env = harness.env();
  const binaryPath = harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).path;
  const proc = Bun.spawn([binaryPath, 'allowlist', 'add', '--key', key], {
    env,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.stdin.write(`${secret}\n`);
  await proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to seed allowlist entry, sonar-secrets exited with code ${exitCode}`);
  }
}
