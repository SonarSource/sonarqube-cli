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

import { assertGithubComUrl, resolveDopSetting } from '@/commands/admin/onboard-ci/dop-setting.ts';
import { okAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectBindingsClient } from '@/core/server/project-bindings.ts';

const GITHUB = { id: 'github', key: 'github', type: 'github' as const };

function client() {
  return new ProjectBindingsClient(new SonarHttpClient('https://sonar.example.com', 'unused'));
}

describe('onboarding integration selection', () => {
  it('accepts a GitHub.com URL with mixed case and a trailing slash', () => {
    expect(() => assertGithubComUrl('https://API.GITHUB.COM/')).not.toThrow();
  });

  it('rejects GitHub settings without an API URL', async () => {
    const bindings = client();
    const response = spyOn(bindings, 'listDopSettings').mockReturnValue(okAsync([GITHUB]));
    try {
      const error = await resolveDopSetting(bindings, 'github').catch((error: unknown) => error);
      expect(error).toMatchObject({
        message: expect.stringContaining("GitHub configuration 'github' has no API URL"),
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
      const error = await resolveDopSetting(bindings, 'gitlab', 'gitlab').catch(
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
