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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { resolveServer } from '@/commands/auth/select-server.ts';
import { SONARCLOUD_AU_URL, SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import * as projectInfo from '@/core/project-discovery/project-info.ts';
import type { SelectOption } from '@/core/ui/console.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('resolveServer cloud region prompt', () => {
  afterEach(() => {
    spyOn(projectInfo, 'discoverServerFromConfig').mockRestore();
  });

  function pickRegion(pickIndex: number): {
    result: Promise<{ server: string }>;
    regionOptions: () => SelectOption<string>[];
  } {
    spyOn(projectInfo, 'discoverServerFromConfig').mockResolvedValue(null);
    const fake = new FakeConsole();
    let regionOptions: SelectOption<string>[] = [];
    spyOn(fake, 'selectPrompt').mockImplementation(((
      message: string,
      options: SelectOption<string>[],
    ) => {
      if (message.includes('region')) {
        regionOptions = options;
        return Promise.resolve(options[pickIndex].value);
      }
      return Promise.resolve('cloud');
    }) as never);
    return { result: resolveServer(undefined, fake), regionOptions: () => regionOptions };
  }

  it('offers EU, US and AU', async () => {
    const { result, regionOptions } = pickRegion(0);
    await result;
    expect(regionOptions()).toEqual([
      { value: SONARCLOUD_URL, label: 'EU (sonarcloud.io)' },
      { value: SONARCLOUD_US_URL, label: 'US (sonarqube.us)' },
      { value: SONARCLOUD_AU_URL, label: 'AU (sonarqube.au)' },
    ]);
  });

  it('returns the AU server URL when AU is selected', async () => {
    const { result } = pickRegion(2);
    expect(await result).toEqual({ server: SONARCLOUD_AU_URL });
  });
});
