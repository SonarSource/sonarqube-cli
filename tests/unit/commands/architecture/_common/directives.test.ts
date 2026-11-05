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

import type { DirectiveInput } from '@/commands/architecture/_common/directives.ts';
import { directiveKey, parseDirectiveChanges } from '@/commands/architecture/_common/directives.ts';

const directive: DirectiveInput = {
  type: 'REMOVE_EDGE',
  ecosystem: 'java',
  graphType: 'namespace_graph',
  fromNodeKey: 'app:a',
  toNodeKey: 'app:b',
};

describe('directive identity', () => {
  it.each([
    undefined,
    '',
    ' ',
    'default_perspective',
    ' default_perspective ',
    'transformed_code_perspective',
    'transformed_model_perspective',
  ])('normalizes the default alias %s only for comparison', (graphPerspective) => {
    const input = { ...directive, graphPerspective };
    const original = { ...input };
    expect(directiveKey(input)).toBe(directiveKey(directive));
    expect(input).toEqual(original);
  });

  it.each([
    'custom_view',
    ' custom_view ',
    'intended_perspective_mapped_detail_filtered',
    'Transformed_custom',
  ])('keeps %s distinct from the default', (graphPerspective) => {
    expect(directiveKey({ ...directive, graphPerspective })).not.toBe(directiveKey(directive));
  });

  it.each(['', ' ', ' default_perspective ', 'transformed_code_perspective', ' custom_view '])(
    'preserves the supplied creation value %s',
    (graphPerspective) => {
      const changes = parseDirectiveChanges(
        { create: [{ ...directive, graphPerspective }] },
        'shop',
      );
      expect(changes.create[0].graphPerspective).toBe(graphPerspective);
    },
  );
});
