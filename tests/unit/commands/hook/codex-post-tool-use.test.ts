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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import * as agentSession from '@/core/telemetry/agent-session.ts';
import * as sqaaTelemetry from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import {
  SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';

import * as sqaaModule from '../../../../src/commands/analyze/sqaa.ts';
import { codexPostToolUse } from '../../../../src/commands/hook/codex-post-tool-use.ts';
import * as hookOutput from '../../../../src/commands/hook/format-sqaa-hook-context.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';

const ctx = new CommandInvocationContext();

describe('codexPostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let buildSqaaJsonReportSpy: ReturnType<typeof spyOn>;
  let emitSqaaAnalysisTelemetrySpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  const originalStdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockRejectedValue(
      new Error('no stdin in unit test'),
    );
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    buildSqaaJsonReportSpy = spyOn(sqaaModule, 'buildSqaaJsonReport').mockResolvedValue({
      files: [{ path: 'src/foo.ts', issues: [], errors: null }],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
      analysisDepth: 'STANDARD',
    });
    emitSqaaAnalysisTelemetrySpy = spyOn(
      sqaaTelemetry,
      'emitSqaaAnalysisTelemetry',
    ).mockImplementation(() => Promise.resolve());
    spyOn(agentSession, 'resolveAgentSessionIdForEmit').mockReturnValue(null);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    buildSqaaJsonReportSpy.mockRestore();
    emitSqaaAnalysisTelemetrySpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalStdinIsTTY,
    });
  });

  it('skips stdin when attached to a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(readStdinJsonSpy).not.toHaveBeenCalled();
  });

  it('returns session id from piped stdin JSON', async () => {
    const payload = { session_id: 'codex-session-1' };
    readStdinJsonSpy.mockResolvedValue(payload);

    const returned = await codexPostToolUse(ctx, { project: 'my-project' });

    expect(readStdinJsonSpy).toHaveBeenCalledTimes(1);
    expect(returned).toEqual({ agentSessionId: 'codex-session-1' });
  });

  it('writes additionalContext when change-set analysis finds no issues', async () => {
    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(buildSqaaJsonReportSpy).toHaveBeenCalledWith(
      { project: 'my-project', force: true, format: 'json', forcedDepth: 'STANDARD' },
      expect.objectContaining({ connectionType: 'cloud' }),
      {
        telemetryCallerCommand: SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
        telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
        agentSessionId: null,
      },
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('No issues found');
  });

  it('surfaces per-file analysis errors when totalIssues is zero', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [
        {
          path: 'src/foo.ts',
          issues: [],
          errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
        },
      ],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
      analysisDepth: 'STANDARD',
    });

    await codexPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('no issues found');
    expect(output.hookSpecificOutput.additionalContext).toContain('FILE_NOT_FOUND');
  });

  it('includes multi-file issue details in additionalContext', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [
        {
          path: 'src/a.ts',
          issues: [
            {
              rule: 'typescript:S1234',
              message: 'Fix this',
              textRange: { startLine: 3, endLine: 3, startOffset: 0, endOffset: 1 },
            },
          ],
          errors: null,
        },
      ],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 1, totalFailures: 0, totalSkipped: 0 },
      analysisDepth: 'STANDARD',
    });

    await codexPostToolUse(ctx, { project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('Fix this');
    expect(output.hookSpecificOutput.additionalContext).toContain('typescript:S1234');
    expect(output.hookSpecificOutput.additionalContext).toContain('src/a.ts');
  });

  it('skips output when project key is missing', async () => {
    await codexPostToolUse(ctx, {});

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output when auth is not Cloud', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'server',
    });

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output on empty change set', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
      analysisDepth: 'STANDARD',
    });

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does not throw when buildSqaaJsonReport fails', async () => {
    buildSqaaJsonReportSpy.mockRejectedValue(new Error('git failed'));

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(emitSqaaAnalysisTelemetrySpy).toHaveBeenCalledWith(
      SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ connectionType: 'cloud' }),
      expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
      null,
    );
  });

  it('does not emit failure telemetry when hook output fails after analysis telemetry', async () => {
    const emitSqaaHookFailureTelemetrySpy = spyOn(
      sqaaTelemetry,
      'emitSqaaHookFailureTelemetry',
    ).mockImplementation(() => Promise.resolve());
    const writeHookOutputSpy = spyOn(hookOutput, 'writePostToolUseHookOutput').mockImplementation(
      () => {
        throw new Error('stdout closed');
      },
    );

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(emitSqaaHookFailureTelemetrySpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();

    emitSqaaHookFailureTelemetrySpy.mockRestore();
    writeHookOutputSpy.mockRestore();
  });

  it('skips output when buildSqaaJsonReport returns null', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue(null);

    await codexPostToolUse(ctx, { project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
