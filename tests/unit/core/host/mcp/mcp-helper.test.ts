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

import { CLI_COMMAND_NAME, ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { getMcpConfig } from '@/core/host/mcp/mcp-helper.ts';

import { restoreEnv } from '../../../../_common/isolated-cli-env.ts';

describe('getMcpConfig', () => {
  const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

  afterEach(() => {
    restoreEnv(ENV_SONAR_USER_HOME, previousSonarUserHome);
  });

  it('omits env when SONAR_USER_HOME is unset', () => {
    delete process.env[ENV_SONAR_USER_HOME];

    expect(getMcpConfig({ withFsMount: false })).toEqual({
      command: CLI_COMMAND_NAME,
      args: ['run', 'mcp'],
    });
  });

  it('omits env when SONAR_USER_HOME is blank', () => {
    process.env[ENV_SONAR_USER_HOME] = '   ';

    expect(getMcpConfig({ withFsMount: false })).not.toHaveProperty('env');
  });

  it('always uses sonar as the MCP command, not a platform-specific binary name', () => {
    delete process.env[ENV_SONAR_USER_HOME];

    expect(CLI_COMMAND_NAME).toBe('sonar');
    expect(getMcpConfig({ withFsMount: false }).command).toBe('sonar');
  });

  it('forwards the resolved SONAR_USER_HOME path when set', () => {
    process.env[ENV_SONAR_USER_HOME] = '/custom/sonar-home';

    expect(getMcpConfig({ withFsMount: false, projectKey: 'my-project' })).toEqual({
      command: CLI_COMMAND_NAME,
      args: ['run', 'mcp', '--project', 'my-project'],
      env: { [ENV_SONAR_USER_HOME]: '/custom/sonar-home' },
    });
  });
});
