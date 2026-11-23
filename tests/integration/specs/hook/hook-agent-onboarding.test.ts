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

import { AGENT_INTEGRATION_IDS } from '@/commands/integrate/integration-handlers.ts';

import { TestHarness } from '../../harness';

describe('sonar hook agent-onboarding', () => {
  let harness: TestHarness;
  const target = 'https://sonarcloud.io';

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.cwd.writeFile(
      'sonar-project.properties',
      'sonar.host.url=' + target + '\nsonar.projectKey=sample\nsonar.organization=team\n',
    );
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function seed(agent: keyof typeof AGENT_INTEGRATION_IDS): void {
    const state = harness.state().build();
    state.integrations.onboarding = {
      [AGENT_INTEGRATION_IDS[agent]]: {
        status: 'waiting_for_sign_in',
        server: target,
        org: 'team',
      },
    };
    harness.state().withRawState(JSON.stringify(state));
  }

  it.each(['claude', 'codex', 'copilot', 'cursor', 'devin', 'pi'] as const)(
    'offers a one-time invitation in the %s hook output format',
    async (agent) => {
      seed(agent);
      const cwd = harness.cwd.path;
      const payloads = {
        claude: { cwd, session_id: 'test-session', hook_event_name: 'SessionStart' },
        codex: { cwd, session_id: 'test-session', hook_event_name: 'SessionStart' },
        copilot: { cwd, sessionId: 'test-session' },
        cursor: { workspace_roots: [cwd], conversation_id: 'test-session' },
        devin: { cwd, session_id: 'test-session', hook_event_name: 'SessionStart' },
        pi: { cwd, sessionID: 'test-session' },
      };
      const command = 'hook agent-onboarding --agent ' + agent;
      const first = await harness.runWithStdin(command, JSON.stringify(payloads[agent]));

      expect(first.exitCode).toBe(0);
      expect(first.stderr).toBe('');
      const output = JSON.parse(first.stdout);
      const message =
        output.systemMessage ??
        output.additionalContext ??
        output.additional_context ??
        output.userMessage ??
        output.hookSpecificOutput?.additionalContext;
      expect(message).toContain('Sign in to SonarQube');
      expect(message).toContain('--org');

      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      const next = await harness.runWithStdin(command, JSON.stringify(payloads[agent]));
      expect(next.exitCode).toBe(0);
      expect(next.stdout).toBe('');
    },
  );

  it('keeps unrelated workspaces and subagents quiet', async () => {
    seed('claude');
    const command = 'hook agent-onboarding --agent claude';
    const subagent = await harness.runWithStdin(
      command,
      JSON.stringify({
        cwd: harness.cwd.path,
        hook_event_name: 'SubagentStart',
      }),
    );
    expect(subagent.stdout).toBe('');

    const unrelated = await harness.runWithStdin(
      command,
      JSON.stringify({
        cwd: harness.userHome.path,
        hook_event_name: 'SessionStart',
      }),
    );
    expect(unrelated.stdout).toBe('');
  });

  it('does not consume the Claude invitation when Devin inherits the hook', async () => {
    seed('claude');
    const command = 'hook agent-onboarding --agent claude';
    const payload = JSON.stringify({
      cwd: harness.cwd.path,
      hook_event_name: 'SessionStart',
    });
    const devin = await harness.runWithStdin(command, payload, {
      extraEnv: { DEVIN_PROJECT_DIR: harness.cwd.path },
    });
    expect(devin.exitCode).toBe(0);
    expect(devin.stdout).toBe('');

    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const claude = await harness.runWithStdin(command, payload);
    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain('Sign in to SonarQube');
  });

  it('removes dismissed guidance and keeps user settings', async () => {
    harness.userHome.writeFile('.claude/settings.json', '{"model":"sonnet"}');
    const prepared = await harness.run('integrate --all --non-interactive');
    expect(prepared.exitCode).toBe(0);
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

    const result = await harness.run('integrate --dismiss-agent claude');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skipped');
    const settings = harness.userHome.file('.claude', 'settings.json');
    expect(settings.asText()).not.toContain('sonar-agent-onboarding');
    expect(settings.asJson().model).toBe('sonnet');
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const startup = await harness.runWithStdin(
      'hook agent-onboarding --agent claude',
      JSON.stringify({
        cwd: harness.cwd.path,
        hook_event_name: 'SessionStart',
      }),
    );
    expect(startup.stdout).toBe('');

    const status = await harness.run('system status --format json');
    expect(JSON.parse(status.stdout)).toMatchObject({
      pendingIntegrations: [],
      integrations: [],
    });
  });

  it('installs on-demand sign-in skills for OpenCode and Antigravity', async () => {
    harness.userHome.writeFile('.config/opencode/opencode.json', '{}');
    harness.userHome.writeFile('.gemini/config/settings.json', '{}');

    const prepared = await harness.run('integrate --all --non-interactive');

    expect(prepared.exitCode).toBe(0);
    expect(
      harness.userHome.file('.config', 'opencode', 'skills', 'sonar-sign-in', 'SKILL.md').asText(),
    ).toContain('continue the original request');
    expect(
      harness.userHome.file('.gemini', 'config', 'skills', 'sonar-sign-in', 'SKILL.md').asText(),
    ).toContain('continue the original request');

    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const dismissal = await harness.run('integrate --dismiss-agent opencode');
    expect(dismissal.exitCode).toBe(0);
    expect(
      harness.userHome.file('.config', 'opencode', 'skills', 'sonar-sign-in', 'SKILL.md').exists(),
    ).toBe(false);
  });
});
