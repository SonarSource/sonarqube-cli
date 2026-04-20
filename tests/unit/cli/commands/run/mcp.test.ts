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

// Unit tests for `sonar run mcp`

import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '../../../../../src/cli/commands/_common/error.js';
import { runMcp } from '../../../../../src/cli/commands/run/mcp.js';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.js';
import * as projectInfo from '../../../../../src/lib/project-workspace/project-info.js';
import * as toolDetector from '../../../../../src/lib/tool-detector.js';

const FAKE_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'http://localhost:9000',
  connectionType: 'on-premise',
};

function makeFakeChild(exitCode = 0): childProcess.ChildProcess {
  const emitter = new EventEmitter();
  setImmediate(() => emitter.emit('exit', exitCode));
  return emitter as unknown as childProcess.ChildProcess;
}

describe('runMcp', () => {
  let detectRuntimeSpy: ReturnType<typeof spyOn>;
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let homeDirSpy: ReturnType<typeof spyOn>;
  let cwdSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      projectKey: undefined,
      rootDir: '/tmp/non-git-dir',
      isGitRepo: false,
      configSources: [],
    });
  });

  afterEach(() => {
    detectRuntimeSpy?.mockRestore();
    discoverProjectSpy.mockRestore();
    spawnSpy?.mockRestore();
    homeDirSpy?.mockRestore();
    cwdSpy?.mockRestore();
  });

  it('throws CommandFailedError when no container runtime is available', () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue(null);

    expect(runMcp(FAKE_AUTH)).rejects.toBeInstanceOf(CommandFailedError);
  });

  it('spawns with podman when podman is the detected runtime', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('podman');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH);

    expect(spawnSpy).toHaveBeenCalledWith(
      'podman',
      expect.arrayContaining(['run', 'mcp/sonarqube']),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('sets SONARQUBE_DEBUG_ENABLED=true in spawn env when --debug is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { debug: true });

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_DEBUG_ENABLED).toBe('true');
    expect(spawnSpy.mock.calls[0][1]).toContain('-e');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_DEBUG_ENABLED');
  });

  it('sets SONARQUBE_READ_ONLY=true in spawn env when --read-only is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { readOnly: true });

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_READ_ONLY).toBe('true');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_READ_ONLY');
  });

  it('sets SONARQUBE_TOOLSETS in spawn env when --toolsets is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { toolsets: 'issues,rules' });

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_TOOLSETS).toBe('issues,rules');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_TOOLSETS');
  });

  it('sets SONARQUBE_PROJECT_KEY in spawn env when --project is set even when discovery runs', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { project: 'my-project' });

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_PROJECT_KEY).toBe('my-project');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(discoverProjectSpy).toHaveBeenCalledTimes(1);
  });

  it('adds fs mount when --project is set and discovered root is a git repo', async () => {
    discoverProjectSpy.mockResolvedValue({
      projectKey: undefined,
      rootDir: '/tmp/git-repo',
      isGitRepo: true,
      configSources: [],
    });
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { project: 'my-project' });

    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(spawnSpy.mock.calls[0][1]).toContain('-v');
    expect(spawnSpy.mock.calls[0][1]).toContain('/tmp/git-repo:/app/mcp-workspace:ro');
  });

  it('skips project discovery when cwd is user home directory', async () => {
    homeDirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/home');
    cwdSpy = spyOn(process, 'cwd').mockReturnValue('/tmp/home');
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_AUTH, { project: 'my-project' });

    expect(discoverProjectSpy).not.toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(spawnSpy.mock.calls[0][1]).not.toContain('-v');
  });
});
