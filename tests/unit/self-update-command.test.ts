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

// Tests for src/commands/self-update.ts

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { selfUpdateCheckCommand, selfUpdateCommand } from '../../src/commands/self-update.js';
import * as selfUpdate from '../../src/lib/self-update.js';
import { version as VERSION } from '../../package.json';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/index.js';

describe('selfUpdateCheckCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchLatestSpy: any;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    fetchLatestSpy?.mockRestore();
    setMockUi(false);
  });

  it('shows success when already on the latest version', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue(VERSION);

    await selfUpdateCheckCommand();

    const calls = getMockUiCalls();
    const successes = calls.filter(c => c.method === 'success').map(c => String(c.args[0]));
    expect(successes.some(m => m.includes('Already on the latest version'))).toBe(true);
  });

  it('shows a warning when an update is available', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue('99.99.99');

    await selfUpdateCheckCommand();

    const calls = getMockUiCalls();
    const warns = calls.filter(c => c.method === 'warn').map(c => String(c.args[0]));
    expect(warns.some(m => m.includes('Update available') && m.includes('99.99.99'))).toBe(true);
  });

  it('shows a hint to run sonar self-update when an update is available', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue('99.99.99');

    await selfUpdateCheckCommand();

    const calls = getMockUiCalls();
    const texts = calls.filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('sonar self-update'))).toBe(true);
  });

  it('propagates error when version fetch fails', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockRejectedValue(new Error('network timeout'));

    expect(selfUpdateCheckCommand()).rejects.toThrow('network timeout');
  });
});

describe('selfUpdateCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchLatestSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let performUpdateSpy: any;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    fetchLatestSpy?.mockRestore();
    performUpdateSpy?.mockRestore();
    setMockUi(false);
  });

  it('delegates to updateCheckCommand when --check is passed', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue(VERSION);

    await selfUpdateCommand({ check: true });

    const calls = getMockUiCalls();
    const successes = calls.filter(c => c.method === 'success').map(c => String(c.args[0]));
    expect(successes.some(m => m.includes('Already on the latest version'))).toBe(true);
  });

  it('shows success when already on the latest version', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue(VERSION);

    await selfUpdateCommand({});

    const calls = getMockUiCalls();
    const successes = calls.filter(c => c.method === 'success').map(c => String(c.args[0]));
    expect(successes.some(m => m.includes('Already on the latest version'))).toBe(true);
  });

  it('does not call performSelfUpdate when already on the latest version', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue(VERSION);
    performUpdateSpy = spyOn(selfUpdate, 'performSelfUpdate').mockResolvedValue(VERSION);

    await selfUpdateCommand({});

    expect(performUpdateSpy).not.toHaveBeenCalled();
  });

  it('calls performSelfUpdate and shows success when update is available', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue('99.99.99');
    performUpdateSpy = spyOn(selfUpdate, 'performSelfUpdate').mockResolvedValue('99.99.99');

    await selfUpdateCommand({});

    expect(performUpdateSpy).toHaveBeenCalledWith('99.99.99');
    const calls = getMockUiCalls();
    const successes = calls.filter(c => c.method === 'success').map(c => String(c.args[0]));
    expect(successes.some(m => m.includes('Updated to v99.99.99'))).toBe(true);
  });

  it('with --force, calls performSelfUpdate even when already on the latest version', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue(VERSION);
    performUpdateSpy = spyOn(selfUpdate, 'performSelfUpdate').mockResolvedValue(VERSION);

    await selfUpdateCommand({ force: true });

    expect(performUpdateSpy).toHaveBeenCalledWith(VERSION);
    const calls = getMockUiCalls();
    const infos = calls.filter(c => c.method === 'info').map(c => String(c.args[0]));
    expect(infos.some(m => m.includes('Forcing reinstall'))).toBe(true);
  });

  it('propagates error from performSelfUpdate', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockResolvedValue('99.99.99');
    performUpdateSpy = spyOn(selfUpdate, 'performSelfUpdate').mockRejectedValue(new Error('download failed'));

    expect(selfUpdateCommand({})).rejects.toThrow('download failed');
  });

  it('propagates error when version fetch fails', async () => {
    fetchLatestSpy = spyOn(selfUpdate, 'fetchLatestCliVersion').mockRejectedValue(new Error('network timeout'));

    expect(selfUpdateCommand({})).rejects.toThrow('network timeout');
  });
});
