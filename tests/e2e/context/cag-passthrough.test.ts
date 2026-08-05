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

/**
 * Offline e2e for `sonar context` passthrough behaviors against the real
 * CAG binary: unauthenticated-action error path, bare-invocation falls
 * through to CAG's help, and child exit-code propagation.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../integration/harness';
import {
  ALLOWLISTED_CAG_ORG_KEY,
  buildCompressibleGradleStdout,
  SEEDED_PROJECT_KEY,
  seedState,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;
const PASSTHROUGH_TIMEOUT_MS = 30_000;
const TEST_TOKEN = 'offline-e2e-token';

interface ClaudeHookCompressionOutput {
  hookSpecificOutput: {
    hookEventName: string;
    updatedToolOutput: {
      stdout: string;
      stderr: string;
      interrupted: boolean;
      isImage: boolean;
      noOutputExpected: boolean;
    };
  };
}

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation passthrough behaviors (offline, real binary)', () => {
  let harness: TestHarness;
  let server: FakeSonarQubeServer;
  let authEnv: Record<string, string>;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    server = await harness
      .newFakeServer()
      .withAuthToken(TEST_TOKEN)
      .withProject(SEEDED_PROJECT_KEY)
      .withCagEntitlement(ALLOWLISTED_CAG_ORG_KEY, `${ALLOWLISTED_CAG_ORG_KEY}-uuid-v4`)
      .start();
    seedState(harness, {
      skills: [
        {
          agentId: 'claude-code',
          projectRoot: harness.cwd.path,
          orgKey: ALLOWLISTED_CAG_ORG_KEY,
          serverUrl: server.baseUrl(),
        },
      ],
    });
    authEnv = {
      SONARQUBE_CLI_TOKEN: TEST_TOKEN,
      SONARQUBE_CLI_SERVER: server.baseUrl(),
      SONARQUBE_CLI_ORG: ALLOWLISTED_CAG_ORG_KEY,
    };
    const install = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(install.exitCode, install.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('fails with a clear CLI error when invoking a non-help action without auth', async () => {
    const result = await harness.run('context tool status', { timeoutMs: PASSTHROUGH_TIMEOUT_MS });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Not authenticated');
  });

  it('treats a bare `sonar context` (no action) as a help request and exits 0', async () => {
    const result = await harness.run('context', { timeoutMs: PASSTHROUGH_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Usage:');
  });

  it('forwards Claude hook help to the real CAG binary', async () => {
    const result = await harness.run('context __hook Claude --help', {
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
      extraEnv: authEnv,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Claude Code hook entry point');
  });

  it('forwards a Claude Bash hook payload to the real CAG binary and applies Gradle compression', async () => {
    const result = await harness.run('context __hook Claude', {
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
      extraEnv: {
        ...authEnv,
        RUST_LOG: 'debug',
        SONAR_LOG_LEVEL: 'DEBUG',
      },
      stdin: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: './gradlew build', description: 'Run Gradle build' },
        tool_response: {
          stdout: buildCompressibleGradleStdout(),
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      }),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('unrecognized subcommand');
    const diagnostics = result.stdout.includes('hookSpecificOutput')
      ? undefined
      : await buildCagHookDiagnostics(harness, server, result);
    expect(result.stdout, diagnostics).toContain('hookSpecificOutput');

    const output = JSON.parse(result.stdout) as ClaudeHookCompressionOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.updatedToolOutput.stdout).toContain('BUILD SUCCESSFUL');
    expect(output.hookSpecificOutput.updatedToolOutput.stdout).toContain(
      '10 actionable tasks: 10 up-to-date',
    );
    expect(output.hookSpecificOutput.updatedToolOutput.stdout).toContain(
      'output reduced to essential parts',
    );
    expect(output.hookSpecificOutput.updatedToolOutput.stdout).toContain(
      'sonar context distillate restore',
    );
    expect(output.hookSpecificOutput.updatedToolOutput.stdout).not.toContain(
      ':module0:compileJava',
    );
    expect(output.hookSpecificOutput.updatedToolOutput.stderr).toBe('');
    expect(output.hookSpecificOutput.updatedToolOutput.interrupted).toBe(false);
    expect(output.hookSpecificOutput.updatedToolOutput.isImage).toBe(false);
    expect(output.hookSpecificOutput.updatedToolOutput.noOutputExpected).toBe(false);
  });

  it("propagates the real binary's non-zero exit code to the parent process", async () => {
    const result = await harness.run('context bogus-subcommand', {
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
      extraEnv: authEnv,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unrecognized subcommand');
  });
});

async function buildCagHookDiagnostics(
  harness: TestHarness,
  server: FakeSonarQubeServer,
  result: { exitCode: number; stdout: string; stderr: string },
): Promise<string> {
  return [
    'CAG hook did not return hookSpecificOutput.',
    '',
    `exitCode: ${result.exitCode}`,
    `stdout: ${JSON.stringify(result.stdout)}`,
    `stderr: ${JSON.stringify(result.stderr)}`,
    `cwd: ${harness.cwd.path}`,
    `home: ${harness.userHome.path}`,
    '',
    await probeFakeCloudApiAlias(server),
    '',
    'Fake SonarQube requests:',
    formatRecordedRequests(server),
    '',
    'CAG daemon logs:',
    collectDaemonLogTails(harness),
  ].join('\n');
}

async function probeFakeCloudApiAlias(server: FakeSonarQubeServer): Promise<string> {
  const probeUrl = `${server.baseUrl().replace('://localhost:', '://api.localhost:')}/api/server/version`;
  try {
    const response = await fetch(probeUrl);
    const body = await response.text();
    return `api.localhost probe: ${probeUrl} -> ${response.status} ${body.slice(0, 200)}`;
  } catch (err) {
    return `api.localhost probe: ${probeUrl} -> ${(err as Error).message}`;
  }
}

function formatRecordedRequests(server: FakeSonarQubeServer): string {
  const requests = server.getRecordedRequests();
  if (requests.length === 0) {
    return '(none)';
  }
  return requests
    .map((request, index) => {
      const query = new URLSearchParams(request.query).toString();
      const suffix = query ? `?${query}` : '';
      return `${index + 1}. ${request.method} ${request.path}${suffix}`;
    })
    .join('\n');
}

function collectDaemonLogTails(harness: TestHarness): string {
  const projectsDir = join(harness.userHome.path, '.sonar', 'context-augmentation', 'projects');
  if (!existsSync(projectsDir)) {
    return `(no CAG projects directory at ${projectsDir})`;
  }

  const daemonLogs = findDaemonLogs(projectsDir);
  if (daemonLogs.length === 0) {
    return `(no daemon.log files under ${projectsDir})`;
  }

  return daemonLogs.map((logPath) => `--- ${logPath}\n${readTail(logPath, 16_000)}`).join('\n');
}

function findDaemonLogs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of safeReadDir(dir)) {
    const path = join(dir, entry);
    const stat = safeStat(path);
    if (!stat) {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...findDaemonLogs(path));
    } else if (entry === 'daemon.log') {
      results.push(path);
    }
  }
  return results;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function readTail(path: string, maxBytes: number): string {
  try {
    const content = readFileSync(path, 'utf-8');
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch (err) {
    return `(failed to read ${path}: ${(err as Error).message})`;
  }
}
