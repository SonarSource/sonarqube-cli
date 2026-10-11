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

import { hasCustomizableChoices } from '@/core/framework/features/selection.ts';
import type { FeatureApplication, SubfeatureApplication } from '@/core/framework/features/types.ts';

function subfeature(
  id: string,
  { available = true, required = false }: { available?: boolean; required?: boolean } = {},
): SubfeatureApplication {
  return {
    subfeature: { id, displayName: id, required },
    installed: false,
    available,
    active: false,
  };
}

function feature(
  id: string,
  {
    required = false,
    subfeatures = [],
  }: { required?: boolean; subfeatures?: SubfeatureApplication[] } = {},
): FeatureApplication {
  return {
    feature: { id, displayName: id, required },
    targetRoot: '/tmp',
    scope: 'global',
    installed: false,
    available: true,
    subfeatureApplications: subfeatures,
  };
}

describe('hasCustomizableChoices', () => {
  it.each<[string, FeatureApplication[], boolean]>([
    ['no features', [], false],
    [
      'only required items',
      [
        feature('a', { required: true, subfeatures: [subfeature('a1', { required: true })] }),
        feature('b', { required: true }),
      ],
      false,
    ],
    [
      'a required container with one optional subfeature',
      [feature('a', { required: true, subfeatures: [subfeature('a1')] })],
      false,
    ],
    [
      'a required container with two optional subfeatures',
      [feature('a', { required: true, subfeatures: [subfeature('a1'), subfeature('a2')] })],
      true,
    ],
    ['one optional feature without subfeatures', [feature('a')], false],
    [
      'one feature with two available subfeatures',
      [feature('a', { subfeatures: [subfeature('a1'), subfeature('a2')] })],
      true,
    ],
    [
      'one feature with one available and one unavailable subfeature',
      [feature('a', { subfeatures: [subfeature('a1'), subfeature('a2', { available: false })] })],
      false,
    ],
    [
      'one feature with one available and one unknown subfeature',
      [
        feature('a', {
          subfeatures: [subfeature('a1'), { ...subfeature('a2'), available: undefined }],
        }),
      ],
      false,
    ],
    ['two features', [feature('a'), feature('b')], true],
  ])('%s → %p', (_, features, expected) => {
    expect(hasCustomizableChoices(features)).toBe(expected);
  });
});
