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

// Map SQAA API errors to CLI errors with remediation hints.

import { CommandFailedError, type CommandFailedErrorOptions } from '@/core/command-error.ts';
import { BadRequestError, RequestPayloadTooLargeError } from '@/core/server/errors.ts';

const GENERIC_SQAA_FAILURE_HINT =
  'Check your SonarQube Cloud authentication, project key, and network connectivity, then retry.';

/** Shown on command-level failures; stripped from per-file ✗ rows in sqaa-display. */
export const SQAA_FAILURE_HEADING = 'Vortex analysis failed.';

export function sqaaFailureMessage(detail: string): string {
  return `${SQAA_FAILURE_HEADING} ${detail}`;
}

export function sqaaCommandFailedError(
  detail: string,
  options?: CommandFailedErrorOptions,
): CommandFailedError {
  return new CommandFailedError(sqaaFailureMessage(detail), options);
}

function formatBytesLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} bytes`;
}

export function payloadTooLargeRemediationHint(err?: RequestPayloadTooLargeError): string {
  const maxBytes = err?.meta?.maxRequestSize;
  const maxFiles = err?.meta?.maxFiles;

  if (err?.code === 'TOO_MANY_FILES') {
    if (maxFiles != null) {
      return `Send fewer files per request (server limit: ${maxFiles} files). Split the change set into smaller batches.`;
    }
    return 'Send fewer files per request. Split the change set into smaller batches.';
  }

  if (err?.code === 'REQUEST_TOO_LARGE') {
    if (maxBytes != null) {
      return `Reduce file sizes or send fewer files per request (server limit: ${formatBytesLimit(maxBytes)}).`;
    }
    return 'Reduce file sizes or send fewer files per request.';
  }

  if (maxBytes != null || maxFiles != null) {
    const parts: string[] = [];
    if (maxBytes != null) {
      parts.push(`max request size ${formatBytesLimit(maxBytes)}`);
    }
    if (maxFiles != null) {
      parts.push(`max ${maxFiles} files per request`);
    }
    return `The request exceeds server limits (${parts.join(', ')}). Send fewer or smaller files.`;
  }

  return 'The analysis request exceeds server size limits. Try analyzing fewer or smaller files.';
}

export function payloadTooLargeCommandError(err?: RequestPayloadTooLargeError): CommandFailedError {
  const message = err?.message ?? 'Request payload too large.';
  return sqaaCommandFailedError(message, {
    cause: err,
    remediationHint: payloadTooLargeRemediationHint(err),
  });
}

export function isPayloadTooLargeCommandError(error: Error): boolean {
  return error instanceof CommandFailedError && error.cause instanceof RequestPayloadTooLargeError;
}

function badRequestRemediationHint(err: BadRequestError): string | undefined {
  switch (err.code) {
    case undefined:
      return undefined;
    case 'INVALID_FILE_PATH':
      return "Use project-relative POSIX paths (e.g. 'src/index.ts') without '..' or absolute prefixes.";
    case 'INVALID_ANALYSIS_DEPTH':
      return "Use analysisDepth 'STANDARD' or 'DEEP'.";
    case 'INVALID_SCOPE':
      return "Use scope 'MAIN' or 'TEST' when set, or omit scope.";
    case 'DUPLICATE_FILE_PATH':
      return 'Remove duplicate paths from files[] before retrying.';
    default:
      return undefined;
  }
}

export function badRequestCommandError(err: BadRequestError): CommandFailedError {
  return sqaaCommandFailedError(err.message, {
    cause: err,
    remediationHint: badRequestRemediationHint(err),
  });
}

/** Convert an API-layer error into a user-facing {@link CommandFailedError}. */
export function toSqaaCommandError(err: unknown): CommandFailedError {
  if (err instanceof CommandFailedError) {
    return err;
  }
  if (err instanceof BadRequestError) {
    return badRequestCommandError(err);
  }
  if (err instanceof RequestPayloadTooLargeError) {
    return payloadTooLargeCommandError(err);
  }
  return sqaaCommandFailedError((err as Error).message, {
    cause: err,
    remediationHint: GENERIC_SQAA_FAILURE_HINT,
  });
}
