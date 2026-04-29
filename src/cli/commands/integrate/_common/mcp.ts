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

import { CLI_COMMAND } from '../../../../lib/config-constants';
import {
  getMcpConfig,
  getMcpConfigFilePath,
  writeMcpServerEntry,
} from '../../../../lib/mcp/mcp-helper';
import { error, info, success } from '../../../../ui';

export async function setupMcpServerForAgent(
  agent: 'claude' | 'copilot',
  projectRoot: string,
  isGlobal: boolean,
  projectKey: string | undefined,
): Promise<void> {
  info(`Setting up SonarQube MCP Server for ${agent}...`);

  const targetFile = getMcpConfigFilePath(agent, isGlobal, projectRoot);
  const serverConfig = getMcpConfig(
    CLI_COMMAND,
    isGlobal ? { withFsMount: false } : { withFsMount: true, projectRoot, projectKey },
  );

  try {
    await writeMcpServerEntry(targetFile, serverConfig);
  } catch (e: unknown) {
    if (e instanceof Error) {
      error(`Failed to configure SonarQube MCP Server in ${targetFile}: ${e.message}`);
    }
    return;
  }
  success(`SonarQube MCP Server configured in ${targetFile}`);
}
