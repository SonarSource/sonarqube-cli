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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Command } from 'commander';

import { createCommandTree } from '@/commands/command-tree.ts';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import { setFormattedOutputMode } from '@/core/ui';

import { version as CURRENT_VERSION } from '../../../../package.json';

const originalEnvForNotify = { ...process.env };
const tempHome = mkdtempSync(join(tmpdir(), 'sonar-update-notify-'));
process.env.SONAR_USER_HOME = tempHome;

// Building the tree registers every .showUpdateNotification() into the root's
// UpdateNotifier — reuse that same instance here rather than constructing a fresh one.
const COMMAND_TREE = createCommandTree();
const updateNotifier = COMMAND_TREE.updateNotifier;

function resolveCommand(path: string[]): Command {
  let current: Command = COMMAND_TREE;
  for (const segment of path) {
    const next = current.commands.find((command) => command.name() === segment);
    if (!next) {
      throw new Error(`Unknown command segment: ${segment}`);
    }
    current = next;
  }
  return current;
}

describe('update notification eligibility', () => {
  it('allows auth commands', () => {
    expect(updateNotifier.isEligible(resolveCommand(['auth', 'status']))).toBe(true);
  });

  it('allows analyze and list data commands', () => {
    expect(updateNotifier.isEligible(resolveCommand(['analyze', 'agentic']))).toBe(true);
    expect(updateNotifier.isEligible(resolveCommand(['list', 'issues']))).toBe(true);
    expect(updateNotifier.isEligible(resolveCommand(['list', 'projects']))).toBe(true);
  });

  it('blocks integrate when non-interactive', () => {
    const command = resolveCommand(['integrate', 'claude']);
    command.setOptionValue('nonInteractive', true);
    expect(updateNotifier.shouldSuppress(command)).toBe(true);
    expect(updateNotifier.isEligible(command)).toBe(true);
  });

  it('blocks api, context, and hook commands', () => {
    expect(updateNotifier.isEligible(resolveCommand(['api']))).toBe(false);
    expect(updateNotifier.isEligible(resolveCommand(['context']))).toBe(false);
    expect(updateNotifier.isEligible(resolveCommand(['hook', 'git-pre-commit']))).toBe(false);
    expect(updateNotifier.isEligible(resolveCommand(['config', 'telemetry']))).toBe(false);
    expect(updateNotifier.isEligible(resolveCommand(['system', 'reset']))).toBe(false);
  });
});

describe('update notification suppression', () => {
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStderrIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    process.env = { ...originalEnvForNotify, SONAR_USER_HOME: tempHome };
    delete process.env.CI;
    delete process.env[TELEMETRY_FLUSH_MODE_ENV];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    setFormattedOutputMode(false);
  });

  afterEach(() => {
    process.env = { ...originalEnvForNotify, SONAR_USER_HOME: tempHome };
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: originalStderrIsTTY,
    });
    setFormattedOutputMode(false);
  });

  it('suppresses in CI and machine-readable modes', () => {
    const command = resolveCommand(['auth', 'status']);
    process.env.CI = 'true';
    expect(updateNotifier.shouldSuppress(command)).toBe(true);

    delete process.env.CI;
    setFormattedOutputMode(true);
    expect(updateNotifier.shouldSuppress(command)).toBe(true);
  });

  it('suppresses list issues when format is json', () => {
    const command = resolveCommand(['list', 'issues']);
    expect(updateNotifier.shouldSuppress(command)).toBe(true);

    command.setOptionValue('format', 'table');
    expect(updateNotifier.shouldSuppress(command)).toBe(false);
  });

  it('suppresses system status when --json is set', () => {
    const command = resolveCommand(['system', 'status']);
    command.setOptionValue('json', true);
    expect(updateNotifier.shouldSuppress(command)).toBe(true);
  });
});

function fetchUrlString(url: string | URL | Request): string {
  if (typeof url === 'string') {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  return url.url;
}

describe('updateNotifier.maybeNotify', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnvForNotify, SONAR_USER_HOME: tempHome };
    delete process.env.CI;
    delete process.env[TELEMETRY_FLUSH_MODE_ENV];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    setFormattedOutputMode(false);
    process.exitCode = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL | Request) => {
      const fetchUrl = fetchUrlString(url);
      if (fetchUrl.endsWith('stable.version')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('99.0.0.241\n'),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${fetchUrl}`));
    }) as typeof fetch);
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    rmSync(join(tempHome, 'sonarqube-cli', 'state.json'), { force: true });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setFormattedOutputMode(false);
  });

  function notificationOutput(): string {
    const stdout = (stdoutSpy.mock.calls as string[][]).map((call) => call[0] ?? '').join('');
    const stderr = (stderrSpy.mock.calls as string[][]).map((call) => call[0] ?? '').join('');
    return `${stdout}${stderr}`;
  }

  it('prints a stderr notice when a newer version is available', async () => {
    await updateNotifier.maybeNotify(resolveCommand(['auth', 'status']));

    const output = notificationOutput();
    const [major, minor, patch] = CURRENT_VERSION.split('.');
    expect(output).toContain(
      `A new version of SonarQube CLI is available: ${major}.${minor}.${patch} → 99.0.0`,
    );
    expect(output).toContain('Run `sonar update` to update to v99.0.0');
  });

  it('persists fetch metadata in state', async () => {
    await updateNotifier.maybeNotify(resolveCommand(['auth', 'status']));

    const state = JSON.parse(
      readFileSync(join(tempHome, 'sonarqube-cli', 'state.json'), 'utf8'),
    ) as {
      config: {
        updateCheck?: {
          latestVersion?: string;
          lastCheckedAt?: string;
        };
      };
    };
    expect(state.config.updateCheck?.latestVersion).toBe('99.0.0.241');
    expect(state.config.updateCheck?.lastCheckedAt).toBeDefined();
  });

  it('notifies on every eligible command when an update is available', async () => {
    const command = resolveCommand(['auth', 'status']);

    await updateNotifier.maybeNotify(command);
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    await updateNotifier.maybeNotify(command);

    const output = notificationOutput();
    expect(output).toContain('A new version of SonarQube CLI is available');
    expect(output).toContain('Run `sonar update` to update to v99.0.0');
  });

  it('does not re-fetch within 24h after a failed check', async () => {
    const command = resolveCommand(['auth', 'status']);
    fetchSpy.mockImplementation(() => Promise.reject(new Error('offline')));

    await updateNotifier.maybeNotify(command);
    expect(fetchSpy.mock.calls).toHaveLength(1);

    // The failed attempt is recorded, so the next command must not hit the
    // network again (which would stall on the fetch timeout).
    await updateNotifier.maybeNotify(command);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });
});
