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

import { OrganizationImportPermissionError } from '@/commands/import/resolve-options.ts';
import { OnboardingCancelledError } from '@/commands/init/answer.ts';
import { RepositoryInOtherOrganizationError } from '@/commands/init/steps/detect.ts';
import { OrganizationCreationDeclined } from '@/commands/init/steps/organization.ts';
import { classifyInitFailure } from '@/commands/init/telemetry/failure-reason.ts';
import { FolderSelectionCancelledError } from '@/commands/link/choose-folder.ts';
import { ProjectSelectionCancelledError } from '@/commands/link/choose-project.ts';
import { CancelledByUserError, CommandFailedError } from '@/core/commands/command-error.ts';
import { NetworkConfigError, ProjectOrganizationError } from '@/core/errors.ts';
import {
  AccessDeniedError,
  ForbiddenApiError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  TransportError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';

describe('classifyInitFailure()', () => {
  it.each([
    ['an onboarding cancel', new OnboardingCancelledError()],
    ['a project picker cancel', new ProjectSelectionCancelledError()],
    ['a folder picker cancel', new FolderSelectionCancelledError()],
    ['a login cancel', new CancelledByUserError('Login cancelled')],
  ])('classifies %s as cancelled', (_, error) => {
    expect(classifyInitFailure(error)).toBe('cancelled');
  });

  it.each([
    ['transport', new TransportError('offline')],
    ['network configuration', new NetworkConfigError('bad proxy')],
    ['rate limit', new RateLimitError()],
    ['unavailable service', new ServiceUnavailableError()],
    ['server', new ServerError(500, 'boom')],
  ])('classifies a %s error as network', (_, error) => {
    expect(classifyInitFailure(error)).toBe('network');
  });

  it.each([
    ['a denied read', new AccessDeniedError(403)],
    ['a forbidden write', new ForbiddenApiError('forbidden')],
  ])('classifies %s as permission', (_, error) => {
    expect(classifyInitFailure(error)).toBe('permission');
  });

  it('classifies a 401 as auth', () => {
    expect(classifyInitFailure(new UnexpectedApiError(401, 'Unauthorized'))).toBe('auth');
  });

  it('classifies another organization as other_org', () => {
    expect(classifyInitFailure(new RepositoryInOtherOrganizationError('other', 'switch'))).toBe(
      'other_org',
    );
    expect(classifyInitFailure(new ProjectOrganizationError('key', 'mine', 'theirs'))).toBe(
      'other_org',
    );
  });

  it('classifies a declined organization creation as no_org', () => {
    expect(classifyInitFailure(new OrganizationCreationDeclined())).toBe('no_org');
  });

  it('follows the cause chain of a wrapping error', () => {
    const wrapped = new CommandFailedError('Failed to look up organization', {
      cause: new TransportError('offline'),
    });

    expect(classifyInitFailure(wrapped)).toBe('network');
  });

  it('falls back to unknown, or to the given fallback, for anything else', () => {
    expect(classifyInitFailure(new CommandFailedError('Not signed in.'))).toBe('unknown');
    expect(classifyInitFailure('not an error')).toBe('unknown');
    expect(classifyInitFailure(new CommandFailedError('Not signed in.'), 'auth')).toBe('auth');
  });
  it('classifies denied Cloud import permissions as permission', () => {
    expect(classifyInitFailure(new OrganizationImportPermissionError('my-org'))).toBe('permission');
  });
});
