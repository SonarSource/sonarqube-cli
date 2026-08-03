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
import { BadRequestError, RequestPayloadTooLargeError } from '@/core/server/errors.ts';

import {
  badRequestCommandError,
  isPayloadTooLargeCommandError,
  payloadTooLargeCommandError,
  payloadTooLargeRemediationHint,
  sqaaFailureMessage,
  toSqaaCommandError,
} from '../../../../src/commands/analyze/sqaa-errors.ts';

describe('sqaaFailureMessage', () => {
  it('keeps heading and detail on one line for command-level errors', () => {
    expect(sqaaFailureMessage('File path must use forward slashes.')).toBe(
      'Vortex analysis failed. File path must use forward slashes.',
    );
  });
});

describe('payloadTooLargeRemediationHint', () => {
  it('includes max file count for TOO_MANY_FILES', () => {
    const hint = payloadTooLargeRemediationHint(
      new RequestPayloadTooLargeError('Too many files', 'TOO_MANY_FILES', { maxFiles: 50 }),
    );
    expect(hint).toContain('50 files');
  });

  it('includes max request size for REQUEST_TOO_LARGE', () => {
    const hint = payloadTooLargeRemediationHint(
      new RequestPayloadTooLargeError('Too large', 'REQUEST_TOO_LARGE', {
        maxRequestSize: 5 * 1024 * 1024,
      }),
    );
    expect(hint).toContain('5 MB');
  });
});

describe('payloadTooLargeCommandError', () => {
  it('wraps structured 413 errors with remediation hint', () => {
    const err = payloadTooLargeCommandError(
      new RequestPayloadTooLargeError('Request payload too large', 'REQUEST_TOO_LARGE', {
        maxRequestSize: 1024,
      }),
    );
    expect(err).toBeInstanceOf(CommandFailedError);
    expect(err.message).toContain('Request payload too large');
    expect(err.remediationHint).toContain('1 KB');
  });
});

describe('badRequestCommandError', () => {
  it('adds remediation hint for recognized codes', () => {
    const err = badRequestCommandError(
      new BadRequestError('Invalid file path', 'INVALID_FILE_PATH'),
    );
    expect(err.remediationHint).toContain('project-relative');
  });
});

describe('isPayloadTooLargeCommandError', () => {
  it('returns true for payloadTooLargeCommandError wrappers', () => {
    const err = payloadTooLargeCommandError(
      new RequestPayloadTooLargeError('Request payload too large', 'REQUEST_TOO_LARGE'),
    );
    expect(isPayloadTooLargeCommandError(err)).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isPayloadTooLargeCommandError(new Error('network down'))).toBe(false);
  });
});

describe('toSqaaCommandError', () => {
  it('passes through CommandFailedError', () => {
    const original = new CommandFailedError('already wrapped');
    expect(toSqaaCommandError(original)).toBe(original);
  });

  it('maps BadRequestError to CommandFailedError', () => {
    const err = toSqaaCommandError(new BadRequestError('Bad input', 'INVALID_SCOPE'));
    expect(err).toBeInstanceOf(CommandFailedError);
    expect(err.message).toContain('Bad input');
  });
});
