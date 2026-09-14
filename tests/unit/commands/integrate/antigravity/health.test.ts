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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { checkAntigravitySecretsHookFile } from '@/commands/integrate/antigravity/health.ts';
import {
  formatAntigravityHookCommand,
  hookScriptName,
  resolveAntigravityHooksJsonPathForScope,
} from '@/commands/integrate/antigravity/hooks.ts';
import {
  ANTIGRAVITY_GLOBAL_HOOKS_JSON,
  ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
  ANTIGRAVITY_PROJECT_HOOKS_JSON,
  ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS,
} from '@/core/config-constants.ts';
import { getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

describe('resolveAntigravityHooksJsonPathForScope', () => {
  it('returns project hooks.json under the target root', () => {
    expect(resolveAntigravityHooksJsonPathForScope('project', '/repo')).toBe(
      join('/repo', ANTIGRAVITY_PROJECT_HOOKS_JSON),
    );
  });

  it('returns global hooks.json for global scope', () => {
    expect(resolveAntigravityHooksJsonPathForScope('global', '/ignored')).toBe(
      ANTIGRAVITY_GLOBAL_HOOKS_JSON,
    );
  });
});

describe('checkAntigravitySecretsHookFile', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns not_configured when hooks.json is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe('not_configured');
  });

  it.each([
    ['configured', true, 'view_file'],
    ['not_configured', false, 'view_file'],
    ['invalid', true, 'edit_file'],
  ] as const)(
    'returns %s when enabled=%s and matcher=%s',
    (expected, enabled, matcher) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
      const scriptPath = join(tempDir, hookScriptName());
      writeFileSync(scriptPath, '#!/bin/bash\n');
      writeFileSync(
        join(tempDir, 'hooks.json'),
        JSON.stringify({
          'sonar-secrets': {
            enabled,
            PreToolUse: [
              {
                matcher,
                hooks: [{ command: formatAntigravityHookCommand(scriptPath) }],
              },
            ],
          },
        }),
      );

      expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe(expected);
    },
  );

  it('returns configured when the hook command path is relative to hooks.json', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    const agentsDir = join(tempDir, '.agents');
    const scriptPath = join(
      agentsDir,
      ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS,
      hookScriptName(),
    );
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, '#!/bin/bash\n');
    writeFileSync(
      join(agentsDir, 'hooks.json'),
      JSON.stringify({
        'sonar-secrets': {
          enabled: true,
          PreToolUse: [
            {
              matcher: 'view_file',
              hooks: [
                {
                  command: formatAntigravityHookCommand(
                    join(ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS, hookScriptName()),
                  ),
                },
              ],
            },
          ],
        },
      }),
    );

    expect(checkAntigravitySecretsHookFile(join(agentsDir, 'hooks.json'))).toBe('configured');
  });

  it('returns invalid when the backing script is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    writeFileSync(
      join(tempDir, 'hooks.json'),
      JSON.stringify({
        'sonar-secrets': {
          enabled: true,
          PreToolUse: [
            {
              matcher: 'view_file',
              hooks: [
                { command: formatAntigravityHookCommand(join('/missing', hookScriptName())) },
              ],
            },
          ],
        },
      }),
    );

    expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe('invalid');
  });

  it('returns invalid for malformed JSON', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    writeFileSync(join(tempDir, 'hooks.json'), '{ not json');

    expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe('invalid');
  });

  it('returns not_configured when the sonar-secrets block is absent', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    writeFileSync(join(tempDir, 'hooks.json'), JSON.stringify({ other: { enabled: true } }));

    expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe('not_configured');
  });

});

describe('getMcpConfigFilePath (antigravity)', () => {
  it('returns the global Antigravity MCP path for project scope', () => {
    expect(getMcpConfigFilePath('antigravity', false, '/repo')).toBe(
      ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
    );
  });

  it('returns the global Antigravity MCP path for global scope', () => {
    expect(getMcpConfigFilePath('antigravity', true, '/repo')).toBe(
      ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
    );
  });
});
