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

import { NetworkConfigError } from '@/core/errors.ts';
import {
  BadRequestError,
  ForbiddenApiError,
  isCriticalFailure,
  RateLimitError,
  RequestPayloadTooLargeError,
  ServerError,
  ServiceUnavailableError,
  TransportError,
} from '@/core/server/errors.ts';

describe('isCriticalFailure', () => {
  it('is critical for a transport failure', () => {
    expect(isCriticalFailure(new TransportError('ECONNREFUSED'))).toBe(true);
  });

  it('is critical for a network configuration failure', () => {
    expect(isCriticalFailure(new NetworkConfigError('invalid proxy URL'))).toBe(true);
  });

  it('is critical for a rate-limit response', () => {
    expect(isCriticalFailure(new RateLimitError())).toBe(true);
  });

  it('is critical for a service-unavailable response', () => {
    expect(isCriticalFailure(new ServiceUnavailableError())).toBe(true);
  });

  it('is critical for a 5xx server error other than 503', () => {
    expect(isCriticalFailure(new ServerError(500, 'SonarQube API error: 500'))).toBe(true);
    expect(isCriticalFailure(new ServerError(502, 'SonarQube API error: 502'))).toBe(true);
    expect(isCriticalFailure(new ServerError(504, 'SonarQube API error: 504'))).toBe(true);
  });

  it('is expected for a bad-request response', () => {
    expect(isCriticalFailure(new BadRequestError('invalid'))).toBe(false);
  });

  it('is expected for a forbidden response', () => {
    expect(isCriticalFailure(new ForbiddenApiError('nope'))).toBe(false);
  });

  it('is expected for a payload-too-large response', () => {
    expect(isCriticalFailure(new RequestPayloadTooLargeError('too big'))).toBe(false);
  });

  it('is expected for a plain error built from a response status', () => {
    expect(isCriticalFailure(new Error('SonarQube API error: 404 Not Found'))).toBe(false);
  });
});

describe('TransportError', () => {
  it('keeps the original error as its cause', () => {
    const original = new Error('ECONNREFUSED');
    const wrapped = new TransportError(original.message, { cause: original });
    expect(wrapped.message).toBe('ECONNREFUSED');
    expect(wrapped.cause).toBe(original);
  });
});
