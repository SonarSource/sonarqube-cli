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

import type { IntegrationContext } from '@/core/framework/features/types.ts';

import { getOptionalStringAttr } from '../../../../../src/commands/integrate/_common/attrs.ts';

function makeContext(attrs?: IntegrationContext['attrs']): IntegrationContext {
  return { attrs } as IntegrationContext;
}

describe('integrate attrs helpers', () => {
  it('getOptionalStringAttr returns the value only for non-empty string attributes', () => {
    expect(getOptionalStringAttr(makeContext({ projectKey: 'my-project' }), 'projectKey')).toBe(
      'my-project',
    );
    expect(getOptionalStringAttr(makeContext({}), 'projectKey')).toBeUndefined();
    expect(getOptionalStringAttr(makeContext(), 'projectKey')).toBeUndefined();
    expect(getOptionalStringAttr(makeContext({ projectKey: '' }), 'projectKey')).toBeUndefined();
    expect(getOptionalStringAttr(makeContext({ projectKey: 42 }), 'projectKey')).toBeUndefined();
    expect(getOptionalStringAttr(makeContext({ projectKey: true }), 'projectKey')).toBeUndefined();
    expect(getOptionalStringAttr(makeContext({ projectKey: null }), 'projectKey')).toBeUndefined();
  });
});
