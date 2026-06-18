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

import * as sqaaModule from '../../../../../src/cli/commands/analyze/sqaa';
import { claudeStop } from '../../../../../src/cli/commands/hook/claude-stop';
import * as stdinModule from '../../../../../src/cli/commands/hook/stdin';
import * as authResolver from '../../../../../src/lib/auth-resolver';

describe('claudeStop', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let buildSqaaJsonReportSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
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
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockRejectedValue(new Error('no stdin'));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    buildSqaaJsonReportSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
  });

  it('reports findings in additionalContext when change-set analysis finds no issues', async () => {
    await claudeStop({ project: 'my-project' });

    expect(buildSqaaJsonReportSpy).toHaveBeenCalledWith(
      { project: 'my-project', force: true, format: 'json' },
      expect.objectContaining({ connectionType: 'cloud' }),
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(output.hookSpecificOutput.additionalContext).toContain('No issues found');
  });

  it('includes multi-file issue details in Stop additionalContext', async () => {
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
    });

    await claudeStop({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(output.hookSpecificOutput.additionalContext).toContain('Fix this');
    expect(output.hookSpecificOutput.additionalContext).toContain('typescript:S1234');
  });

  it('skips analysis when stop_hook_active is true', async () => {
    readStdinJsonSpy.mockResolvedValue({ stop_hook_active: true });

    await claudeStop({ project: 'my-project' });

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output when project key is missing', async () => {
    await claudeStop({});

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output when auth is not Cloud', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'server',
    });

    await claudeStop({ project: 'my-project' });

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
    });

    await claudeStop({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does not throw when buildSqaaJsonReport fails', async () => {
    buildSqaaJsonReportSpy.mockRejectedValue(new Error('git failed'));

    await claudeStop({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
