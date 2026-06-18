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

import { describe, expect, it, spyOn } from 'bun:test';

import {
  formatSqaaJsonReportForHook,
  writeStopHookOutput,
} from '../../../../../src/cli/commands/hook/format-sqaa-hook-context';

describe('writeStopHookOutput', () => {
  it('writes Stop hookEventName and additionalContext as JSON on stdout', () => {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    writeStopHookOutput('findings here');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(output.hookSpecificOutput.additionalContext).toBe('findings here');

    stdoutSpy.mockRestore();
  });
});

describe('formatSqaaJsonReportForHook', () => {
  it('returns null for an empty change set', () => {
    expect(
      formatSqaaJsonReportForHook({
        files: [],
        ignored: [],
        failures: [],
        skipped: [],
        summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
      }),
    ).toBeNull();
  });

  it('surfaces skipped files when analysis did not complete any file', () => {
    expect(
      formatSqaaJsonReportForHook({
        files: [],
        ignored: [],
        failures: [],
        skipped: ['src/a.ts', 'src/b.ts'],
        summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 2 },
      }),
    ).toBe('Skipped 2 file(s) (analysis not completed).');
  });

  it('surfaces per-file analysis errors when totalIssues is zero', () => {
    const text = formatSqaaJsonReportForHook({
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
    });

    expect(text).not.toContain('no issues found');
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('FILE_NOT_FOUND');
    expect(text).toContain('File not indexed');
  });

  it('surfaces ignored-only change sets without claiming no issues found', () => {
    const text = formatSqaaJsonReportForHook({
      files: [],
      ignored: [{ path: 'image.png', reason: 'binary' }],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    });

    expect(text).not.toContain('no issues found');
    expect(text).toContain('excluded (binary or oversized)');
    expect(text).toContain('image.png');
    expect(text).toContain('binary');
  });

  it('appends excluded files when analysis completed with no issues', () => {
    const text = formatSqaaJsonReportForHook({
      files: [{ path: 'src/a.ts', issues: [], errors: null }],
      ignored: [{ path: 'large.bin', reason: 'oversized' }],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    });

    expect(text).toContain('No issues found');
    expect(text).toContain('Excluded 1 file(s)');
    expect(text).toContain('large.bin');
    expect(text).toContain('oversized');
  });
});
