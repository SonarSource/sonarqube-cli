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

import { afterEach, describe, expect, it } from 'bun:test';

import {
  checkAntigravitySecretsHookFile,
  resolveAntigravitySecretsHooksJsonPath,
} from '../../../../../../src/cli/commands/integrate/antigravity/health';
import { ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON } from '../../../../../../src/lib/config-constants';
import { getMcpConfigFilePath } from '../../../../../../src/lib/mcp/mcp-helper';

describe('resolveAntigravitySecretsHooksJsonPath', () => {
  it('returns project hooks.json under the target root', () => {
    expect(resolveAntigravitySecretsHooksJsonPath('project', '/repo')).toBe(
      join('/repo', '.agents', 'hooks.json'),
    );
  });

  it('returns global hooks.json for global scope', () => {
    expect(resolveAntigravitySecretsHooksJsonPath('global', '/ignored')).toContain(
      '.gemini/config/hooks.json',
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

  it('returns configured when sonar-secrets block and script exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-antigravity-health-'));
    const scriptPath = join(tempDir, 'pretool-secrets.sh');
    writeFileSync(scriptPath, '#!/bin/bash\n');
    writeFileSync(
      join(tempDir, 'hooks.json'),
      JSON.stringify({
        'sonar-secrets': {
          enabled: true,
          PreToolUse: [
            {
              matcher: 'view_file',
              hooks: [{ command: `bash "${scriptPath}"` }],
            },
          ],
        },
      }),
    );

    expect(checkAntigravitySecretsHookFile(join(tempDir, 'hooks.json'))).toBe('configured');
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
              hooks: [{ command: 'bash "/missing/pretool-secrets.sh"' }],
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
