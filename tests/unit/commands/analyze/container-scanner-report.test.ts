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

import { describe, expect, it } from 'bun:test';

import {
  containerScanErrorReport,
  countContainerAnalysisErrors,
  formatContainerScanTable,
  parseContainerScanReport,
} from '@/commands/analyze/container-scanner-report.ts';

const configuration = {
  imageInput: './my-image.tar',
  failOn: 'high' as const,
  timeoutSecs: 300,
  registry: null,
  repository: null,
  tag: null,
};

describe('container scanner report', () => {
  it.each([
    [0, 0],
    [1, 51],
    [2, 1],
  ] as const)(
    'maps native exit %d to public exit %d while retaining the report',
    (exitCode, publicCode) => {
      const issues = exitCode === 1 ? [{ severity: 'high' as const, cweIds: ['CWE-1'] }] : [];
      const errors = exitCode === 2 ? [{ kind: 'submission', message: 'Scan failed' }] : [];
      const report = { issues, errors, configuration, exitCode };
      expect(
        parseContainerScanReport({ exitCode, stdout: JSON.stringify(report), stderr: '' }),
      ).toEqual({
        ...report,
        exitCode: publicCode,
      });
    },
  );

  it.each([
    '',
    '[',
    JSON.stringify({ issues: [], errors: [], configuration, exitCode: 1 }),
    JSON.stringify({ issues: [{ severity: 'unknown' }], errors: [], configuration, exitCode: 0 }),
    JSON.stringify({ issues: [], errors: [null], configuration, exitCode: 0 }),
    JSON.stringify({ issues: [], errors: [], configuration: null, exitCode: 0 }),
  ])('rejects invalid or inconsistent output (%s)', (stdout) => {
    expect(parseContainerScanReport({ exitCode: 0, stdout, stderr: '' })).toBeUndefined();
  });

  it('does not accept a valid report without a recognized process exit code', () => {
    const stdout = JSON.stringify({ issues: [], errors: [], configuration, exitCode: 0 });
    expect(parseContainerScanReport({ exitCode: null, stdout, stderr: '' })).toBeUndefined();
    expect(parseContainerScanReport({ exitCode: 3, stdout, stderr: '' })).toBeUndefined();
  });

  it('groups by package identity and reports threshold counts without filtering findings', () => {
    const report = parseContainerScanReport({
      exitCode: 1,
      stdout: JSON.stringify({
        issues: [
          {
            packageUrl: 'pkg:apk/alpine/apk-tools@3.0.6-r0',
            packageName: 'alpine/apk-tools',
            version: '3.0.6-r0',
            severity: 'medium',
            key: 'CVE-2024-0001',
          },
          {
            packageUrl: 'pkg:apk/alpine/apk-tools@3.0.6-r0',
            packageName: 'alpine/apk-tools',
            version: '3.0.6-r0',
            severity: 'high',
            vulnerabilityId: 'CVE-2025-0001',
            cvssScore: '8.1',
          },
          { packageName: 'b', version: '1.0', severity: 'blocker' },
        ],
        errors: [],
        configuration,
        exitCode: 1,
      }),
      stderr: '',
    });
    expect(report).toBeDefined();
    const output = formatContainerScanTable(report!, '');
    expect(output).toContain('alpine/apk-tools@3.0.6-r0 (2 findings)');
    expect(output).toContain('CVSS 8.1  CVE-2025-0001');
    expect(output).toContain('CVE-2024-0001');
    expect(output).toContain('b@1.0 (1 finding)');
    expect(output).toContain('Unknown finding');
    expect(output).toContain('3 findings in 2 affected packages');
    expect(output).toContain('Highest severity: BLOCKER');
    expect(output).toContain('2 findings reached the threshold');
  });

  it('qualifies zero findings for structured errors or the pinned skipped-package warning', () => {
    const report = parseContainerScanReport({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [], errors: [], configuration, exitCode: 0 }),
      stderr: '',
    })!;
    expect(formatContainerScanTable(report, '')).toContain('No findings.');
    expect(
      formatContainerScanTable(
        report,
        'WARNING: the backend skipped 1 package(s): unsupported format',
      ),
    ).toContain('No findings in the packages analyzed.');
    expect(formatContainerScanTable(report, 'WARNING: the backend skipped 1 package(s)')).toContain(
      'No findings in the packages analyzed.',
    );
    const partialReport = {
      ...report,
      errors: [{ kind: 'backendAnalysis', message: 'Partial data' }],
    };
    expect(formatContainerScanTable(partialReport, '')).toContain(
      'No findings in the packages analyzed.',
    );
    expect(countContainerAnalysisErrors(partialReport)).toBe(1);
  });

  it('renders a wrapper failure as a failed scan, without a clean scan message', () => {
    const report = containerScanErrorReport(
      './my-image.tar',
      { failOn: 'high', timeoutSecs: 300 },
      {
        kind: 'invalidScannerReport',
        message: 'The scanner report is invalid.',
      },
    );
    expect(report).toMatchObject({ configuration, exitCode: 1 });
    expect(formatContainerScanTable(report, '')).toContain('Container scan failed.');
    expect(countContainerAnalysisErrors(report)).toBe(0);
  });
});
