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

import type { DependencyRisk, DependencyRiskType } from './dependency-risk.ts';

const STATUS_DISCLAIMER =
  'Note: SonarQube Server Status (Accepted, False Positive) is not currently displayed.';

const TYPE_LABELS: Record<DependencyRiskType, string> = {
  VULNERABILITY: 'Vulnerability',
  PROHIBITED_LICENSE: 'License',
  MALWARE: 'Malware',
};

export function formatDependencyRisksTable(
  risks: DependencyRisk[],
  packagesScanned: number,
): string {
  const lines: string[] = [
    STATUS_DISCLAIMER,
    '',
    `Scan Summary: ${packagesScanned} dependencies checked. ${risks.length} risks found`,
  ];

  if (risks.length === 0) {
    return lines.join('\n');
  }

  lines.push('');

  const rows = risks.map((risk) => ({
    severity: risk.severity,
    type: TYPE_LABELS[risk.type],
    pkg: risk.packageName,
    manifest: risk.dependencyFilePaths.join(', '),
    issue: issueCell(risk),
    remediation: remediationCell(risk),
  }));

  const widths = {
    severity: columnWidth('SEVERITY', rows, (r) => r.severity),
    type: columnWidth('TYPE', rows, (r) => r.type),
    pkg: columnWidth('PACKAGE', rows, (r) => r.pkg),
    manifest: columnWidth('MANIFEST', rows, (r) => r.manifest),
    issue: columnWidth('ISSUE', rows, (r) => r.issue),
  };

  const header = [
    'SEVERITY'.padEnd(widths.severity),
    'TYPE'.padEnd(widths.type),
    'PACKAGE'.padEnd(widths.pkg),
    'MANIFEST'.padEnd(widths.manifest),
    'ISSUE'.padEnd(widths.issue),
    'REMEDIATION',
  ].join('  ');

  const separator = '-'.repeat(header.length);

  lines.push(header, separator);
  for (const row of rows) {
    lines.push(
      [
        row.severity.padEnd(widths.severity),
        row.type.padEnd(widths.type),
        row.pkg.padEnd(widths.pkg),
        row.manifest.padEnd(widths.manifest),
        row.issue.padEnd(widths.issue),
        row.remediation,
      ]
        .join('  ')
        .trimEnd(),
    );
  }
  lines.push(separator);

  return lines.join('\n');
}

function issueCell(risk: DependencyRisk): string {
  switch (risk.type) {
    case 'VULNERABILITY':
      return risk.vulnerabilityId ?? '';
    case 'PROHIBITED_LICENSE':
      return risk.licenseExpression ?? '';
    case 'MALWARE':
      return 'Malicious package';
  }
}

function remediationCell(risk: DependencyRisk): string {
  switch (risk.type) {
    case 'VULNERABILITY':
      return risk.fixedVersions && risk.fixedVersions.length > 0
        ? `Upgrade to ${risk.fixedVersions.map((f) => f.version).join(', ')}`
        : '';
    case 'PROHIBITED_LICENSE':
      return '';
    case 'MALWARE':
      return 'Remove dependency';
  }
}

function columnWidth<T>(header: string, rows: T[], pick: (r: T) => string): number {
  return Math.max(header.length, ...rows.map((r) => pick(r).length));
}
