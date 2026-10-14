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

import { mergeStateValue } from '@/core/state/state-merge.ts';

describe('mergeStateValue', () => {
  it('preserves independent feature and project mapping additions', () => {
    const feature = { featureId: 'hook', targetRoot: '/first' };
    const otherFeature = { featureId: 'hook', targetRoot: '/second' };
    expect(mergeStateValue([], [feature], [otherFeature])).toEqual([otherFeature, feature]);

    const mapping = { targetRoot: '/first', projectKey: 'first' };
    const otherMapping = { targetRoot: '/first', projectKey: 'second' };
    expect(mergeStateValue([], [mapping], [otherMapping])).toEqual([otherMapping, mapping]);
  });

  it('combines independent fields in one registry entry', () => {
    const base = [{ id: 'dependency', version: '1', path: '/old' }];
    const changed = [{ id: 'dependency', version: '2', path: '/old' }];
    const current = [{ id: 'dependency', version: '1', path: '/new' }];
    expect(mergeStateValue(base, changed, current)).toEqual([
      { id: 'dependency', version: '2', path: '/new' },
    ]);
  });

  it('rejects conflicting registry updates without changing the latest value', () => {
    const base = [{ id: 'dependency', version: '1' }];
    const changed = [{ id: 'dependency', version: '2' }];
    const current = [{ id: 'dependency', version: '3' }];
    expect(() => mergeStateValue(base, changed, current)).toThrow('Concurrent state change');
    expect(current[0].version).toBe('3');
  });

  it('rejects deletion when another writer changed the entry', () => {
    expect(() =>
      mergeStateValue(
        [{ id: 'dependency', version: '1' }],
        [],
        [{ id: 'dependency', version: '2' }],
      ),
    ).toThrow('Concurrent state change');
  });

  it('rejects two different additions under the same key', () => {
    expect(() =>
      mergeStateValue(
        [],
        [{ id: 'dependency', version: '1' }],
        [{ id: 'dependency', version: '2' }],
      ),
    ).toThrow('Concurrent state change');
  });

  it('rejects conflicting additions in arrays without stable entry keys', () => {
    expect(() => mergeStateValue([], ['first'], ['second'])).toThrow('Concurrent state change');
  });

  it('combines independent fields in a newly created record', () => {
    expect(mergeStateValue(undefined, { first: true }, { second: true })).toEqual({
      first: true,
      second: true,
    });
  });

  it('ignores a caller timestamp that saveState replaces after merging', () => {
    expect(mergeStateValue('2026-01-01', '2026-02-01', '2026-03-01', 'state.lastUpdated')).toBe(
      '2026-03-01',
    );
  });
});
