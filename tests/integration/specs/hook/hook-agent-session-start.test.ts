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

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { CliResult } from '../../harness';
import { TestHarness } from '../../harness';
import { type CagInvocation, readCagInvocations } from '../../harness/cag-helpers';
import { git, initGitRepo } from './git-test-helpers';

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
  hasPartialProjectConfig?: boolean;
  bindingLookupStatus?: number;
  isCagInstalled?: boolean;
  cagStdout?: string;
  cagExitCode?: number;
}

describe('sonar hook agent-session-start', () => {
  let harness: TestHarness;
  let serverUrl: string;
  let bindingRequestCount: () => number;

  async function setup({
    isVortexEntitled = true,
    isScaEnabled = false,
    isAuthenticated = true,
    isProjectDiscoverable = true,
    hasPartialProjectConfig = false,
    bindingLookupStatus = 200,
    isCagInstalled = true,
    cagStdout = CAG_CONTEXT,
    cagExitCode = 0,
  }: SetupOptions = {}): Promise<void> {
    const builder = harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(VALID_TOKEN)
      .withProject(TEST_PROJECT)
      .withProjectBindingsStatus(bindingLookupStatus)
      .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, {
        allowed: isVortexEntitled,
        hasEntitlement: isVortexEntitled,
      });
    if (isScaEnabled) {
      builder.withScaEnabled(true);
    }
    const server = await builder.start();
    serverUrl = server.baseUrl();
    bindingRequestCount = () =>
      server
        .getRecordedRequests()
        .filter((request) => request.path === '/dop-translation/project-bindings').length;

    if (isAuthenticated) {
      harness.withAuth(serverUrl, VALID_TOKEN, TEST_ORG);
    }
    if (isProjectDiscoverable || hasPartialProjectConfig) {
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          ...(isProjectDiscoverable ? [`sonar.projectKey=${TEST_PROJECT}`] : []),
          `sonar.organization=${TEST_ORG}`,
        ].join('\n'),
      );
    }
    if (isCagInstalled) {
      harness.state().withContextAugmentationBinaryInstalled({
        sessionContextStdout: cagStdout,
        sessionContextExitCode: cagExitCode,
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

  it(
    'reports missing credentials for a multi-project workspace',
    async () => {
      await setup({ isAuthenticated: false, isProjectDiscoverable: false });
      harness.cwd.writeFile('first/.keep', '');
      harness.cwd.writeFile('second/.keep', '');
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          projects: [
            { path: 'first', projectKey: 'first', serverUrl },
            { path: 'second', projectKey: 'second', serverUrl },
          ],
        }),
      );
      const result = await runHook('claude', {
        cwd: harness.cwd.path,
        session_id: 'ambiguous',
        hook_event_name: 'SessionStart',
      });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as { systemMessage?: string };
      expect(output.systemMessage).toStartWith(
        'Vortex context was not loaded. No usable credentials.',
      );
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

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
    {
      name: 'Devin SessionStart (no cwd in the payload)',
      agent: 'devin',
      stdin: () => ({
        session_id: 'sess-1',
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
      expected: {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: EXPECTED_CONTEXT },
      },
    },
    {
      name: 'Pi session_start',
      agent: 'pi',
      stdin: (cwd: string) => ({ sessionID: 'sess-1', cwd }),
      expected: { additionalContext: EXPECTED_CONTEXT },
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
    'resolves the project from a subdirectory of the repository when Devin sends no cwd',
    async () => {
      await setup();
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('packages/app/index.ts', '');

      const result = await harness.runWithStdin(
        'hook agent-session-start --agent devin',
        JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart' }),
        { cwd: join(harness.cwd.path, 'packages', 'app') },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext).toBe(
        EXPECTED_CONTEXT,
      );
      const invocations = cagSessionStartInvocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0].env.SONAR_CONTEXT_PROJECT).toBe(TEST_PROJECT);
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

  it.each(['claude', 'codex', 'copilot', 'cursor', 'devin'])(
    'keeps an unrelated directory silent for %s',
    async (agent) => {
      await setup({ isProjectDiscoverable: false });
      const input =
        agent === 'cursor'
          ? { conversation_id: 'sess-1', workspace_roots: [harness.cwd.path] }
          : {
              session_id: 'sess-1',
              sessionId: 'sess-1',
              sessionID: 'sess-1',
              cwd: harness.cwd.path,
              hook_event_name: 'SessionStart',
            };
      const result = await runHook(agent, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it.each(
    ['claude', 'codex', 'copilot', 'cursor', 'devin'].flatMap((agent) =>
      [
        {
          name: 'successful empty lookup',
          hasRemote: true,
          authenticated: true,
          status: 200,
          warn: true,
        },
        { name: 'no remote', hasRemote: false, authenticated: true, status: 200, warn: false },
        { name: 'no credentials', hasRemote: true, authenticated: false, status: 200, warn: false },
        { name: 'lookup error', hasRemote: true, authenticated: true, status: 500, warn: false },
        {
          name: 'rejected credentials',
          hasRemote: true,
          authenticated: true,
          status: 401,
          warn: false,
        },
      ].map((scenario) => ({ agent, ...scenario })),
    ),
  )(
    'handles an unconfigured repository for $agent with $name',
    async ({ agent, hasRemote, authenticated, status, warn }) => {
      await setup({
        isProjectDiscoverable: false,
        isAuthenticated: authenticated,
        bindingLookupStatus: status,
      });
      initGitRepo(harness.cwd.path);
      if (hasRemote) {
        git(
          ['remote', 'add', 'origin', 'https://github.com/example/unanalysed.git'],
          harness.cwd.path,
        );
      }
      const input =
        agent === 'cursor'
          ? { conversation_id: 'sess-1', workspace_roots: [harness.cwd.path] }
          : {
              session_id: 'sess-1',
              sessionId: 'sess-1',
              sessionID: 'sess-1',
              cwd: harness.cwd.path,
              hook_event_name: 'SessionStart',
            };
      const result = await runHook(agent, input);
      expect(result.exitCode).toBe(0);
      if (warn) {
        const output = JSON.parse(result.stdout.trim()) as {
          systemMessage: string;
          additional_context: string;
          additionalContext: string;
          hookSpecificOutput: { additionalContext: string };
        };
        const warning =
          agent === 'claude' || agent === 'codex'
            ? output.systemMessage
            : agent === 'cursor'
              ? output.additional_context
              : agent === 'devin'
                ? output.hookSpecificOutput.additionalContext
                : output.additionalContext;
        expect(warning).toContain('sonar link <projectKey>');
        if (agent === 'claude' || agent === 'codex') {
          expect(Object.keys(output)).toEqual(['systemMessage']);
        } else {
          expect(warning).toStartWith('Tell the user:');
        }
      } else {
        expect(result.stdout.trim()).toBe('');
      }
      expect(bindingRequestCount()).toBe(hasRemote && authenticated ? 1 : 0);
      expect(cagSessionStartInvocations()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  describe('in a multi-project workspace', () => {
    function writeSharedProjectConfig(organizations: [string, string]): void {
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('services/api/.keep', '');
      harness.cwd.writeFile('apps/web/.keep', '');
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          projects: [
            { projectKey: 'api', path: 'services/api', serverUrl, organization: organizations[0] },
            { projectKey: 'web', path: 'apps/web', serverUrl, organization: organizations[1] },
          ],
        }),
      );
    }

    it(
      'announces Vortex Context with multi-project guidance when every project shares the connection',
      async () => {
        await setup({ isProjectDiscoverable: false });
        writeSharedProjectConfig([TEST_ORG, TEST_ORG]);

        const result = await runHook('claude', {
          session_id: 'sess-1',
          cwd: harness.cwd.path,
          hook_event_name: 'SessionStart',
        });

        expect(result.exitCode).toBe(0);
        const context: string = JSON.parse(result.stdout.trim()).hookSpecificOutput
          .additionalContext;
        expect(context.startsWith(`${CAG_CONTEXT}\n\n## Multi-project workspace`)).toBe(true);
        expect(context).toContain('- `apps/web/` (web)\n- `services/api/` (api)');
        expect(context).not.toContain('sonar link list');
        expect(context).not.toContain('cannot be resolved to a single project');
        const invocations = cagSessionStartInvocations();
        expect(invocations).toHaveLength(1);
        expect(invocations[0].env.SONAR_CONTEXT_PROJECT).toBeUndefined();
        expect(invocations[0].env.SONAR_CONTEXT_ORGANIZATION).toBe(TEST_ORG);
        expect(invocations[0].env.SONAR_CONTEXT_WORKSPACE_ROOT).toBe(harness.cwd.path);
      },
      TEST_TIMEOUT,
    );

    it(
      'lists project directories relative to the repository root from a subdirectory',
      async () => {
        await setup({ isProjectDiscoverable: false });
        initGitRepo(harness.cwd.path);
        harness.cwd.writeFile('services/api/.keep', '');
        harness.cwd.writeFile('services/worker/.keep', '');
        harness.cwd.writeFile(
          '.sonar-config.json',
          JSON.stringify({
            projects: [
              { projectKey: 'api', path: 'services/api', serverUrl, organization: TEST_ORG },
              { projectKey: 'worker', path: 'services/worker', serverUrl, organization: TEST_ORG },
            ],
          }),
        );

        const result = await runHook('claude', {
          session_id: 'sess-1',
          cwd: join(harness.cwd.path, 'services'),
          hook_event_name: 'SessionStart',
        });

        const context: string = JSON.parse(result.stdout.trim()).hookSpecificOutput
          .additionalContext;
        expect(context).toContain('relative to the repository root');
        expect(context).toContain('- `services/api/` (api)\n- `services/worker/` (worker)');
      },
      TEST_TIMEOUT,
    );

    it(
      'announces the single project without multi-project guidance from inside one project',
      async () => {
        await setup({ isProjectDiscoverable: false });
        writeSharedProjectConfig([TEST_ORG, TEST_ORG]);
        const apiRoot = join(harness.cwd.path, 'services', 'api');

        const result = await runHook('claude', {
          session_id: 'sess-1',
          cwd: apiRoot,
          hook_event_name: 'SessionStart',
        });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext).toBe(
          EXPECTED_CONTEXT,
        );
        expect(cagSessionStartInvocations()[0].env).toMatchObject({
          SONAR_CONTEXT_PROJECT: 'api',
          SONAR_CONTEXT_WORKSPACE_ROOT: apiRoot,
        });
      },
      TEST_TIMEOUT,
    );

    it.each([
      ['use different connections', [TEST_ORG, 'other-org']],
      ['share a connection other than the active one', ['other-org', 'other-org']],
    ] as const)(
      'exits 0 with no output when the projects %s',
      async (_case, organizations) => {
        await setup({ isProjectDiscoverable: false });
        writeSharedProjectConfig([...organizations]);

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
  });

  it.each(['claude', 'codex', 'copilot'])(
    'keeps %s subagents silent after a successful empty remote lookup',
    async (agent) => {
      await setup({ isProjectDiscoverable: false });
      initGitRepo(harness.cwd.path);
      git(
        ['remote', 'add', 'origin', 'https://github.com/example/unanalysed.git'],
        harness.cwd.path,
      );
      const result = await runHook(agent, {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SubagentStart',
        ...(agent === 'copilot' ? { sessionId: 'sess-1', agentName: 'reviewer' } : {}),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    TEST_TIMEOUT,
  );

  it.each(
    ['claude', 'codex', 'copilot'].flatMap((agent) => [
      { agent, name: 'no authentication', options: { isAuthenticated: false } },
      { agent, name: 'empty context', options: { cagStdout: '' } },
      {
        agent,
        name: 'no project',
        options: { isProjectDiscoverable: false, hasPartialProjectConfig: true },
      },
      { agent, name: 'no entitlement', options: { isVortexEntitled: false } },
      { agent, name: 'binary missing', options: { isCagInstalled: false } },
      { agent, name: 'failed context', options: { cagExitCode: 1 } },
    ]),
  )(
    'keeps $agent subagents silent with $name',
    async ({ agent, options }) => {
      await setup(options);
      const result = await runHook(agent, {
        session_id: 'sess-1',
        cwd: harness.cwd.path,
        hook_event_name: 'SubagentStart',
        ...(agent === 'copilot' ? { sessionId: 'sess-1', agentName: 'reviewer' } : {}),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    TEST_TIMEOUT,
  );

  const failures: { name: string; options: SetupOptions; hint: string }[] = [
    { name: 'not authenticated', options: { isAuthenticated: false }, hint: 'sonar auth login' },
    {
      name: 'no project',
      options: { isProjectDiscoverable: false, hasPartialProjectConfig: true },
      hint: 'sonar link <projectKey>',
    },
    { name: 'not entitled', options: { isVortexEntitled: false }, hint: 'sonar auth status' },
    { name: 'binary missing', options: { isCagInstalled: false }, hint: 'sonar integrate' },
    { name: 'context command failed', options: { cagExitCode: 1 }, hint: 'sonar system status' },
    { name: 'empty context', options: { cagStdout: '' }, hint: 'sonar system status' },
  ];

  it.each(
    failures.flatMap((failure) =>
      ['claude', 'codex', 'copilot', 'cursor', 'devin', 'pi'].map((agent) => ({
        ...failure,
        agent,
      })),
    ),
  )(
    'reports $name to $agent without blocking startup',
    async ({ options, hint, agent }) => {
      await setup(options);
      const input =
        agent === 'cursor'
          ? { conversation_id: 'sess-1', workspace_roots: [harness.cwd.path] }
          : {
              session_id: 'sess-1',
              sessionId: 'sess-1',
              sessionID: 'sess-1',
              cwd: harness.cwd.path,
              hook_event_name: 'SessionStart',
            };

      const result = await runHook(agent, input);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as {
        systemMessage?: string;
        userMessage?: string;
        additional_context?: string;
        additionalContext?: string;
        hookSpecificOutput?: { additionalContext: string };
      };
      if (agent === 'claude' || agent === 'codex') {
        expect(Object.keys(output)).toEqual(['systemMessage']);
        expect(output.systemMessage).toStartWith('Vortex context was not loaded.');
        expect(output.systemMessage).toContain(hint);
      } else if (agent === 'pi') {
        expect(Object.keys(output)).toEqual(['userMessage']);
        expect(output.userMessage).toStartWith('Vortex context was not loaded.');
        expect(output.userMessage).toContain(hint);
      } else {
        const context =
          agent === 'cursor'
            ? output.additional_context
            : agent === 'devin'
              ? output.hookSpecificOutput?.additionalContext
              : output.additionalContext;
        expect(context).toStartWith('Tell the user: Vortex context was not loaded.');
        expect(context).toContain(hint);
      }
      const expectedCalls =
        options.cagExitCode !== undefined || options.cagStdout !== undefined ? 1 : 0;
      expect(cagSessionStartInvocations()).toHaveLength(expectedCalls);
    },
    TEST_TIMEOUT,
  );
  it.each(['claude', 'codex', 'copilot', 'cursor', 'devin', 'pi'])(
    'warns once per session for %s and still delivers context after recovery',
    async (agent) => {
      await setup({ cagStdout: '' });
      const input = (id: string) => ({
        session_id: id,
        sessionId: id,
        sessionID: id,
        conversation_id: id,
        cwd: harness.cwd.path,
        workspace_roots: [harness.cwd.path],
        hook_event_name: 'SessionStart',
      });
      const first = await runHook(agent, input('repeat'));
      expect(first.stdout).toContain('Vortex context was not loaded.');
      const repeated = await runHook(agent, input('repeat'));
      expect(repeated.exitCode).toBe(0);
      expect(repeated.stdout.trim()).toBe('');
      const nextSession = await runHook(agent, input('new-session'));
      expect(nextSession.stdout).toContain('Vortex context was not loaded.');
      harness.state().withContextAugmentationBinaryInstalled({ sessionContextStdout: CAG_CONTEXT });
      const recovered = await runHook(agent, input('repeat'));
      expect(recovered.stdout).toContain(CAG_CONTEXT);
      expect(recovered.stdout).not.toContain('Vortex context was not loaded.');
    },
    { timeout: 30000 },
  );
});
