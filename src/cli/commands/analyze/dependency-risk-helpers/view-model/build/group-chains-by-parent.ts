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

import type { ChainGroupVM } from '../chain-group.ts';
import type { PackageIdentity } from '../package.ts';

export function groupChainsByParent(chains: PackageIdentity[][]): ChainGroupVM[] {
  const groups = new Map<string, PackageIdentity[][]>();
  for (const chain of chains) {
    const parent = chain.length >= 2 ? chain.at(-2)!.purl : '';
    const group = groups.get(parent) ?? [];
    group.push(chain);
    groups.set(parent, group);
  }
  return [...groups.values()]
    .map((group) => ({
      parentPackage: group[0].length >= 2 ? (group[0].at(-2) ?? null) : null,
      chains: group.slice().sort((a, b) => a.length - b.length),
    }))
    .sort((a, b) => a.chains[0].length - b.chains[0].length);
}
