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
import { InvalidArgumentError } from 'commander';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { parseInteger, resolvePageOptions, resolvePageSizeOption } from '@/core/commands/params.ts';
import { err, ok } from '@/core/result.ts';

describe('CLI option parsing', () => {
  it('should throw if not a valid number', () => {
    expect(() => parseInteger('x')).toThrow(new InvalidArgumentError('Not a number.'));
  });

  it('should successfully parse a valid number', () => {
    expect(parseInteger('42')).toBe(42);
  });
});

describe('resolvePageSizeOption', () => {
  it('should return Ok with the page size when within bounds', () => {
    expect(resolvePageSizeOption(50, 500)).toEqual(ok(50));
  });

  it('should return Err when below 1', () => {
    expect(resolvePageSizeOption(0, 500)).toEqual(
      err(
        new InvalidOptionError(
          "Invalid --page-size option: '0'. Must be an integer between 1 and 500",
        ),
      ),
    );
  });

  it('should return Err when above maxPageSize', () => {
    expect(resolvePageSizeOption(501, 500)).toEqual(
      err(
        new InvalidOptionError(
          "Invalid --page-size option: '501'. Must be an integer between 1 and 500",
        ),
      ),
    );
  });
});

describe('resolvePageOptions', () => {
  it('should return Ok with both values when within bounds', () => {
    expect(resolvePageOptions(50, 2, 500)).toEqual(ok({ pageSize: 50, page: 2 }));
  });

  it('should return Err on an invalid page size before checking page', () => {
    expect(resolvePageOptions(0, 0, 500)).toEqual(
      err(
        new InvalidOptionError(
          "Invalid --page-size option: '0'. Must be an integer between 1 and 500",
        ),
      ),
    );
  });

  it('should return Err when page is below 1', () => {
    expect(resolvePageOptions(50, 0, 500)).toEqual(
      err(new InvalidOptionError("Invalid --page option: '0'. Must be an integer >= 1")),
    );
  });
});
