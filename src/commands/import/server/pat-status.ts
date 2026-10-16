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

import { BadRequestError, type HttpClientError } from '@/core/server/errors.ts';

/**
 * Whether the caller's personal access token (PAT) for a DevOps platform setting is usable:
 * - `valid` — the platform accepted it.
 * - `missing` — the user never connected to this setting.
 * - `invalid` — a token is stored but the platform rejected it (e.g. revoked or expired).
 */
export type PatStatus = 'valid' | 'missing' | 'invalid';

/** Matches the server's "personal access token for '<key>' is missing" in any capitalisation. */
const MISSING_PAT_MESSAGE = /personal access token .*is missing|no personal access token found/i;

/**
 * Classifies a failed PAT check. Only a 400 answers the question; any other failure (network,
 * 403, 404, 5xx, ...) says nothing about the token, so it returns `undefined` and the caller
 * must surface the error instead of guessing.
 */
export function patStatusFromError(error: HttpClientError): PatStatus | undefined {
  if (!(error instanceof BadRequestError)) {
    return undefined;
  }
  return MISSING_PAT_MESSAGE.test(error.message) ? 'missing' : 'invalid';
}
