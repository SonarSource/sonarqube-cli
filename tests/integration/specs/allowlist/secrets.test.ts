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

const FAKE_SERVER = 'http://localhost:19999';
const GITHUB_TEST_TOKEN = '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';
const EXIT_CODE_SECRETS_FOUND = 51;

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
    'refuses to run without a real interactive terminal, and never installs or invokes the binary',
    async () => {
      const result = await harness.run('allowlist secrets add');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'sonar allowlist secrets add requires a human at an interactive terminal; it cannot be run by an agent or script.',
      );
      expect(result.stdout + result.stderr).toContain(
        'Coding agents cannot add allowlist entries on your behalf.',
      );
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 15000 },
  );

  it.skipIf(IS_WINDOWS)(
    // Empty stdin fails the binary's own prompt, so seeing that prompt is proof the gate let it run.
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

describe('allowlist secrets remove', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'forwards the exit code when the binary reports the key was not found',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('allowlist secrets remove nonexistent-key');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No entry found with key: nonexistent-key');
    },
    { timeout: 15000 },
  );

  it(
    // Full round trip against a real, seeded entry: proves `remove` actually removes it from
    // the allowlist the binary reads, not just that the CLI forwards a key string.
    'removes a real, seeded entry, and it no longer shows up in the allowlist afterward',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      await seedAllowlistEntry(harness, 'roundtrip-key', 'roundtrip-secret-value');

      const removeResult = await harness.run('allowlist secrets remove roundtrip-key');
      expect(removeResult.exitCode).toBe(0);
      expect(removeResult.stdout + removeResult.stderr).toContain(
        'Removed entry with key: roundtrip-key',
      );

      const showResult = await harness.run('allowlist secrets show');
      expect(showResult.stdout + showResult.stderr).toContain('Allowlist is empty');
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
    // Seeds one real entry via the fixture binary directly to exercise the security-relevant
    // case: the binary's own confirm-or-force gate refusing a non-interactive clear when
    // there is something to lose. This is a critical security check that must pass even when
    // our wrapper isn't involved. Inherited stdio means the output is sonar-secrets-cli's own.
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

  it.skipIf(IS_WINDOWS)(
    'without --force at a real terminal, shows exactly one confirmation prompt and clears on "y"',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      await seedAllowlistEntry(harness, 'prompt-key', 'prompt-secret-value');

      const result = await harness.runWithRealTty('allowlist secrets clear', {
        responses: [{ waitFor: 'Are you sure?', send: 'y\n' }],
        timeoutMs: 10000,
      });

      const output = result.stdout + result.stderr;
      expect(output.split('Are you sure?')).toHaveLength(2);
      expect(output).toContain('Cleared 1 entry from allowlist');
      expect(result.exitCode).toBe(0);

      const showResult = await harness.run('allowlist secrets show');
      expect(showResult.stdout + showResult.stderr).toContain('Allowlist is empty');
    },
    { timeout: 15000 },
  );

  it(
    // Full round trip against a real, seeded entry: proves `clear --force` actually empties
    // the allowlist the binary reads, not just that the CLI forwards the flag.
    'clears a real, seeded entry with --force, and the allowlist is empty afterward',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      await seedAllowlistEntry(harness, 'roundtrip-key', 'roundtrip-secret-value');

      const clearResult = await harness.run('allowlist secrets clear --force');
      expect(clearResult.exitCode).toBe(0);
      expect(clearResult.stdout + clearResult.stderr).toContain('Cleared 1 entry from allowlist');

      const showResult = await harness.run('allowlist secrets show');
      expect(showResult.stdout + showResult.stderr).toContain('Allowlist is empty');
    },
    { timeout: 15000 },
  );
});

describe('allowlist secrets with analyze secrets', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each([
    ['remove', 'allowlist secrets remove analysis-key'],
    ['clear --force', 'allowlist secrets clear --force'],
  ])(
    'does not report an allowlisted secret, and reports it again after %s',
    async (_label, allowlistCommand) => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      await seedAllowlistEntry(harness, 'analysis-key', GITHUB_TEST_TOKEN);

      const allowlisted = await harness.run('analyze secrets secrets.js');
      expect(allowlisted.exitCode).toBe(0);
      expect(allowlisted.stdout + allowlisted.stderr).toContain('No secrets found');

      const allowlistResult = await harness.run(allowlistCommand);
      expect(allowlistResult.exitCode).toBe(0);

      const reported = await harness.run('analyze secrets secrets.js');
      expect(reported.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      expect(reported.stdout + reported.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );
});

/**
 * Adds one entry to the allowlist by invoking the real fixture binary directly.
 * Spawns with the harness's own composed environment (via `harness.env()`) so the entry
 * lands in the exact same isolated allowlist the CLI-under-test will read via `harness.run(...)`.
 * `harness.env()` also performs lazy setup (writing state.json, copying the fixture binary),
 * so no separate throwaway CLI call is needed to trigger it first.
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
