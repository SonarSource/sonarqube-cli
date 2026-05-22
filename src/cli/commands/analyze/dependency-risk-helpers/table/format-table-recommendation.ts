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

import { bold, red } from '../../../../../ui/colors.js';
import type { VersionOptionDescriptionCode } from '../sca-scanner.ts';
import type { FixVersionVM, RecommendationVM } from '../view-model';

const MAX_PACKAGE_FIXES = 2;

const DESCRIPTION_CODE_LABEL: Record<VersionOptionDescriptionCode, string | null> = {
  LATEST_STABLE: 'latest stable',
  LATEST_COMPLETE: 'latest',
  LATEST_PRERELEASE: 'latest prerelease',
  LATEST_PARTIAL: 'latest',
  NEAREST_COMPLETE: 'nearest',
  NEAREST_PARTIAL: 'nearest',
  VERSION_IN_USE: null,
  UNKNOWN: null,
};

export function formatRecommendationLine(rec: RecommendationVM): string {
  switch (rec.action) {
    case 'REMOVE_PACKAGE':
      return red(bold('Remove this package and notify your information security team'));
    case 'REVIEW_LICENSE':
      return bold('Review the license usage');
    case 'UPGRADE_PACKAGE':
      return `${bold('Recommended versions without known vulnerabilities:')} ${formatPackageFixes(rec.fixVersions)}`;
    case 'NO_FIX_AVAILABLE':
      return bold('No recommended version without known vulnerabilities');
  }
}

function formatPackageFixes(fixes: FixVersionVM[]): string {
  return fixes.slice(0, MAX_PACKAGE_FIXES).map(formatFixVersion).join(' | ');
}

function formatFixVersion(fix: FixVersionVM): string {
  const label = DESCRIPTION_CODE_LABEL[fix.descriptionCode];
  return label ? `${fix.version} (${label})` : fix.version;
}
