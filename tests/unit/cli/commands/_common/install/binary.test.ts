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

import {
  type BinarySpec,
  buildLocalBinaryName,
} from '../../../../../../src/cli/commands/_common/install/binary.js';

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
