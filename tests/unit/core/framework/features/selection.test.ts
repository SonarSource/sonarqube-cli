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
      [feature('a', { required: true, subfeatures: [subfeature('a1', { required: true })] })],
      false,
    ],
    [
      'an available optional subfeature',
      [feature('a', { required: true, subfeatures: [subfeature('a1')] })],
      true,
    ],
    ['an optional feature', [feature('a')], true],
    [
      'an unavailable optional subfeature',
      [feature('a', { required: true, subfeatures: [subfeature('a1', { available: false })] })],
      false,
    ],
    [
      'an optional subfeature with unknown availability',
      [
        feature('a', {
          required: true,
          subfeatures: [{ ...subfeature('a1'), available: undefined }],
        }),
      ],
      false,
    ],
  ])('%s → %p', (_, features, expected) => {
    expect(hasCustomizableChoices(features)).toBe(expected);
  });
});
