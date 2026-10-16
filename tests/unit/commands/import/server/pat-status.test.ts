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

import { patStatusFromError } from '@/commands/import/server/pat-status.ts';
import {
  AccessDeniedError,
  BadRequestError,
  ServerError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';

describe('patStatusFromError', () => {
  it.each([
    ["personal access token for 'my-gitlab' is missing"],
    ["Personal Access Token for 'my-gitlab' Is Missing"],
    ['No personal access token found'],
  ])('reports a missing token for %p', (message) => {
    expect(patStatusFromError(new BadRequestError(message))).toBe('missing');
  });

  it.each([
    ['Invalid personal access token'],
    ['Your GitLab token was revoked'],
    ['Your GitLab token is expired'],
    ['Your GitLab token has insufficient scope'],
    ['Forbidden access to GitLab'],
    ['Error returned by Bitbucket Cloud: bad credentials [HTTP 401]'],
    ['Unable to contact Bitbucket Cloud servers [HTTP 403]'],
  ])('reports a rejected token for %p', (message) => {
    expect(patStatusFromError(new BadRequestError(message))).toBe('invalid');
  });

  it.each([
    ['Unable to contact Bitbucket server'],
    ['Invalid Azure URL'],
    ['Error 404. The requested Bitbucket server is unreachable.'],
    ['SonarQube API error: 400 Bad Request'],
  ])('says nothing about the token on a 400 that is not about it: %p', (message) => {
    expect(patStatusFromError(new BadRequestError(message))).toBeUndefined();
  });

  it.each([
    ['403', new AccessDeniedError(403)],
    ['404', new AccessDeniedError(404)],
    ['5xx', new ServerError(500, 'boom')],
    ['unclassified', new UnexpectedApiError(401, 'nope')],
  ])('says nothing about the token on a %s', (_label, error) => {
    expect(patStatusFromError(error)).toBeUndefined();
  });
});
