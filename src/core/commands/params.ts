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
import { InvalidArgumentError } from 'commander';

import { err, ok, type Result } from '@/core/result.ts';

import { InvalidOptionError } from './command-error.ts';

export function parseInteger(value: string): number {
  const parsedValue = Number.parseInt(value, 10);
  if (Number.isNaN(parsedValue)) {
    throw new InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}

/**
 * Resolve and validate a `--format <format>` option value against its declared
 * choices, case-insensitively, falling back to `defaultFormat` when omitted.
 * Commander's own `.choices()` already rejects an invalid CLI value before the
 * handler runs; this exists for programmatic/test callers that construct options
 * directly, and to return a value narrowed to the command's own format type.
 */
export function resolveFormatOption<Format extends string>(
  rawFormat: string | undefined,
  validFormats: readonly Format[],
  defaultFormat: Format,
): Format {
  const raw = rawFormat ?? defaultFormat;
  const format = raw.toLowerCase() as Format;
  if (!validFormats.includes(format)) {
    throw new InvalidOptionError(
      `Invalid format: '${raw}'. Must be one of: ${validFormats.join(', ')}`,
    );
  }
  return format;
}

export function resolvePageSizeOption(
  pageSize: number,
  maxPageSize: number,
): Result<number, InvalidOptionError> {
  if (pageSize < 1 || pageSize > maxPageSize) {
    return err(
      new InvalidOptionError(
        `Invalid --page-size option: '${pageSize}'. Must be an integer between 1 and ${maxPageSize}`,
      ),
    );
  }
  return ok(pageSize);
}

export function resolvePageOptions(
  pageSize: number,
  page: number,
  maxPageSize: number,
): Result<{ pageSize: number; page: number }, InvalidOptionError> {
  return resolvePageSizeOption(pageSize, maxPageSize).andThen((resolvedPageSize) => {
    if (page < 1) {
      return err(
        new InvalidOptionError(`Invalid --page option: '${page}'. Must be an integer >= 1`),
      );
    }
    return ok({ pageSize: resolvedPageSize, page });
  });
}
