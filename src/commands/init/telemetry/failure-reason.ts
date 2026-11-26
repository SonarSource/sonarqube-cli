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

import { OrganizationImportPermissionError } from '@/commands/import/resolve-options.ts';
import { CancelledByUserError } from '@/core/commands/command-error.ts';
import { ProjectOrganizationError } from '@/core/errors.ts';
import {
  AccessDeniedError,
  ForbiddenApiError,
  isCriticalFailure,
  UnexpectedApiError,
} from '@/core/server/errors.ts';
import { HTTP_STATUS_UNAUTHORIZED } from '@/core/server/http-constants.ts';

import { RepositoryInOtherOrganizationError } from '../steps/detect.ts';
import { OrganizationCreationDeclined } from '../steps/organization.ts';
import type { InitFailureReason } from './init-telemetry.ts';

/** Classifies by error type along the `cause` chain, so no message text reaches telemetry. */
export function classifyInitFailure(
  error: unknown,
  fallback: InitFailureReason = 'unknown',
): InitFailureReason {
  for (let current = error; current instanceof Error; current = current.cause) {
    const reason = reasonOf(current);
    if (reason) {
      return reason;
    }
  }
  return fallback;
}

function reasonOf(error: Error): InitFailureReason | undefined {
  if (error instanceof CancelledByUserError) return 'cancelled';
  if (error instanceof OrganizationCreationDeclined) return 'no_org';
  if (error instanceof OrganizationImportPermissionError) return 'permission';
  if (
    error instanceof RepositoryInOtherOrganizationError ||
    error instanceof ProjectOrganizationError
  ) {
    return 'other_org';
  }
  if (error instanceof UnexpectedApiError && error.status === HTTP_STATUS_UNAUTHORIZED) {
    return 'auth';
  }
  if (error instanceof AccessDeniedError || error instanceof ForbiddenApiError) {
    return 'permission';
  }
  if (isCriticalFailure(error)) return 'network';
  return undefined;
}
