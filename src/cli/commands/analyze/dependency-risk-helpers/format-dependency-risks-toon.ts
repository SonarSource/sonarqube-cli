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

import { encode as encodeToToon } from '@toon-format/toon';

import type { DependencyRisksViewModel } from './view-model';
import { PackageIdentity } from './view-model';

export function formatDependencyRisksToon(project: string, vm: DependencyRisksViewModel): string {
  const packages = vm.packages.map((pkg) => ({
    ...pkg,
    chains: pkg.chains.map((group) => ({
      parentPackage: group.parentPackage ?? 'direct',
      totalRoutes: group.chains.length,
    })),
  }));
  return encodeToToon(normalize({ project, ...vm, packages }), {
    replacer: (key, value) => {
      if (key === 'partialFixes') return undefined;
      if (key === 'vulnerabilityIds' && Array.isArray(value) && value.length === 0)
        return undefined;
      return value;
    },
  });
}

function normalize(value: unknown): unknown {
  if (value instanceof PackageIdentity) return value.purl;
  if (value instanceof Map)
    return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), normalize(v)]));
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}
