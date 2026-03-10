/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Unit tests for org selection logic in auth.ts

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { authLogin } from '../../src/cli/commands/auth/login';
import { getToken } from '../../src/cli/commands/_common/token';
import * as token from '../../src/cli/commands/_common/token';
import { SonarQubeClient } from '../../src/sonarqube/client';
import * as discovery from '../../src/cli/commands/_common/discovery';
import * as stateManager from '../../src/lib/state-manager';
import { getDefaultState } from '../../src/lib/state';
import { setMockUi, clearMockUiCalls, queueMockResponse } from '../../src/ui/mock';
import { createMockKeytar } from './helpers/mock-keytar';

const keytarHandle = createMockKeytar();

const EMPTY_PROJECT_INFO = {
  root: '',
  name: '',
  isGitRepo: false,
  gitRemote: '',
  hasSonarProps: false,
  sonarPropsData: null,
  hasSonarLintConfig: false,
  sonarLintData: null,
};

// ─── org selection via authLogin ──────────────────────────────────────────────

describe('authLogin: org selection', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let discoverSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(EMPTY_PROJECT_INFO);
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    discoverSpy.mockRestore();
    setMockUi(false);
  });

  it('saves token for the org selected by the user when multiple orgs are available', async () => {
    // Before: no token
    expect(await getToken('https://sonarcloud.io', 'org-two')).toBeNull();

    const generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(
      'mock-token',
    );
    const listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue(
      {
        organizations: [
          { key: 'org-one', name: 'Org One' },
          { key: 'org-two', name: 'Org Two' },
        ],
        total: 2,
      },
    );

    // Simulate user picking 'org-two' from the select prompt
    queueMockResponse('org-two');

    try {
      await authLogin({ server: 'https://sonarcloud.io' });
      expect(await getToken('https://sonarcloud.io', 'org-two')).toBe('mock-token');
    } finally {
      generateTokenSpy.mockRestore();
      listOrgsSpy.mockRestore();
    }
  });

  it('saves token for the org selected by the user when user is a member of exactly one organization', async () => {
    // Before: no token
    expect(await getToken('https://sonarcloud.io', 'org-one')).toBeNull();

    const generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(
      'mock-token',
    );
    const listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue(
      { organizations: [{ key: 'org-one', name: 'Single One' }], total: 1 },
    );

    try {
      await authLogin({ server: 'https://sonarcloud.io' });
      expect(await getToken('https://sonarcloud.io', 'org-one')).toBe('mock-token');
    } finally {
      generateTokenSpy.mockRestore();
      listOrgsSpy.mockRestore();
    }
  });

  it('prompts for manual org key when user is not a member of any organization', async () => {
    // Before: no token
    expect(await getToken('https://sonarcloud.io', 'custom-org-one')).toBeNull();

    const generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(
      'mock-token',
    );
    const listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue(
      { organizations: [], total: 0 },
    );

    // Simulate user entering 'custom-org-one' manually
    queueMockResponse('custom-org-one');

    try {
      await authLogin({ server: 'https://sonarcloud.io' });
      expect(await getToken('https://sonarcloud.io', 'custom-org-one')).toBe('mock-token');
    } finally {
      generateTokenSpy.mockRestore();
      listOrgsSpy.mockRestore();
    }
  });

  it('exits with error when user cancels the organization prompt', async () => {
    const generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(
      'mock-token',
    );
    const listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue(
      { organizations: [], total: 0 },
    );

    // Simulate user canceling the prompt
    queueMockResponse(null);

    try {
      await authLogin({ server: 'https://sonarcloud.io' });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Organization selection cancelled');
    } finally {
      generateTokenSpy.mockRestore();
      listOrgsSpy.mockRestore();
    }
  });

  it('saves connection for the org selected by the user when user is a member of more than 10 organizations', async () => {
    const generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(
      'mock-token',
    );
    const listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue(
      {
        organizations: Array.from({ length: 10 }, (_, i) => ({
          key: `org-${i}`,
          name: `Org ${i}`,
        })),
        total: 200,
      },
    );

    queueMockResponse('org-99');

    try {
      await authLogin({ server: 'https://sonarcloud.io' });
      expect(await getToken('https://sonarcloud.io', 'org-99')).toBe('mock-token');
    } finally {
      generateTokenSpy.mockRestore();
      listOrgsSpy.mockRestore();
    }
  });
});
