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

// `toBeOkWith()`/`toBeErrWith()` are registered as a bun test preload (bunfig.toml),
// so this file relies on the same global registration every other spec gets rather
// than importing '../../_common/result-matchers.ts' itself.

import { describe, expect, it } from 'bun:test';

import { err, ok } from '@/core/result.ts';

describe('toBeOkWith()', () => {
  it('passes when the Result is Ok with the expected value', () => {
    expect(ok('value')).toBeOkWith('value');
  });

  it('fails when the Result is Ok with a different value', () => {
    expect(ok('value')).not.toBeOkWith('other');
  });

  it('fails when the Result is Err', () => {
    expect(err(new Error('boom'))).not.toBeOkWith('value');
  });
});

describe('toBeErrWith()', () => {
  it('passes when the Result is Err and no expectation is given', () => {
    expect(err(new Error('boom'))).toBeErrWith();
  });

  it('passes when the Err message matches the expected string', () => {
    expect(err(new Error('boom'))).toBeErrWith('boom');
  });

  it('fails when the Err message does not match the expected string', () => {
    expect(err(new Error('boom'))).not.toBeErrWith('other');
  });

  it('passes when the Err satisfies the given predicate', () => {
    expect(err(new Error('boom'))).toBeErrWith((error) => error.message.includes('boo'));
  });

  it('fails when the Err does not satisfy the given predicate', () => {
    expect(err(new Error('boom'))).not.toBeErrWith((error) => error.message.includes('nope'));
  });

  it('fails when the Result is Ok', () => {
    expect(ok('value')).not.toBeErrWith();
  });
});
