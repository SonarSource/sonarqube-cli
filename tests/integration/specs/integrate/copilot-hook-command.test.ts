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

import { afterEach, describe, expect, it } from 'bun:test';

import { SECRETS_INACTIVE_UNAUTHENTICATED } from '@/commands/hook/hook-dependencies.ts';

import { IS_WINDOWS, TestHarness } from '../../harness';
import { type CopilotHooksJson, GLOBAL_HOOKS_JSON_PATH, HOOK_FIELD } from './copilot-test-helpers';

const shells = IS_WINDOWS ? ['powershell.exe', 'pwsh.exe'] : ['bash'];

describe('Copilot hook command execution', () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
  });

  for (const shell of shells) {
    it(
      `executes literal special-character paths with ${shell}`,
      async () => {
        harness = await TestHarness.create({ homeName: "home with spaces ' ‘ ’ ‚ ‛ and $dollar" });
        harness.state().withSecretsBinaryInstalled();
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        const result = await harness.run('integrate copilot --non-interactive');
        expect(result.exitCode).toBe(0);
        const hooks = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        const entries = [hooks.hooks.preToolUse?.[0], hooks.hooks.userPromptTransformed?.[0]];
        harness.withCliInPath().clearAuth();
        harness.cwd.writeFile('clean.js', 'const greeting = "hello world";');
        const inputs = [
          { toolName: 'view', toolArgs: { path: harness.cwd.file('clean.js').path } },
          { transformedPrompt: 'input payload' },
        ];
        for (const [index, entry] of entries.entries()) {
          const invocation = entry?.[HOOK_FIELD];
          expect(invocation).toBeDefined();
          const args = IS_WINDOWS
            ? [
                shell,
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `${invocation}; exit $LASTEXITCODE`,
              ]
            : [shell, '-c', invocation ?? ''];
          const child = Bun.spawn(args, {
            cwd: harness.cwd.path,
            env: harness.env(),
            stdin: new Blob([JSON.stringify(inputs[index])]),
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(stderr).toBe('');
          const output = JSON.parse(stdout) as Record<string, unknown>;
          expect(Object.values(output).join(' ')).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
          expect(exitCode).toBe(0);
        }
      },
      { timeout: 30000 },
    );
  }
});
