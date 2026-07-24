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

import { CommandFailedError } from '@/core/command-error.ts';
import { SUPPORT_URL } from '@/core/config-constants.ts';

import {
  getOptionalStringAttr,
  getRequiredStringAttr,
} from '../../../../../src/commands/integrate/_common/attrs.ts';
import type { IntegrationContext } from '../../../../../src/commands/integrate/_common/registry/types.ts';

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

  it('getRequiredStringAttr returns the value for a non-empty string attribute', () => {
    expect(
      getRequiredStringAttr(makeContext({ projectKey: 'my-project' }), 'projectKey', 'Codex'),
    ).toBe('my-project');
  });

  it('getRequiredStringAttr throws a CommandFailedError naming the integration for missing or invalid attributes', () => {
    const invalidAttrs: IntegrationContext['attrs'][] = [{}, { projectKey: '' }, { projectKey: 7 }];
    for (const attrs of invalidAttrs) {
      expect(() => getRequiredStringAttr(makeContext(attrs), 'projectKey', 'Codex')).toThrow(
        CommandFailedError,
      );
    }

    try {
      getRequiredStringAttr(makeContext({}), 'projectKey', 'Codex');
      throw new Error('expected getRequiredStringAttr to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandFailedError);
      const cliError = error as CommandFailedError;
      expect(cliError.message).toBe(
        "Could not complete the Codex integration: missing required data 'projectKey'.",
      );
      expect(cliError.remediationHint).toContain(SUPPORT_URL);
      expect(cliError.exitCode).toBe(1);
    }
  });
});
