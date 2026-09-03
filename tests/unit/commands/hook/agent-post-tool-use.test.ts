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

import * as sqaaTelemetry from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import {
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as processLib from '@/core/process/process.ts';
import * as projectInfo from '@/core/project-info.ts';
import * as clientModule from '@/core/server/client.ts';

import { agentPostToolUse } from '../../../../src/commands/hook/agent-post-tool-use.ts';
import { contextAugmentationPostToolUseSubscriber } from '../../../../src/commands/hook/context-augmentation-hook-subscriber.ts';
import * as hookOutput from '../../../../src/commands/hook/format-sqaa-hook-context.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';

// Real path inside cwd so realpathSync resolves consistently for file and cwd.
const TEST_FILE = join(process.cwd(), 'src/index.ts');

describe('agentPostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let createAnalysisSpy: ReturnType<typeof spyOn>;
  let emitSqaaAnalysisTelemetrySpy: ReturnType<typeof spyOn>;
  let spawnProcessSpy: ReturnType<typeof spyOn>;
  let cagMatchesSpy: ReturnType<typeof spyOn>;
  let ctx: CommandInvocationContext;
  let discoverProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Deterministic git branch auto-detection (hook resolves branch from the edited file).
    spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockImplementation(
      (_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
        }
        if (args[0] === 'branch' && args[1] === '--show-current') {
          return Promise.resolve({ exitCode: 0, stdout: 'feature/hook-branch\n', stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    );
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJsonWithRaw').mockResolvedValue({
      raw: '{}',
      parsed: { tool_name: 'Edit', tool_input: { file_path: TEST_FILE } },
    });
    cagMatchesSpy = spyOn(contextAugmentationPostToolUseSubscriber, 'matches').mockReturnValue(
      false,
    );
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue('const x = 1;');
    // Only exercised when a test omits `project` — an explicit project short-circuits it.
    discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      repoRoot: process.cwd(),
      projectRoot: process.cwd(),
      projectKey: undefined,
      configSources: [],
    });
    createAnalysisSpy = spyOn(
      clientModule.SonarQubeClient.prototype,
      'createAnalysis',
    ).mockResolvedValue({ id: 'analysis-id', issues: [], errors: null });
    emitSqaaAnalysisTelemetrySpy = spyOn(
      sqaaTelemetry,
      'recordSqaaAnalysisTelemetry',
    ).mockImplementation(() => {});
    ctx = new CommandInvocationContext();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    createAnalysisSpy.mockRestore();
    emitSqaaAnalysisTelemetrySpy.mockRestore();
    spawnProcessSpy.mockRestore();
    cagMatchesSpy.mockRestore();
    discoverProjectSpy.mockRestore();
  });

  it('emits SQAA analysis telemetry after a successful PostToolUse analysis', async () => {
    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 0, totalFailures: 0 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('records hook exit_code 0 in telemetry even when issues are found', async () => {
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

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 1, totalFailures: 0 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('writes additionalContext JSON when analysis returns no issues', async () => {
    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('No issues found');
  });

  it('triggers analysis when tool_name is Write', async () => {
    readStdinJsonSpy.mockResolvedValue({
      raw: '{}',
      parsed: { tool_name: 'Write', tool_input: { file_path: TEST_FILE } },
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
  });

  it('calls createAnalysis with files[], auto-detected branchName, and no analysisDepth', async () => {
    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).toHaveBeenCalledWith({
      organizationKey: 'myorg',
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
      branchName: 'feature/hook-branch',
    });
  });

  it('omits branchName when git branch auto-detection yields no branch (detached HEAD)', async () => {
    spawnProcessSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
      }
      // Detached HEAD: show-current is empty, abbrev-ref returns HEAD.
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ exitCode: 0, stdout: '\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: 'HEAD\n', stderr: '' });
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

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

    await agentPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('Fix this');
    expect(output.hookSpecificOutput.additionalContext).toContain('java:S1234');
  });

  it('returns without output when tool_name is not Edit or Write', async () => {
    readStdinJsonSpy.mockResolvedValue({
      raw: '{}',
      parsed: { tool_name: 'Read', tool_input: { file_path: TEST_FILE } },
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('runs analysis on a Server connection without an organization', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'on-premise',
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).toHaveBeenCalledWith({
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
      branchName: 'feature/hook-branch',
    });
  });

  it('returns without output when project key is not provided', async () => {
    await agentPostToolUse(ctx, {});

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth rejects', async () => {
    resolveAuthSpy.mockRejectedValue(new Error('keychain error'));

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('returns without output when file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when stdin is unparseable', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('Failed to parse stdin as JSON'));

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when analysis throws', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('Network error'));

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('emits failure telemetry when readFileSync throws', async () => {
    readFileSyncSpy.mockImplementation(() => {
      throw new Error('EACCES');
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('emits failure telemetry when analysis API returns an error result', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('API unavailable'));

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('does not emit failure telemetry when hook output fails after analysis telemetry', async () => {
    const writeHookOutputSpy = spyOn(hookOutput, 'writePostToolUseHookOutput').mockImplementation(
      () => {
        throw new Error('stdout closed');
      },
    );

    await agentPostToolUse(ctx, { project: 'my-project' });

    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();

    writeHookOutputSpy.mockRestore();
  });

  it('includes errors in additionalContext when analysis returns errors', async () => {
    createAnalysisSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [],
      errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('FILE_NOT_FOUND');
    expect(output.hookSpecificOutput.additionalContext).toContain('File not indexed');
  });

  it('returns without output when file_path is missing from payload', async () => {
    readStdinJsonSpy.mockResolvedValue({
      raw: '{}',
      parsed: { tool_name: 'Edit', tool_input: {} },
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

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

    await agentPostToolUse(ctx, { project: 'my-project' });

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

    await agentPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('2 issues');
  });

  it('omits line location when issue has no textRange', async () => {
    createAnalysisSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [{ rule: 'java:S1', message: 'No location', textRange: null }],
      errors: null,
    });

    await agentPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('line');
  });

  it('does not append errors section when errors array is empty', async () => {
    createAnalysisSpy.mockResolvedValue({ id: 'analysis-id', issues: [], errors: [] });

    await agentPostToolUse(ctx, { project: 'my-project' });

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
      raw: '{}',
      parsed: { tool_name: 'Edit', tool_input: { file_path: symlinkPath } },
    });
    existsSyncSpy.mockReturnValue(true);

    // Simulate symlink swap: first realpathSync call sees the safe file,
    // second call (if it happens) sees the attacker file. canonicalizePath()
    // resolves via realpathSync.native, so that is the function to intercept.
    let resolveCount = 0;
    const realpathSyncSpy = spyOn(fs.realpathSync, 'native').mockImplementation(((
      p: fs.PathLike,
    ) => {
      if (p === symlinkPath) {
        return ++resolveCount === 1 ? safeTarget : attackerTarget;
      }
      return String(p);
    }) as typeof fs.realpathSync.native);

    await agentPostToolUse(ctx, { project: 'my-project' });

    // Without fix (double canonicalization): resolveCount reaches 2 so readFileSync
    // is called with attackerTarget — exfiltration succeeds.
    // With fix (single canonicalization): resolveCount stays at 1 so readFileSync
    // is called with safeTarget.
    expect(readFileSyncSpy).toHaveBeenCalledWith(safeTarget, 'utf-8');
    expect(readFileSyncSpy).not.toHaveBeenCalledWith(attackerTarget, expect.anything());

    realpathSyncSpy.mockRestore();
  });
});
