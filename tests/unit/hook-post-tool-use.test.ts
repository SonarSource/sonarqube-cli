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

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { agentPostToolUse } from '../../src/cli/commands/hook/agent-post-tool-use';
import * as stdinModule from '../../src/cli/commands/hook/stdin';
import * as authResolver from '../../src/lib/auth-resolver';
import * as clientModule from '../../src/sonarqube/client';

const TEST_FILE = '/sonar-test/src/main.ts';

describe('agentPostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let analyzeFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      tool_name: 'Edit',
      tool_input: { file_path: TEST_FILE },
    });
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue('const x = 1;');
    analyzeFileSpy = spyOn(clientModule.SonarQubeClient.prototype, 'analyzeFile').mockResolvedValue(
      { id: 'analysis-id', issues: [], errors: null },
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    analyzeFileSpy.mockRestore();
  });

  it('writes additionalContext JSON when analysis returns no issues', async () => {
    await agentPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('no issues');
  });

  it('triggers analysis when tool_name is Write', async () => {
    readStdinJsonSpy.mockResolvedValue({
      tool_name: 'Write',
      tool_input: { file_path: TEST_FILE },
    });

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
  });

  it('includes issue details in additionalContext when issues are found', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [
        {
          rule: 'java:S1234',
          message: 'Fix this',
          textRange: { startLine: 10, endLine: 10, startOffset: 0, endOffset: 5 },
        },
      ],
      errors: null,
    });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('Fix this');
    expect(output.hookSpecificOutput.additionalContext).toContain('java:S1234');
  });

  it('returns without output when tool_name is not Edit or Write', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool_name: 'Read', tool_input: { file_path: TEST_FILE } });

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when connection is not cloud', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'on-premise',
    });

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when project key is not provided', async () => {
    await agentPostToolUse({});

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth rejects', async () => {
    resolveAuthSpy.mockRejectedValue(new Error('keychain error'));

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('returns without output when file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when stdin is unparseable', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('Failed to parse stdin as JSON'));

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when analysis throws', async () => {
    analyzeFileSpy.mockRejectedValue(new Error('Network error'));

    await agentPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('includes errors in additionalContext when analysis returns errors', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [],
      errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
    });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('FILE_NOT_FOUND');
    expect(output.hookSpecificOutput.additionalContext).toContain('File not indexed');
  });

  it('returns without output when file_path is missing from payload', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool_name: 'Edit', tool_input: {} });

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when cloud auth has no orgKey', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: undefined,
    });

    await agentPostToolUse({ project: 'my-project' });

    expect(analyzeFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('uses plural "issues" when analysis returns more than one issue', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [
        { rule: 'java:S1', message: 'First', textRange: null },
        { rule: 'java:S2', message: 'Second', textRange: null },
      ],
      errors: null,
    });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('2 issues');
  });

  it('omits line location when issue has no textRange', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [{ rule: 'java:S1', message: 'No location', textRange: null }],
      errors: null,
    });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('line');
  });

  it('does not append errors section when errors array is empty', async () => {
    analyzeFileSpy.mockResolvedValue({ id: 'analysis-id', issues: [], errors: [] });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Agentic Analysis errors');
  });
});
