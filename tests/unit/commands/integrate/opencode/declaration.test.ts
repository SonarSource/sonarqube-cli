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

import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  openCodeIntegration,
  resolveOpenCodePluginPath,
} from '@/commands/integrate/opencode/declaration.ts';
import { OPENCODE_PLUGIN_CONTENT } from '@/commands/integrate/opencode/plugin-content.ts';
import type { IntegrationContext } from '@/core/framework/features';

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

describe('resolveOpenCodePluginPath', () => {
  it('writes to ~/.config/opencode/plugins for the global scope', () => {
    expect(resolveOpenCodePluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodePluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar.ts'),
    );
  });
});

describe('openCodeIntegration', () => {
  it('declares a single secret-scanning-hooks feature backed by the sonar-secrets binary', () => {
    expect(openCodeIntegration.id).toBe('opencode');
    expect(openCodeIntegration.features).toHaveLength(1);

    const [feature] = openCodeIntegration.features;
    expect(feature.dependencies).toHaveLength(1);
    expect(feature.resources).toHaveLength(1);
  });
});

describe('OPENCODE_PLUGIN_CONTENT', () => {
  it('wires tool.execute.before to the opencode-pre-tool-use hook subcommand', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain("'tool.execute.before'");
    expect(OPENCODE_PLUGIN_CONTENT).toContain('opencode-pre-tool-use');
  });

  it('wires chat.message to the opencode-chat-message hook subcommand', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain("'chat.message'");
    expect(OPENCODE_PLUGIN_CONTENT).toContain('opencode-chat-message');
  });

  it('never throws from chat.message — a blocked/failed scan rewrites the message text instead', () => {
    const chatMessageBody = OPENCODE_PLUGIN_CONTENT.slice(
      OPENCODE_PLUGIN_CONTENT.indexOf("'chat.message'"),
    );
    expect(chatMessageBody).not.toContain('throw new Error');
    expect(chatMessageBody).toContain('part.text =');
  });

  it('does throw from tool.execute.before on a blocked/failed scan', () => {
    const preToolUseBody = OPENCODE_PLUGIN_CONTENT.slice(
      OPENCODE_PLUGIN_CONTENT.indexOf("'tool.execute.before'"),
      OPENCODE_PLUGIN_CONTENT.indexOf("'chat.message'"),
    );
    expect(preToolUseBody).toContain('throw new Error');
  });

  it('is valid, parseable TypeScript', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(OPENCODE_PLUGIN_CONTENT)).not.toThrow();
  });
});
