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

import { groupChainsByParent } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build/group-chains-by-parent.ts';
import { pkgId } from '../../_helpers.ts';

describe('groupChainsByParent', () => {
  it('returns an empty array for no chains', () => {
    expect(groupChainsByParent([])).toEqual([]);
  });

  it('produces a group with null parentPackage for a direct dependency', () => {
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([[target]]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parentPackage).toBeNull();
    expect(groups[0].chains).toEqual([[target]]);
  });

  it('sets parentPackage to the direct parent for a two-hop chain', () => {
    const parent = pkgId('pkg:npm/parent@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([[parent, target]]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parentPackage).toBe(parent);
    expect(groups[0].chains).toEqual([[parent, target]]);
  });

  it('sets parentPackage to the second-to-last entry for a longer chain', () => {
    const a = pkgId('pkg:npm/a@1.0.0');
    const parent = pkgId('pkg:npm/parent@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([[a, parent, target]]);

    expect(groups[0].parentPackage).toBe(parent);
  });

  it('merges chains that share the same direct parent into one group', () => {
    const shared = pkgId('pkg:npm/shared@1.0.0');
    const a = pkgId('pkg:npm/a@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([
      [shared, target],
      [a, shared, target],
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parentPackage?.purl).toBe(shared.purl);
    expect(groups[0].chains).toHaveLength(2);
  });

  it('sorts chains within a group shortest-first', () => {
    const shared = pkgId('pkg:npm/shared@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const a = pkgId('pkg:npm/a@1.0.0');
    const b = pkgId('pkg:npm/b@1.0.0');
    const groups = groupChainsByParent([
      [a, b, shared, target],
      [shared, target],
      [a, shared, target],
    ]);

    expect(groups[0].chains.map((c) => c.length)).toEqual([2, 3, 4]);
  });

  it('keeps chains with different direct parents in separate groups', () => {
    const p1 = pkgId('pkg:npm/p1@1.0.0');
    const p2 = pkgId('pkg:npm/p2@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([
      [p1, target],
      [p2, target],
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.parentPackage?.purl)).toEqual([p1.purl, p2.purl]);
  });

  it('sorts groups by their shortest chain length', () => {
    const p1 = pkgId('pkg:npm/p1@1.0.0');
    const p2 = pkgId('pkg:npm/p2@1.0.0');
    const a = pkgId('pkg:npm/a@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([
      [a, p2, target],
      [p1, target],
    ]);

    expect(groups[0].parentPackage?.purl).toBe(p1.purl);
    expect(groups[1].parentPackage?.purl).toBe(p2.purl);
  });

  it('places the direct-dependency group before transitive groups', () => {
    const parent = pkgId('pkg:npm/parent@1.0.0');
    const target = pkgId('pkg:npm/foo@1.0.0');
    const groups = groupChainsByParent([[parent, target], [target]]);

    expect(groups[0].parentPackage).toBeNull();
    expect(groups[1].parentPackage?.purl).toBe(parent.purl);
  });
});
