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

// Integration tests for `sonar hook devin-subagent-start`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { type CagInvocation, readCagInvocations } from '../../harness/cag-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_ORG_UUID = 'my-org-uuid';
const TEST_PROJECT = 'my-project';
const CAG_CONTEXT = 'CONDENSED VORTEX SKILL';
const ORIGINAL_TASK = 'Find every caller of parseConfig.\nReport file paths only.';
const TEST_TIMEOUT = { timeout: 15000 };

const TOOL_INPUT = {
  profile: 'subagent_explore',
  title: 'Find callers',
  task: ORIGINAL_TASK,
  is_background: false,
  extra: { nested: [1, 'two', null] },
};

interface SetupOptions {
  isVortexEntitled?: boolean;
  isAuthenticated?: boolean;
  isProjectDiscoverable?: boolean;
  isCagInstalled?: boolean;
  cagExitCode?: number;
}

function payload(toolName: string, toolInput: unknown = TOOL_INPUT): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu-1',
    session_id: 'devin-session',
    prompt_id: 'prompt-1',
  });
}

describe('sonar hook devin-subagent-start', () => {
  let harness: TestHarness;

  async function setup({
    isVortexEntitled = true,
    isAuthenticated = true,
    isProjectDiscoverable = true,
    isCagInstalled = true,
    cagExitCode = 0,
  }: SetupOptions = {}): Promise<void> {
    const serverUrl = (
      await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT)
        .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, {
          allowed: isVortexEntitled,
          hasEntitlement: isVortexEntitled,
        })
        .start()
    ).baseUrl();

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
        sessionContextStdout: CAG_CONTEXT,
        sessionContextExitCode: cagExitCode,
      });
    }
  }

  function cagSessionStartInvocations(): CagInvocation[] {
    return readCagInvocations(harness).filter((i) => i.argv[1] === 'print-session-start-context');
  }

  function expectUnchanged(result: { exitCode: number; stdout: string }): void {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'puts the announcement before the original task and keeps every other input field',
    async () => {
      await setup();

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as {
        hookSpecificOutput: {
          hookEventName: string;
          permissionDecision?: string;
          updatedInput: Record<string, unknown>;
        };
      };
      expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
      const { task, ...otherFields } = output.hookSpecificOutput.updatedInput;
      expect(task).toBe(`${CAG_CONTEXT}\n\n${ORIGINAL_TASK}`);
      const { task: _originalTask, ...originalOtherFields } = TOOL_INPUT;
      expect(JSON.stringify(otherFields)).toBe(JSON.stringify(originalOtherFields));
      expect(cagSessionStartInvocations()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not announce twice when the task already starts with the announcement',
    async () => {
      await setup();

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent', { ...TOOL_INPUT, task: `${CAG_CONTEXT}\n\n${ORIGINAL_TASK}` }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it.each([
    'read',
    'exec',
    'edit',
    'read_subagent',
    'Run_Subagent',
    'RUN_SUBAGENT',
    'run_subagents',
  ])(
    'leaves the %s tool unchanged without invoking CAG',
    async (toolName) => {
      await setup();

      const result = await harness.runWithStdin('hook devin-subagent-start', payload(toolName));

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it.each([
    ['no task', { profile: 'subagent_explore' }],
    ['a non-string task', { task: 42 }],
    ['a non-object input', 'just a string'],
  ])(
    'leaves run_subagent with %s unchanged without invoking CAG',
    async (_label, toolInput) => {
      await setup();

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent', toolInput),
      );

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it.each(['not json at all', '', 'null', '[]'])(
    'stays silent on malformed stdin %p',
    async (stdin) => {
      await setup();

      const result = await harness.runWithStdin('hook devin-subagent-start', stdin);

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays silent when not authenticated',
    async () => {
      await setup({ isAuthenticated: false });

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays silent when no project key can be discovered',
    async () => {
      await setup({ isProjectDiscoverable: false });

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays silent when the organization is not entitled to Vortex',
    async () => {
      await setup({ isVortexEntitled: false });

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays silent when the CAG binary is not installed',
    async () => {
      await setup({ isCagInstalled: false });

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expectUnchanged(result);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays silent when CAG exits non-zero',
    async () => {
      await setup({ cagExitCode: 1 });

      const result = await harness.runWithStdin(
        'hook devin-subagent-start',
        payload('run_subagent'),
      );

      expectUnchanged(result);
      expect(cagSessionStartInvocations()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});
