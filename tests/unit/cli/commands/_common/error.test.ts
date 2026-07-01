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

import {
  CommandFailedError,
  remediationHintFor,
} from '../../../../../src/cli/commands/_common/error';
import { NetworkConfigError } from '../../../../../src/lib/errors';
import { RateLimitError, ServiceUnavailableError } from '../../../../../src/sonarqube/errors';

describe('remediationHintFor', () => {
  it('returns the remediationHint from a CliError when one is set', () => {
    const err = new CommandFailedError('failed', { remediationHint: 'Try this.' });
    expect(remediationHintFor(err)).toBe('Try this.');
  });

  it('returns undefined for a CliError with no remediationHint', () => {
    const err = new CommandFailedError('failed');
    expect(remediationHintFor(err)).toBeUndefined();
  });

  it('returns the system status hint for NetworkConfigError', () => {
    const err = new NetworkConfigError('bad cert');
    expect(remediationHintFor(err)).toContain('sonar system status');
  });

  it('returns the retry hint for RateLimitError', () => {
    const err = new RateLimitError();
    expect(remediationHintFor(err)).toBe('Wait a moment and try again.');
  });

  it('returns the network hint for ServiceUnavailableError', () => {
    const err = new ServiceUnavailableError();
    expect(remediationHintFor(err)).toBe('Check your network connection and try again later.');
  });

  it('returns undefined for a plain Error', () => {
    expect(remediationHintFor(new Error('oops'))).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(remediationHintFor(null)).toBeUndefined();
  });

  it('returns undefined for a string', () => {
    expect(remediationHintFor('something went wrong')).toBeUndefined();
  });
});
