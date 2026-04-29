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

import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { setupMcpServerForAgent } from '../../../../../../src/cli/commands/integrate/_common/mcp';
import { CLI_COMMAND } from '../../../../../../src/lib/config-constants';
import { getMockUiCalls, setMockUi } from '../../../../../../src/ui';

describe('setupMcpServerForAgent (copilot)', () => {
  let writeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    writeSpy?.mockRestore();
    setMockUi(false);
  });

  it('writes a sonar CLI config with the platform CLI command', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServerForAgent('copilot', '/fake/project', true, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string; args: string[] };
    expect(config.command).toBe(CLI_COMMAND);
    expect(config.args).toEqual(['run', 'mcp']);
  });

  it('writes to ~/.copilot/mcp-config.json for the global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServerForAgent('copilot', '/fake/project', true, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join(homedir(), '.copilot', 'mcp-config.json'));
  });

  it('writes to <projectRoot>/.mcp.json for the non-global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServerForAgent('copilot', '/fake/project', false, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join('/fake/project', '.mcp.json'));
  });

  it('includes --project flag when a project key is provided', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServerForAgent('copilot', '/fake/project', false, 'my-project');

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { args: string[] };
    expect(config.args).toContain('--project');
    expect(config.args).toContain('my-project');
  });

  it('logs an error when writing the MCP entry fails', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockRejectedValue(new Error('disk full'));

    await setupMcpServerForAgent('copilot', '/fake/project', false, undefined);

    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('disk full'))).toBe(true);
  });
});
