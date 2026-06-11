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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { agentPostToolUse } from '../../../../../src/cli/commands/hook/agent-post-tool-use';
import * as stdinModule from '../../../../../src/cli/commands/hook/stdin';
import * as authResolver from '../../../../../src/lib/auth-resolver';
import * as clientModule from '../../../../../src/sonarqube/client';

// Real path inside cwd so realpathSync resolves consistently for file and cwd.
const TEST_FILE = join(process.cwd(), 'src/index.ts');

describe('agentPostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let createAnalysisSpy: ReturnType<typeof spyOn>;

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
    createAnalysisSpy = spyOn(
      clientModule.SonarQubeClient.prototype,
      'createAnalysis',
    ).mockResolvedValue({ id: 'analysis-id', issues: [], errors: null });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    createAnalysisSpy.mockRestore();
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

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
  });

  it('calls createAnalysis with files[] and no analysisDepth', async () => {
    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).toHaveBeenCalledWith({
      organizationKey: 'myorg',
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
    });
  });

  it('includes issue details in additionalContext when issues are found', async () => {
    createAnalysisSpy.mockResolvedValue({
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

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when connection is not cloud', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'on-premise',
    });

    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when project key is not provided', async () => {
    await agentPostToolUse({});

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth rejects', async () => {
    resolveAuthSpy.mockRejectedValue(new Error('keychain error'));

    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('returns without output when file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when stdin is unparseable', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('Failed to parse stdin as JSON'));

    await agentPostToolUse({ project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when analysis throws', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('Network error'));

    await agentPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('includes errors in additionalContext when analysis returns errors', async () => {
    createAnalysisSpy.mockResolvedValue({
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

    expect(createAnalysisSpy).not.toHaveBeenCalled();
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

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('uses plural "issues" when analysis returns more than one issue', async () => {
    createAnalysisSpy.mockResolvedValue({
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
    createAnalysisSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [{ rule: 'java:S1', message: 'No location', textRange: null }],
      errors: null,
    });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('line');
  });

  it('does not append errors section when errors array is empty', async () => {
    createAnalysisSpy.mockResolvedValue({ id: 'analysis-id', issues: [], errors: [] });

    await agentPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Agentic Analysis errors');
  });

  it('canonicalizes path once so symlink swap after validation cannot exfiltrate files', async () => {
    // Vulnerability (double canonicalization): toRelativePosixPath(filePath) resolves the
    // symlink at t0, then canonicalizePath(filePath) resolves it again at t1. An attacker
    // can swap the symlink between t0 and t1 so validation passes but readFileSync reads
    // the attacker-controlled file.
    // Fix: canonicalize exactly once up front, pass the resolved real path to both
    // toRelativePosixPath and readFileSync so no further symlink resolution occurs.
    const symlinkPath = join(process.cwd(), 'src/link.ts');
    const safeTarget = TEST_FILE;
    const attackerTarget = join(process.cwd(), 'src/other.ts');

    readStdinJsonSpy.mockResolvedValue({
      tool_name: 'Edit',
      tool_input: { file_path: symlinkPath },
    });
    existsSyncSpy.mockReturnValue(true);

    // Simulate symlink swap: first realpathSync call sees the safe file,
    // second call (if it happens) sees the attacker file.
    let resolveCount = 0;
    const realpathSyncSpy = spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (p === symlinkPath) {
        return ++resolveCount === 1 ? safeTarget : attackerTarget;
      }
      return String(p);
    }) as typeof fs.realpathSync);

    await agentPostToolUse({ project: 'my-project' });

    // Without fix (double canonicalization): resolveCount reaches 2 so readFileSync
    // is called with attackerTarget — exfiltration succeeds.
    // With fix (single canonicalization): resolveCount stays at 1 so readFileSync
    // is called with safeTarget.
    expect(readFileSyncSpy).toHaveBeenCalledWith(safeTarget, 'utf-8');
    expect(readFileSyncSpy).not.toHaveBeenCalledWith(attackerTarget, expect.anything());

    realpathSyncSpy.mockRestore();
  });
});
