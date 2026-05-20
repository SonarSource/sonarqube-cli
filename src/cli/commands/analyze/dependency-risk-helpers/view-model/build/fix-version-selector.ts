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

import type {
  AnalyzeProjectIssue,
  VersionOption,
  VersionOptionDescriptionCode,
} from '../../sca-scanner.ts';
import type { FixVersionVM } from '../fix-version.ts';

const DESCRIPTION_CODE_ORDER: Record<VersionOptionDescriptionCode, number> = {
  LATEST_STABLE: 0,
  LATEST_COMPLETE: 1,
  LATEST_PRERELEASE: 2,
  LATEST_PARTIAL: 3,
  NEAREST_COMPLETE: 4,
  NEAREST_PARTIAL: 5,
  VERSION_IN_USE: 6,
  UNKNOWN: 7,
};

const EXCLUDED_DESCRIPTION_CODES: ReadonlySet<VersionOptionDescriptionCode> = new Set([
  'VERSION_IN_USE',
  'UNKNOWN',
]);

export function selectIssuePartialFixes(issue: AnalyzeProjectIssue): FixVersionVM[] {
  const partials = (issue.versionOptions ?? []).filter(
    (o) => o.fixLevel === 'PARTIAL' && !EXCLUDED_DESCRIPTION_CODES.has(o.descriptionCode),
  );
  return sortByDescriptionCode(partials).map(toFixVersionVM);
}

export function selectPackageCompleteFixes(issues: AnalyzeProjectIssue[]): FixVersionVM[] {
  const byVersion = new Map<string, VersionOption>();
  for (const issue of issues) {
    for (const option of issue.versionOptions ?? []) {
      if (option.fixLevel !== 'COMPLETE') continue;
      if (EXCLUDED_DESCRIPTION_CODES.has(option.descriptionCode)) continue;
      if (!byVersion.has(option.version)) byVersion.set(option.version, option);
    }
  }
  return sortByDescriptionCode([...byVersion.values()]).map(toFixVersionVM);
}

function sortByDescriptionCode(options: VersionOption[]): VersionOption[] {
  return [...options].sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
}

function toFixVersionVM(option: VersionOption): FixVersionVM {
  return {
    version: option.version,
    descriptionCode: option.descriptionCode,
    vulnerabilityIds: option.vulnerabilityIds,
  };
}
