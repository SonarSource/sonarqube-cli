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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  type BinarySpec,
  buildLocalBinaryName,
  removeBinary,
} from '../../../../../src/commands/_common/install/binary.ts';
import { detectPlatform } from '../../../../../src/lib/platform-detector.ts';

const baseSpec: Omit<BinarySpec, 'name' | 'version'> = {
  distPrefix: 'CommercialDistribution/whatever',
  signatures: {},
  publicKey: '',
};

describe('buildLocalBinaryName', () => {
  it('uses the spec name and version with the platform suffix', () => {
    const name = buildLocalBinaryName(
      { ...baseSpec, name: 'sonar-secrets', version: '2.41.0.10709' },
      { os: 'linux', arch: 'arm64', extension: '' },
    );
    expect(name).toBe('sonar-secrets-2.41.0.10709-linux-arm64');
  });

  it('appends .exe on Windows via the platform extension', () => {
    const name = buildLocalBinaryName(
      { ...baseSpec, name: 'sonar-secrets', version: '1.2.3' },
      { os: 'windows', arch: 'x86-64', extension: '.exe' },
    );
    expect(name).toBe('sonar-secrets-1.2.3-windows-x86-64.exe');
  });
});

describe('removeBinary', () => {
  const spec: BinarySpec = { ...baseSpec, name: 'sonar-secrets', version: '1.2.3' };
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'sonar-cli-bin-'));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('deletes the cached binary and reports it removed', () => {
    const binaryPath = join(binDir, buildLocalBinaryName(spec, detectPlatform()));
    writeFileSync(binaryPath, 'binary');

    expect(removeBinary(spec, binDir)).toBe(true);
    expect(existsSync(binaryPath)).toBe(false);
  });

  it('is a no-op when the binary is absent', () => {
    expect(removeBinary(spec, binDir)).toBe(false);
  });
});
