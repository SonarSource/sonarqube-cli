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

import { describe, expect, it, spyOn } from 'bun:test';

import {
  resolveGithubDopSetting,
  resolveGitlabDopSetting,
} from '@/commands/admin/onboard-ci/dop-setting.ts';
import { okAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectBindingsClient } from '@/core/server/project-bindings.ts';

const GITHUB = { id: 'github', key: 'github', type: 'github' as const };

function client() {
  return new ProjectBindingsClient(new SonarHttpClient('https://sonar.example.com', 'unused'));
}

describe('onboarding integration selection', () => {
  it('accepts a GitHub.com URL with mixed case and a trailing slash', async () => {
    const bindings = client();
    const setting = { ...GITHUB, url: 'https://API.GITHUB.COM/' };
    const response = spyOn(bindings, 'listDopSettings').mockReturnValue(okAsync([GITHUB, setting]));
    try {
      expect(await resolveGithubDopSetting(bindings)).toEqual(setting);
    } finally {
      response.mockRestore();
    }
  });

  it('rejects GitHub settings without an API URL', async () => {
    const bindings = client();
    const response = spyOn(bindings, 'listDopSettings').mockReturnValue(okAsync([GITHUB]));
    try {
      const error = await resolveGithubDopSetting(bindings).catch((error: unknown) => error);
      expect(error).toMatchObject({
        message: expect.stringContaining('No GitHub.com configuration found'),
      });
    } finally {
      response.mockRestore();
    }
  });

  it('reports a named GitLab setting without an API URL', async () => {
    const bindings = client();
    const response = spyOn(bindings, 'listDopSettings').mockReturnValue(
      okAsync([{ id: 'gitlab', key: 'gitlab', type: 'gitlab' }]),
    );
    try {
      const error = await resolveGitlabDopSetting(bindings, 'gitlab').catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        message: expect.stringContaining("GitLab configuration 'gitlab' has no API URL"),
      });
    } finally {
      response.mockRestore();
    }
  });
});
