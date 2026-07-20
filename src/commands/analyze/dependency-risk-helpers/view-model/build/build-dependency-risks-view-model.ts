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

import type { RiskFilter } from '../../risk-filter.ts';
import type { AnalyzeProjectResponse } from '../../sca-scanner.ts';
import type { DependencyRisksViewModel } from '../dependency-risks-view-model.ts';
import type { PackageVM } from '../package.ts';
import { buildErrorVM } from './error-builder.ts';
import { buildPackageIdentityMap, buildPackageVM } from './package-builder.ts';
import { buildSummaryVM } from './summary-builder.ts';

export function buildDependencyRisksViewModel(
  response: AnalyzeProjectResponse,
  filter: RiskFilter,
): DependencyRisksViewModel {
  const identityByPurl = buildPackageIdentityMap(response.releases);
  const packages: PackageVM[] = [];
  for (const release of response.releases) {
    const pkg = buildPackageVM(release, filter.predicate, identityByPurl);
    if (pkg !== null) packages.push(pkg);
  }
  packages.sort((a, b) => a.package.compareTo(b.package));
  return {
    packages,
    errors: response.errors.map(buildErrorVM),
    summary: buildSummaryVM(packages, response.releases.length, filter.description),
  };
}
