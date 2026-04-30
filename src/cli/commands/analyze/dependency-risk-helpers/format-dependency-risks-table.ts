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

import type { DependencyRisk, DependencyRiskVersionOption } from './dependency-risk.ts';
import type { AnalysisErrorResource } from './sca-scanner.ts';

const SEVERITY_WIDTH = 9;
const STATUS_WIDTH = 8;
const SEPARATOR_WIDTH = 65;
const INDENT = ' '.repeat(SEVERITY_WIDTH + 1 + STATUS_WIDTH + 1);

export function formatDependencyRisksTable(
  risks: DependencyRisk[],
  packagesScanned: number,
  errors: AnalysisErrorResource[],
): string {
  const lines: string[] = [
    `Scan Summary: ${packagesScanned} dependencies checked. ${risks.length} risks found`,
  ];

  if (risks.length === 0) {
    appendErrors(lines, errors);
    return lines.join('\n');
  }

  lines.push('');
  lines.push('SEVERITY'.padEnd(SEVERITY_WIDTH) + ' ' + 'STATUS'.padEnd(STATUS_WIDTH) + ' PACKAGE');
  lines.push('═'.repeat(SEPARATOR_WIDTH));

  for (const [manifest, group] of groupByManifest(risks)) {
    lines.push('');
    lines.push(groupHeader(manifest, group.length));
    for (let i = 0; i < group.length; i++) {
      const risk = group[i];
      const pkg = risk.newlyIntroduced ? `${risk.packageName} [NEW]` : risk.packageName;
      lines.push(
        risk.severity.padEnd(SEVERITY_WIDTH) + ' ' + risk.status.padEnd(STATUS_WIDTH) + ' ' + pkg,
      );
      const issue = issueCell(risk);
      const remediation = remediationCell(risk);
      lines.push(remediation ? `${INDENT}${issue} → ${remediation}` : `${INDENT}${issue}`);
      for (const chain of transitiveChains(risk)) {
        lines.push(`${INDENT}via ${chain}`);
      }
      if (i < group.length - 1) {
        lines.push('');
      }
    }
  }

  lines.push('');
  lines.push('═'.repeat(SEPARATOR_WIDTH));
  appendErrors(lines, errors);

  return lines.join('\n');
}

const NO_MANIFEST_KEY = '(no manifest)';

function groupByManifest(risks: DependencyRisk[]): Map<string, DependencyRisk[]> {
  const groups = new Map<string, DependencyRisk[]>();
  for (const risk of risks) {
    const keys = risk.dependencyFilePaths.length > 0 ? risk.dependencyFilePaths : [NO_MANIFEST_KEY];
    for (const key of keys) {
      const existing = groups.get(key);
      if (existing) {
        existing.push(risk);
      } else {
        groups.set(key, [risk]);
      }
    }
  }
  const orphans = groups.get(NO_MANIFEST_KEY);
  if (orphans) {
    groups.delete(NO_MANIFEST_KEY);
    groups.set(NO_MANIFEST_KEY, orphans);
  }
  return groups;
}

function groupHeader(manifest: string, count: number): string {
  const label = `── ${manifest} (${count} risk${count === 1 ? '' : 's'}) `;
  if (label.length >= SEPARATOR_WIDTH) {
    return `${label}─`;
  }
  return label + '─'.repeat(SEPARATOR_WIDTH - label.length);
}

function appendErrors(lines: string[], errors: AnalysisErrorResource[]): void {
  if (errors.length === 0) {
    return;
  }
  lines.push('', 'Errors:');
  for (const err of errors) {
    const prefix = `  [${err.code}]`;
    lines.push(err.path ? `${prefix} ${err.path}: ${err.message}` : `${prefix} ${err.message}`);
  }
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
    case 'MALWARE':
      return 'Remove dependency';
    case 'PROHIBITED_LICENSE':
      return 'Review usage';
    case 'VULNERABILITY':
      return chooseUpgradeRemediation(risk);
  }
}

function chooseUpgradeRemediation(risk: DependencyRisk): string {
  const options = risk.versionOptions;
  if (!options || options.length === 0) {
    return '';
  }

  const target =
    options.find((o) => o.descriptionCode === 'NEAREST_COMPLETE') ??
    options.find((o) => o.descriptionCode === 'NEAREST_PARTIAL') ??
    options.find((o) => o.fixLevel === 'COMPLETE' && o.descriptionCode !== 'VERSION_IN_USE') ??
    options.find((o) => o.fixLevel === 'PARTIAL' && o.descriptionCode !== 'VERSION_IN_USE');

  if (!target) {
    return '';
  }

  const fixed = fixedCves(options, target, risk.vulnerabilityId);
  const level = target.fixLevel.toLowerCase();
  return fixed.length > 0
    ? `Upgrade to ${target.version} (${level}, fixes ${fixed.join(', ')})`
    : `Upgrade to ${target.version} (${level})`;
}

function transitiveChains(risk: DependencyRisk): string[] {
  const chains = risk.dependencyChains;
  if (chains.length === 0 || chains.some((c) => c.length < 2)) {
    return [];
  }
  return chains.map((chain) => chain.map(stripPurlPrefix).join(' → '));
}

function stripPurlPrefix(entry: string): string {
  return entry.replace(/^pkg:[^/]+\//, '');
}

function fixedCves(
  options: DependencyRiskVersionOption[],
  target: DependencyRiskVersionOption,
  subjectVulnerabilityId: string | undefined,
): string[] {
  const versionInUse = options.find((o) => o.descriptionCode === 'VERSION_IN_USE');
  if (versionInUse) {
    const remaining = new Set(target.vulnerabilityIds);
    return versionInUse.vulnerabilityIds.filter((cve) => !remaining.has(cve));
  }
  return subjectVulnerabilityId ? [subjectVulnerabilityId] : [];
}
