/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integration tests for `sonar hook agent-session-start`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { CliResult } from '../../harness';
import { TestHarness } from '../../harness';
import { type CagInvocation, readCagInvocations } from '../../harness/cag-invocations';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_ORG_UUID = 'my-org-uuid';
const TEST_PROJECT = 'my-project';
const CAG_CONTEXT = 'CONDENSED VORTEX SKILL';
const EXPECTED_CONTEXT = `${CAG_CONTEXT}\n`;
const TEST_TIMEOUT = { timeout: 15000 };

interface SetupOptions {
  isVortexEntitled?: boolean;
  isScaEnabled?: boolean;
  isAuthenticated?: boolean;
  isProjectDiscoverable?: boolean;
  isCagInstalled?: boolean;
  cagStdout?: string;
  cagExitCode?: number;
}

describe('sonar hook agent-session-start', () => {
  let harness: TestHarness;
  let serverUrl: string;

  async function setup({
    isVortexEntitled = true,
    isScaEnabled = false,
    isAuthenticated = true,
    isProjectDiscoverable = true,
    isCagInstalled = true,
    cagStdout = CAG_CONTEXT,
    cagExitCode = 0,
  }: SetupOptions = {}): Promise<void> {
    const builder = harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(VALID_TOKEN)
      .withProject(TEST_PROJECT)
      .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, {
        allowed: isVortexEntitled,
        hasEntitlement: isVortexEntitled,
      });
    if (isScaEnabled) {
      builder.withScaEnabled(true);
    }
    serverUrl = (await builder.start()).baseUrl();

    if (isAuthenticated) {
      harness.withAuth(serverUrl, VALID_TOKEN, TEST_ORG);
    }
    if (isProjectDiscoverable) {
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${TEST_PROJECT}`,
          `sonar.organization=${TEST_ORG}`,
        ].join('\n'),
      );
    }
    if (isCagInstalled) {
      harness.state().withContextAugmentationBinaryInstalled({
        stdoutLine: cagStdout,
        initExitCode: cagExitCode,
      });
    }
  }

  function runHook(agent: string, stdin: object): Promise<CliResult> {
    return harness.runWithStdin(`hook agent-session-start --agent ${agent}`, JSON.stringify(stdin));
  }

  function cagSessionStartInvocations(): CagInvocation[] {
    return readCagInvocations(harness).filter((i) => i.argv[1] === 'print-session-start-context');
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // One entry per (agent, event) pair the hook supports. Cursor has no
  // context-carrying subagent event.
  for (const invocation of [
    {
      name: 'Claude SessionStart',
      agent: 'claude',
      stdin: (cwd: string) => ({ session_id: 'sess-1', cwd, hook_event_name: 'SessionStart' }),
      expected: {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: EXPECTED_CONTEXT },
      },
    },
    {
      name: 'Claude SubagentStart',
      agent: 'claude',
      stdin: (cwd: string) => ({ session_id: 'sess-1', cwd, hook_event_name: 'SubagentStart' }),
      expected: {
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: EXPECTED_CONTEXT },
      },
    },
    {
      name: 'Codex SessionStart',
      agent: 'codex',
      stdin: (cwd: string) => ({ session_id: 'sess-1', cwd, hook_event_name: 'SessionStart' }),
      expected: {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: EXPECTED_CONTEXT },
      },
    },
    {
      name: 'Codex SubagentStart',
      agent: 'codex',
      stdin: (cwd: string) => ({ session_id: 'sess-1', cwd, hook_event_name: 'SubagentStart' }),
      expected: {
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: EXPECTED_CONTEXT },
      },
    },
    {
      name: 'Copilot sessionStart',
      agent: 'copilot',
      stdin: (cwd: string) => ({
        sessionId: 'sess-1',
        cwd,
        timestamp: 1_767_225_600_000,
        source: 'startup',
      }),
      expected: { additionalContext: EXPECTED_CONTEXT },
    },
    {
      name: 'Copilot subagentStart',
      agent: 'copilot',
      stdin: (cwd: string) => ({ sessionId: 'sess-1', cwd, agentName: 'reviewer' }),
      expected: { additionalContext: EXPECTED_CONTEXT },
    },
    {
      name: 'Cursor sessionStart',
      agent: 'cursor',
      stdin: (cwd: string) => ({
        conversation_id: 'sess-1',
        workspace_roots: [cwd],
        hook_event_name: 'sessionStart',
      }),
      expected: { additional_context: EXPECTED_CONTEXT },
    },
  ]) {
    it(
      `reads the ${invocation.name} payload and emits that agent's envelope`,
      async () => {
        await setup();

        const result = await runHook(invocation.agent, invocation.stdin(harness.cwd.path));

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual(invocation.expected);
      },
      TEST_TIMEOUT,
    );
  }

  it(
    'passes the full connection context and --sca-enabled=true when SCA is enabled',
    async () => {
      await setup({ isScaEnabled: true });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      const invocations = cagSessionStartInvocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0].argv).toEqual([
        'tool',
        'print-session-start-context',
        '--sca-enabled=true',
      ]);
      expect(invocations[0].env).toMatchObject({
        SONAR_CONTEXT_PROJECT: TEST_PROJECT,
        SONAR_CONTEXT_ORGANIZATION: TEST_ORG,
        SONAR_CONTEXT_TOKEN: VALID_TOKEN,
        SONAR_CONTEXT_URL: serverUrl,
      });
      expect(invocations[0].env.SONAR_CONTEXT_WORKSPACE_ROOT).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'passes --sca-enabled=false when the server has no SCA endpoint',
    async () => {
      await setup();

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(cagSessionStartInvocations()[0].argv).toContain('--sca-enabled=false');
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output on an unknown agent, without invoking CAG',
    async () => {
      await setup();

      const result = await runHook('antigravity', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output on unparseable stdin',
    async () => {
      await setup();

      const result = await harness.runWithStdin(
        'hook agent-session-start --agent claude',
        'not json at all',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when not authenticated',
    async () => {
      await setup({ isAuthenticated: false });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when no project key can be discovered',
    async () => {
      await setup({ isProjectDiscoverable: false });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when the organization is not entitled to Vortex',
    async () => {
      await setup({ isVortexEntitled: false });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when the CAG binary is not installed',
    async () => {
      await setup({ isCagInstalled: false });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when CAG exits non-zero',
    async () => {
      await setup({ cagExitCode: 1 });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'exits 0 with no output when CAG produces no context',
    async () => {
      await setup({ cagStdout: '' });

      const result = await runHook('claude', {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});
