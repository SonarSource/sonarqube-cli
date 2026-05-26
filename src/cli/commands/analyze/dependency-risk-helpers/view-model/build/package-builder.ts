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

import logger from '../../../../../../lib/logger.ts';
import type { RiskFilterPredicate } from '../../risk-filter.ts';
import type { AnalyzeProjectRelease } from '../../sca-scanner.ts';
import { PackageIdentity, type PackageVM } from '../package.ts';
import { buildGroups } from './group-builder.ts';

export function buildPackageIdentityMap(
  releases: AnalyzeProjectRelease[],
): Map<string, PackageIdentity> {
  const out = new Map<string, PackageIdentity>();
  for (const release of releases) {
    out.set(
      release.packageUrl,
      new PackageIdentity(
        release.packageUrl,
        release.packageName,
        release.version,
        release.packageManager,
      ),
    );
  }
  return out;
}

export function buildPackageVM(
  release: AnalyzeProjectRelease,
  filter: RiskFilterPredicate,
  identityByPurl: Map<string, PackageIdentity>,
): PackageVM | null {
  const groups = buildGroups(release, filter);
  if (groups.length === 0) return null;
  const riskCount = groups.reduce((n, g) => n + g.selectedRisks.length, 0);
  return {
    package: identityByPurl.get(release.packageUrl)!,
    newlyIntroduced: release.newlyIntroduced,
    riskCount,
    filePaths: release.dependencyFilePaths,
    chains: resolveChains(release, identityByPurl),
    groups,
  };
}

function resolveChains(
  release: AnalyzeProjectRelease,
  identityByPurl: Map<string, PackageIdentity>,
): PackageIdentity[][] {
  const resolved: PackageIdentity[][] = [];
  for (const chain of release.dependencyChains) {
    const ids = resolveChain(chain, release, identityByPurl);
    if (ids !== null) resolved.push(ids);
  }
  return resolved.sort((a, b) => a.length - b.length);
}

function resolveChain(
  chain: string[],
  release: AnalyzeProjectRelease,
  identityByPurl: Map<string, PackageIdentity>,
): PackageIdentity[] | null {
  const ids: PackageIdentity[] = [];
  for (const purl of chain) {
    const id = identityByPurl.get(purl);
    if (id === undefined) {
      logger.debug(`Skipping dependency chain for ${release.packageUrl}: unknown purl ${purl}`);
      return null;
    }
    ids.push(id);
  }
  return ids;
}
