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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import {
  openCodeIntegration,
  resolveOpenCodeAgentsMdPath,
  resolveOpenCodeMcpConfigPath,
  resolveOpenCodeSecretsPluginPath,
  resolveOpenCodeSqaaPluginPath,
} from '@/commands/integrate/opencode/declaration.ts';
import {
  OPENCODE_PLUGIN_MANAGED_MARKER,
  OPENCODE_SECRETS_PLUGIN_CONTENT,
} from '@/commands/integrate/opencode/secrets-plugin-content.ts';
import { OPENCODE_SQAA_PLUGIN_CONTENT } from '@/commands/integrate/opencode/sqaa-plugin-content.ts';
import type { IntegrationContext } from '@/core/framework/features';
import { isFeatureContainer } from '@/core/framework/features/types.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

function fakeContext(scope: IntegrationContext['scope'], targetRoot: string): IntegrationContext {
  return {
    targetRoot,
    scope,
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    console: new FakeConsole(),
    resolvedDependencies: new Map(),
  };
}

describe('resolveOpenCodeSecretsPluginPath', () => {
  it('writes to ~/.config/opencode/plugins for the global scope', () => {
    expect(resolveOpenCodeSecretsPluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar-secrets.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodeSecretsPluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar-secrets.ts'),
    );
  });
});

describe('resolveOpenCodeSqaaPluginPath', () => {
  it('writes next to the secrets plugin for the global scope', () => {
    expect(resolveOpenCodeSqaaPluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar-sqaa.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodeSqaaPluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar-sqaa.ts'),
    );
  });
});

describe('resolveOpenCodeAgentsMdPath', () => {
  it('writes ~/.config/opencode/AGENTS.md for the global scope', () => {
    expect(resolveOpenCodeAgentsMdPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'AGENTS.md'),
    );
  });

  it('writes <project>/AGENTS.md for the project scope', () => {
    expect(resolveOpenCodeAgentsMdPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', 'AGENTS.md'),
    );
  });
});

describe('resolveOpenCodeMcpConfigPath', () => {
  it('writes to <project>/opencode.json for the project scope', () => {
    expect(resolveOpenCodeMcpConfigPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', 'opencode.json'),
    );
  });
});

describe('openCodeIntegration', () => {
  it('declares the secret-scanning-hooks feature backed by the sonar-secrets binary', () => {
    expect(openCodeIntegration.id).toBe('opencode');

    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === 'sonar-secrets-hooks',
    );
    expect(feature?.dependencies).toHaveLength(1);
    expect(feature?.resources).toHaveLength(1);
  });

  it('declares the shared Vortex container with the SQAA plugin and instructions as subfeatures', () => {
    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === VORTEX_FEATURE_ID,
    );
    if (!feature || !isFeatureContainer(feature)) {
      throw new Error('Vortex container is not declared');
    }

    expect(feature.subfeatures.map((subfeature) => subfeature.id)).toEqual([
      'sonar-sqaa-hook',
      'sqaa-instructions',
    ]);
    for (const subfeature of feature.subfeatures) {
      expect(subfeature.dependencies).toBeUndefined();
      expect(subfeature.resources).toHaveLength(1);
    }
  });

  it('has no legacy CAG skill cleanup, since OpenCode never shipped one', () => {
    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === VORTEX_FEATURE_ID,
    );

    expect(feature?.legacyCleanups).toEqual([]);
  });
});

describe('OPENCODE_SECRETS_PLUGIN_CONTENT', () => {
  it('wires tool.execute.before to the opencode-pre-tool-use hook subcommand', () => {
    expect(OPENCODE_SECRETS_PLUGIN_CONTENT).toContain("'tool.execute.before'");
    expect(OPENCODE_SECRETS_PLUGIN_CONTENT).toContain('opencode-pre-tool-use');
  });

  it('wires chat.message to the opencode-chat-message hook subcommand', () => {
    expect(OPENCODE_SECRETS_PLUGIN_CONTENT).toContain("'chat.message'");
    expect(OPENCODE_SECRETS_PLUGIN_CONTENT).toContain('opencode-chat-message');
  });

  it('never throws from chat.message — a blocked/failed scan rewrites the message text instead', () => {
    const chatMessageBody = OPENCODE_SECRETS_PLUGIN_CONTENT.slice(
      OPENCODE_SECRETS_PLUGIN_CONTENT.indexOf("'chat.message'"),
    );
    expect(chatMessageBody).not.toContain('throw new Error');
    expect(chatMessageBody).toContain('part.text =');
  });

  it('does throw from tool.execute.before on a blocked/failed scan', () => {
    const preToolUseBody = OPENCODE_SECRETS_PLUGIN_CONTENT.slice(
      OPENCODE_SECRETS_PLUGIN_CONTENT.indexOf("'tool.execute.before'"),
      OPENCODE_SECRETS_PLUGIN_CONTENT.indexOf("'chat.message'"),
    );
    expect(preToolUseBody).toContain('throw new Error');
  });

  it('is valid, parseable TypeScript', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(OPENCODE_SECRETS_PLUGIN_CONTENT)).not.toThrow();
  });
});

type SqaaHooks = Record<
  string,
  (input: unknown, output: { output: string }) => Promise<void> | undefined
>;
type SqaaPluginFactory = (input: { $: unknown }) => Promise<SqaaHooks>;
type FakeShellResult = { exitCode: number; json: () => unknown } | Error;

async function loadSqaaPlugin(): Promise<SqaaPluginFactory> {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(OPENCODE_SQAA_PLUGIN_CONTENT);
  const dir = mkdtempSync(join(tmpdir(), 'sonar-sqaa-plugin-'));
  try {
    const file = join(dir, 'plugin.mjs');
    writeFileSync(file, js);
    const loaded = (await import(file)) as { SonarSqaaPlugin: SqaaPluginFactory };
    return loaded.SonarSqaaPlugin;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeShell(result: FakeShellResult) {
  const calls: unknown[][] = [];
  const shell = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return {
      quiet: () => ({
        nothrow: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
      }),
    };
  };
  return { shell, calls };
}

function editInput(tool: string) {
  return { tool, sessionID: 'ses_1', callID: 'call_1', args: { filePath: '/project/a.ts' } };
}

describe('OPENCODE_SQAA_PLUGIN_CONTENT', () => {
  it('wires tool.execute.after to the opencode-post-tool-use hook for edit and write', () => {
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).toContain("'tool.execute.after'");
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).toContain('opencode-post-tool-use');
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).toContain("new Set(['edit', 'write'])");
  });

  it('carries the managed marker so the file can be removed safely', () => {
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).toContain(OPENCODE_PLUGIN_MANAGED_MARKER);
  });

  it('never throws, so a failed analysis cannot break the tool call', () => {
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).not.toContain('throw new');
    expect(OPENCODE_SQAA_PLUGIN_CONTENT).toContain('catch');
  });

  it('is valid, parseable TypeScript', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(OPENCODE_SQAA_PLUGIN_CONTENT)).not.toThrow();
  });

  it('appends the analysis as a system-reminder after an edit and sends the file path to the hook', async () => {
    const { shell, calls } = fakeShell({ exitCode: 0, json: () => ({ context: 'Found 1 issue' }) });
    const hooks = await (await loadSqaaPlugin())({ $: shell });
    const output = { output: 'Edit applied' };

    await hooks['tool.execute.after'](editInput('edit'), output);

    expect(output.output).toBe(
      'Edit applied\n\n<system-reminder>\nFound 1 issue\n</system-reminder>',
    );
    expect(JSON.parse(await (calls[0][0] as Response).text())).toEqual({
      tool: 'edit',
      filePath: '/project/a.ts',
      sessionID: 'ses_1',
    });
  });

  it('analyzes write the same way', async () => {
    const { shell, calls } = fakeShell({ exitCode: 0, json: () => ({ context: 'ok' }) });
    const hooks = await (await loadSqaaPlugin())({ $: shell });

    await hooks['tool.execute.after'](editInput('write'), { output: '' });

    expect(calls).toHaveLength(1);
  });

  it('ignores tools other than edit and write', async () => {
    const { shell, calls } = fakeShell({ exitCode: 0, json: () => ({ context: 'ok' }) });
    const hooks = await (await loadSqaaPlugin())({ $: shell });
    const output = { output: 'file content' };

    await hooks['tool.execute.after'](editInput('read'), output);

    expect(calls).toHaveLength(0);
    expect(output.output).toBe('file content');
  });

  it.each<[string, FakeShellResult]>([
    ['the hook exits with a non-zero code', { exitCode: 1, json: () => ({}) }],
    ['the hook returns no context', { exitCode: 0, json: () => ({}) }],
    ['the shell call throws', new Error('spawn failed')],
    [
      'the hook output is not valid JSON',
      {
        exitCode: 0,
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
      },
    ],
  ])('leaves the tool output untouched when %s', async (_label, result) => {
    const { shell } = fakeShell(result);
    const hooks = await (await loadSqaaPlugin())({ $: shell });
    const output = { output: 'Edit applied' };

    await hooks['tool.execute.after'](editInput('edit'), output);

    expect(output.output).toBe('Edit applied');
  });
});
