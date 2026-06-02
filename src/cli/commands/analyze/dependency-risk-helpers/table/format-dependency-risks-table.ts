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

import { dim, green, red, STATUS_ICONS } from '../../../../../ui/colors.js';
import type { RiskFilterDescription } from '../risk-filter.ts';
import type {
  DependencyRisksViewModel,
  ErrorVM,
  LicenseGroupVM,
  MalwareGroupVM,
  PackageIdentity,
  PackageSummaryVM,
  PackageVM,
  RiskGroupVM,
  RiskVM,
  SummaryVM,
  VulnerabilityGroupVM,
} from '../view-model';
import { appendLicenseGroup } from './format-table-license-group.ts';
import { appendMalwareGroup } from './format-table-malware-group.ts';
import { formatRecommendationLine } from './format-table-recommendation.ts';
import { appendVulnerabilityGroup } from './format-table-vulnerability-group.ts';

const MAX_LINE_WIDTH = 80;
const MAX_CHAINS_DISPLAYED = 3;
export const LINE_INDENT = '  ';
const CHAIN_CONTINUATION_INDENT = `${LINE_INDENT}    `;

const TYPE_LABEL_WIDTH = 'PROHIBITED_LICENSE'.length;
const SEVERITY_COUNT_WIDTH = 3;

export function formatDependencyRisksTable(vm: DependencyRisksViewModel): string {
  const lines: string[] = [];

  if (vm.packages.length > 0) {
    appendPackages(lines, vm.packages);
  } else {
    lines.push('No dependency risks found.');
  }

  lines.push('', '═'.repeat(MAX_LINE_WIDTH));
  appendErrors(lines, vm.errors);
  appendSummaryBlock(lines, vm.summary);

  return lines.join('\n');
}

function appendPackages(lines: string[], packages: PackageVM[]): void {
  for (const pkg of packages) {
    appendPackageBlock(lines, pkg);
  }
}

function appendPackageBlock(lines: string[], pkg: PackageVM): void {
  if (lines.length > 0) lines.push('');
  lines.push(packageHeader(pkg));
  if (pkg.filePaths.length > 0) {
    lines.push(`in: ${pkg.filePaths.join(', ')}`);
  }
  for (const line of transitiveChainLines(pkg.chains)) {
    lines.push(dim(line));
  }
  lines.push('');
  for (let i = 0; i < pkg.groups.length; i++) {
    if (i > 0) lines.push('');
    appendGroup(lines, pkg.groups[i]);
  }
}

function appendGroup(lines: string[], group: RiskGroupVM<RiskVM>): void {
  switch (group.type) {
    case 'MALWARE':
      appendMalwareGroup(lines, group as MalwareGroupVM);
      return;
    case 'PROHIBITED_LICENSE':
      appendLicenseGroup(lines, group as LicenseGroupVM);
      return;
    case 'VULNERABILITY':
      appendVulnerabilityGroup(lines, group as VulnerabilityGroupVM);
      return;
  }
}

function packageHeader(pkg: PackageVM): string {
  const baseName = pkg.package.label();
  const name = pkg.newlyIntroduced ? `${baseName} [NEW]` : baseName;
  const count = pkg.riskCount;
  const label = `── ${name} (${count} risk${count === 1 ? '' : 's'}) `;
  if (label.length >= MAX_LINE_WIDTH) {
    return `${label}─`;
  }
  return label + '─'.repeat(MAX_LINE_WIDTH - label.length);
}

function appendErrors(lines: string[], errors: ErrorVM[]): void {
  if (errors.length === 0) {
    return;
  }
  lines.push('', 'Errors:');
  for (const err of errors) {
    const prefix = `  [${err.code}]`;
    lines.push(err.path ? `${prefix} ${err.path}: ${err.message}` : `${prefix} ${err.message}`);
  }
}

function appendSummaryBlock(lines: string[], summary: SummaryVM): void {
  lines.push('', summaryHeader(summary), filteringByLine(summary.filter));
  for (const [type, counts] of summary.byType) {
    lines.push(summaryLineForType(type, counts));
  }
  appendRecommendationsSummary(lines, summary.packages);
}

function appendRecommendationsSummary(lines: string[], packages: PackageSummaryVM[]): void {
  if (packages.length === 0) return;
  lines.push('', 'Recommendations:');
  for (const pkg of packages) {
    lines.push(
      `  ${pkg.package.label()} (${pkg.riskCount} risk${pkg.riskCount === 1 ? '' : 's'}, highest severity ${pkg.highestSeverity})`,
    );
    for (const rec of pkg.recommendations.values()) {
      lines.push(`    ${formatRecommendationLine(rec)}`);
    }
  }
}

function summaryHeader(summary: SummaryVM): string {
  return `Summary: ${summary.packagesScanned} dependencies checked, ${summary.totalRisks} risks found`;
}

function filteringByLine(filter: RiskFilterDescription): string {
  const kept = formatStatuses(filter.effectiveStatuses);
  if (filter.discardedStatuses.length === 0) {
    return `Filtering by: ${kept}`;
  }
  const discarded = formatStatuses(filter.discardedStatuses);
  const discardedText = dim(`(discarded: ${discarded})`);
  return `Filtering by: ${kept} ${discardedText}`;
}

function formatStatuses(statuses: readonly string[]): string {
  return statuses.map((s) => s.toLowerCase()).join(', ');
}

function summaryLineForType(type: string, counts: Map<string, number>): string {
  const cells = [...counts].map(([severity, count]) => summarySeverityCell(severity, count));
  return `  ${type.padEnd(TYPE_LABEL_WIDTH)}  ${cells.join('    ')}`;
}

function summarySeverityCell(label: string, count: number): string {
  const icon = count === 0 ? green(STATUS_ICONS.done) : red(STATUS_ICONS.failed);
  return `${label} ${icon} ${String(count).padStart(SEVERITY_COUNT_WIDTH)}`;
}

function transitiveChainLines(chains: PackageIdentity[][]): string[] {
  if (chains.length === 0) {
    return [];
  }
  const displayed = chains.slice(0, MAX_CHAINS_DISPLAYED);
  const lines: string[] = [];
  for (const chain of displayed) {
    const labels = chain.map((id) => id.label());
    for (const line of wrapChain(labels, MAX_LINE_WIDTH)) {
      lines.push(line);
    }
  }
  const remaining = chains.length - displayed.length;
  if (remaining > 0) {
    lines.push(`${LINE_INDENT}and via ${remaining} others`);
  }
  return lines;
}

function wrapChain(labels: string[], maxWidth: number): string[] {
  if (labels.length === 0) {
    return [`${LINE_INDENT}via `];
  }
  const lines: string[] = [];
  let current = `${LINE_INDENT}via ${labels[0]}`;
  for (let i = 1; i < labels.length; i++) {
    const candidate = `${current} → ${labels[i]}`;
    if (candidate.length <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = `${CHAIN_CONTINUATION_INDENT}→ ${labels[i]}`;
    }
  }
  lines.push(current);
  return lines;
}
