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
  EXIT_CODE_CONTAINER_THRESHOLD_REACHED,
  formatContainerScanJson,
  formatContainerScanTable,
  hasSkippedPackagesWarning,
  parseContainerScanReport,
  sanitizeScannerTerminalText,
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
    [1, EXIT_CODE_CONTAINER_THRESHOLD_REACHED],
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
    JSON.stringify({ issues: [{ severity: 'none' }], errors: [], configuration, exitCode: 0 }),
    JSON.stringify({
      issues: [{ severity: 'high', packageName: 123 }],
      errors: [],
      configuration,
      exitCode: 0,
    }),
    JSON.stringify({ issues: [], errors: [null], configuration, exitCode: 0 }),
    JSON.stringify({ issues: [], errors: [], configuration: null, exitCode: 0 }),
    JSON.stringify({
      issues: [],
      errors: [],
      configuration: { ...configuration, timeoutSecs: 0 },
      exitCode: 0,
    }),
    JSON.stringify({
      issues: [],
      errors: [],
      configuration: { ...configuration, timeoutSecs: 1.5 },
      exitCode: 0,
    }),
    JSON.stringify({
      issues: [],
      errors: [],
      configuration: { ...configuration, tag: 42 },
      exitCode: 0,
    }),
  ])('rejects invalid or inconsistent output (%s)', (stdout) => {
    expect(parseContainerScanReport({ exitCode: 0, stdout, stderr: '' })).toBeUndefined();
  });

  it('rejects reports whose native exit code contradicts the configured fail threshold', () => {
    const contradictoryReports = [
      { issues: [], errors: [], configuration, exitCode: 1 },
      {
        issues: [{ severity: 'blocker', vulnerabilityId: 'CVE-2025-0001' }],
        errors: [],
        configuration: { ...configuration, failOn: 'none' },
        exitCode: 1,
      },
      {
        issues: [{ severity: 'medium', vulnerabilityId: 'CVE-2025-0002' }],
        errors: [],
        configuration,
        exitCode: 1,
      },
      {
        issues: [{ severity: 'high', vulnerabilityId: 'CVE-2025-0003' }],
        errors: [],
        configuration,
        exitCode: 0,
      },
    ];
    for (const report of contradictoryReports) {
      expect(
        parseContainerScanReport({
          exitCode: report.exitCode,
          stdout: JSON.stringify(report),
          stderr: '',
        }),
      ).toBeUndefined();
    }
  });

  it('does not accept a valid report without a recognized process exit code', () => {
    const stdout = JSON.stringify({ issues: [], errors: [], configuration, exitCode: 0 });
    expect(parseContainerScanReport({ exitCode: null, stdout, stderr: '' })).toBeUndefined();
    expect(parseContainerScanReport({ exitCode: 3, stdout, stderr: '' })).toBeUndefined();
  });

  it('escapes terminal and bidi controls in JSON without changing parsed values', () => {
    const controls = '\u001b[31m\u0007\u007f\u009b\u202e\u2066';
    const report = parseContainerScanReport({
      exitCode: 1,
      stdout: JSON.stringify({
        issues: [
          {
            severity: 'high',
            packageName: `example${controls}`,
            version: '1.0',
            vulnerabilityId: 'CVE-2025-0001',
          },
        ],
        errors: [],
        configuration,
        exitCode: 1,
      }),
      stderr: '',
    })!;

    const formatted = formatContainerScanJson(report);
    expect(formatted).toContain(String.raw`\u001b[31m\u0007\u007f\u009b\u202e\u2066`);
    expect(formatted).not.toMatch(/[\u007F-\u009F\p{Bidi_Control}]/u);
    expect(JSON.parse(formatted)).toEqual(report);
  });

  it('strips terminal escape sequences, controls, and bidi characters per line', () => {
    const raw = 'Line 1 \u001b[31mred\u001b[0m\u0007\u009b31m\u202e\r\nTruncated \u001b[31\nLine 3';
    expect(sanitizeScannerTerminalText(raw)).toBe('Line 1 red\nTruncated \nLine 3');
  });

  it('groups deterministically, aligns CVSS columns, and reports threshold counts without filtering', () => {
    const report = parseContainerScanReport({
      exitCode: 1,
      stdout: JSON.stringify({
        issues: [
          {
            packageUrl: 'pkg:apk/alpine/apk-tools@3.0.6-r0',
            packageName: 'alpine/apk-tools',
            version: '3.0.6-r0',
            severity: 'medium',
            key: 'CVE-2024-0002',
          },
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
          {
            packageName: 'b',
            version: '1.0',
            severity: 'blocker',
            vulnerabilityId: 'CVE-2025-9999',
            cvssScore: '10.0',
          },
        ],
        errors: [],
        configuration,
        exitCode: 1,
      }),
      stderr: '',
    });
    expect(report).toBeDefined();
    const output = formatContainerScanTable(report!);
    const lines = output.split('\n');

    expect(output.indexOf('── b@1.0 (1 finding) ──')).toBeLessThan(
      output.indexOf('── alpine/apk-tools@3.0.6-r0 (3 findings) ──'),
    );
    expect(output.indexOf('CVE-2024-0001')).toBeLessThan(output.indexOf('CVE-2024-0002'));

    const blockerRow = lines.find((line) => line.includes('CVE-2025-9999'))!;
    const highRow = lines.find((line) => line.includes('CVE-2025-0001'))!;
    const mediumRow = lines.find((line) => line.includes('CVE-2024-0001'))!;
    expect(blockerRow).toBe('  BLOCKER  CVSS  10  CVE-2025-9999');
    expect(highRow).toBe('  HIGH     CVSS 8.1  CVE-2025-0001');
    expect(mediumRow).toBe('  MEDIUM             CVE-2024-0001');
    expect(blockerRow.indexOf('CVE-')).toBe(highRow.indexOf('CVE-'));
    expect(highRow.indexOf('CVE-')).toBe(mediumRow.indexOf('CVE-'));

    expect(output).toContain('4 findings in 2 affected packages');
    expect(output).toContain('Highest severity: BLOCKER');
    expect(output).toContain('Fail threshold: HIGH · 2 findings reached the threshold');
  });

  it('omits the CVSS column when no findings carry a CVSS score and handles --fail-on none', () => {
    const report = parseContainerScanReport({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [{ packageName: 'zlib', version: '1.3', severity: 'high', key: 'CVE-2025-0001' }],
        errors: [],
        configuration: { ...configuration, failOn: 'none' },
        exitCode: 0,
      }),
      stderr: '',
    })!;

    expect(report.exitCode).toBe(0);
    const output = formatContainerScanTable(report);
    expect(output).toContain('  HIGH     CVE-2025-0001');
    expect(output).toContain('Highest severity: HIGH');
    expect(output).toContain('Fail threshold: disabled');
  });

  it('retains below-threshold findings on a passing scan with zero threshold hits', () => {
    const report = parseContainerScanReport({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [
          { packageName: 'musl', version: '1.2.5', severity: 'medium', key: 'CVE-2025-0010' },
          { packageName: 'musl', version: '1.2.5', severity: 'low', key: 'CVE-2025-0011' },
        ],
        errors: [],
        configuration,
        exitCode: 0,
      }),
      stderr: '',
    })!;

    expect(report.exitCode).toBe(0);
    const output = formatContainerScanTable(report);
    expect(output).toContain('── musl@1.2.5 (2 findings) ──');
    expect(output).toContain('Highest severity: MEDIUM');
    expect(output).toContain('Fail threshold: HIGH · 0 findings reached the threshold');
  });

  it('sanitizes cells before applying fallbacks and coalesces unknown packages cleanly', () => {
    const report = parseContainerScanReport({
      exitCode: 1,
      stdout: JSON.stringify({
        issues: [
          {
            packageUrl: 'pkg:apk/alpine/curl@8.0',
            severity: 'low',
            vulnerabilityId: '\u001b[31m',
            key: 'CVE-2025-0001',
            cvssScore: '\u001b[31m',
          },
          {
            packageUrl: 'pkg:apk/alpine/curl@8.0',
            packageName: 'alpine/curl',
            version: '8.0',
            severity: 'high',
            vulnerabilityId: '   ',
            key: '\u001b[31m',
          },
          {
            packageName: '\u001b[31m',
            version: '1.0',
            severity: 'medium',
            vulnerabilityId: 'CVE-2025-0002',
          },
          {
            packageName: '   ',
            version: '2.0',
            severity: 'info',
            vulnerabilityId: 'CVE-2025-0003',
          },
          {
            packageName: 'openssl',
            version: '\u001b[31m',
            severity: 'low',
            vulnerabilityId: 'CVE-2025-0004',
          },
          {
            packageUrl: 'pkg:generic/libfoo@0.1',
            severity: 'low',
            vulnerabilityId: 'CVE-2025-0005',
          },
        ],
        errors: [],
        configuration,
        exitCode: 1,
      }),
      stderr: '',
    })!;

    const output = formatContainerScanTable(report);
    expect(output).toContain('── alpine/curl@8.0 (2 findings) ──');
    expect(output).toContain('  HIGH     Unknown finding');
    expect(output).toContain('  LOW      CVE-2025-0001');
    expect(output).toContain('── Unknown package (2 findings) ──');
    expect(output).toContain('── openssl (1 finding) ──');
    expect(output).toContain('── pkg:generic/libfoo@0.1 (1 finding) ──');
    expect(output).not.toContain('@1.0');
    expect(output).not.toContain('openssl@');
    expect(output).not.toContain('CVSS');
    expect(output).toContain('6 findings in 4 affected packages');
  });

  it('qualifies zero findings for structured errors or skipped-package warnings (including ANSI)', () => {
    const report = parseContainerScanReport({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [], errors: [], configuration, exitCode: 0 }),
      stderr: '',
    })!;
    expect(formatContainerScanTable(report, '')).toContain('No findings.');
    expect(hasSkippedPackagesWarning('')).toBeFalse();
    expect(
      formatContainerScanTable(
        report,
        'WARNING: the backend skipped 1 package(s): unsupported format',
      ),
    ).toContain('No findings in the packages analyzed.');
    expect(formatContainerScanTable(report, 'WARNING: the backend skipped 1 package(s)')).toContain(
      'No findings in the packages analyzed.',
    );
    const ansiWarning = '\u001b[33mWARNING: the backend skipped 2 package(s): NO_VERSION\u001b[0m';
    expect(hasSkippedPackagesWarning(ansiWarning)).toBeTrue();
    expect(formatContainerScanTable(report, ansiWarning)).toContain(
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

  it('retains findings and threshold outcome on a partial scan with structured errors', () => {
    const report = parseContainerScanReport({
      exitCode: 1,
      stdout: JSON.stringify({
        issues: [{ packageName: 'busybox', version: '1.37', severity: 'high', key: 'CVE-2025-1' }],
        errors: [{ kind: 'backendAnalysis', message: 'Partial data' }],
        configuration,
        exitCode: 1,
      }),
      stderr: 'WARNING: the backend skipped 1 package(s): NO_VERSION',
    })!;

    expect(report.exitCode).toBe(EXIT_CODE_CONTAINER_THRESHOLD_REACHED);
    expect(countContainerAnalysisErrors(report)).toBe(1);
    const output = formatContainerScanTable(report, 'WARNING: the backend skipped 1 package(s)');
    expect(output).toContain('── busybox@1.37 (1 finding) ──');
    expect(output).toContain('Fail threshold: HIGH · 1 finding reached the threshold');
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

  it.each([129, 130, 143] as const)(
    'preserves cancellation exit %s in JSON and the table',
    (exitCode) => {
      const report = containerScanErrorReport(
        './my-image.tar',
        { timeoutSecs: 300, failOn: 'high' },
        { kind: 'scannerExecution', message: 'Container scan cancelled.' },
        exitCode,
      );

      expect(JSON.parse(formatContainerScanJson(report))).toMatchObject({ exitCode, issues: [] });
      expect(formatContainerScanTable(report, '')).toContain('Container scan cancelled.');
    },
  );
});
