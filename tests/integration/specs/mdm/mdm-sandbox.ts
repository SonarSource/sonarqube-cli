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

import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

import { ENV_MDM_BINARY_PATH, ENV_MDM_USER_HOMES } from '@/core/config-constants.ts';

import type { TestHarness } from '../../harness';
import { IS_WINDOWS } from '../../harness';
import type { Dir } from '../../harness/dir';
import type { FakeBinariesServer } from '../../harness/fake-binaries-server.js';

export const SKIP_ON_WINDOWS = IS_WINDOWS;

const SYSTEM_PATH = '/usr/bin:/bin';

export function fakeCliScript(version: string): string {
  return `#!/bin/sh\necho "${version}"\n`;
}

export class MdmSandbox {
  readonly root: Dir;
  readonly binaryPath: string;
  readonly homes: string[];
  readonly pathDir: string;

  constructor(private readonly harness: TestHarness) {
    this.root = harness.cwd.dir('mdm');
    this.binaryPath = this.root.file('system', 'bin', 'sonar').path;
    this.homes = [this.root.dir('home-a').path, this.root.dir('home-b').path];
    this.pathDir = this.root.dir('path-bin').path;
    mkdirSync(this.pathDir, { recursive: true });
  }

  env(): Record<string, string> {
    return {
      [ENV_MDM_BINARY_PATH]: this.binaryPath,
      [ENV_MDM_USER_HOMES]: this.homes.join(delimiter),
      PATH: `${this.pathDir}:${SYSTEM_PATH}`,
    };
  }

  run(args: string, extraArgs = '') {
    return this.harness.run(`mdm ${args} ${extraArgs}`.trim(), { extraEnv: this.env() });
  }

  runWithCdn(args: string, cdn: FakeBinariesServer, extraArgs = '') {
    return this.run(`${args} --artifact-base-url ${cdn.cliArtifactBaseUrl()}`, extraArgs);
  }

  standalonePath(homeIndex: number): string {
    return this.root.file(
      this.homes[homeIndex].split('/').at(-1) ?? '',
      '.local',
      'share',
      'sonarqube-cli',
      'bin',
      'sonar',
    ).path;
  }

  seedStandalone(homeIndex: number): string {
    const path = this.standalonePath(homeIndex);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, fakeCliScript('0.0.1-standalone'));
    chmodSync(path, 0o755);
    return path;
  }

  seedSystemBinary(version: string, mode = 0o755): void {
    mkdirSync(this.binaryPath.slice(0, this.binaryPath.lastIndexOf('/')), { recursive: true });
    writeFileSync(this.binaryPath, fakeCliScript(version));
    chmodSync(this.binaryPath, mode);
  }

  seedPathCopy(version: string, script = fakeCliScript(version)): string {
    const path = `${this.pathDir}/sonar`;
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  }

  seedStandaloneSymlink(homeIndex: number): string {
    const path = this.standalonePath(homeIndex);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    symlinkSync(this.binaryPath, path);
    return path;
  }
}

export function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}
