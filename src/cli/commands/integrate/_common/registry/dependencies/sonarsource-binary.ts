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

import { SONAR_SECRETS_DIST_PREFIX } from '../../../../../../lib/config-constants';
import { SECRETS_BINARY_NAME } from '../../../../../../lib/install-types';
import {
  SONAR_SECRETS_SIGNATURES,
  SONAR_SECRETS_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../../../lib/signatures';
import {
  type BinarySpec,
  installBinary,
  resolveBinaryPath,
} from '../../../../_common/install/binary';
import type { DependencyInstallContext, InstalledDependency, IntegrationContext } from '../types';
import { type BaseDependencyOptions, type DependencyDeclaration } from './common';

export interface SonarSourceBinaryDescriptor {
  id: string;
  spec: BinarySpec;
}

export const SonarSourceBinary = {
  SonarSecrets: {
    id: SECRETS_BINARY_NAME,
    spec: {
      name: SECRETS_BINARY_NAME,
      version: SONAR_SECRETS_VERSION,
      distPrefix: SONAR_SECRETS_DIST_PREFIX,
      signatures: SONAR_SECRETS_SIGNATURES,
      publicKey: SONARSOURCE_PUBLIC_KEY,
    },
  },
} as const satisfies Record<string, SonarSourceBinaryDescriptor>;

export interface SonarSourceBinaryDependencyOptions extends BaseDependencyOptions {
  binary: SonarSourceBinaryDescriptor;
}

export function sonarSourceBinary(
  options: SonarSourceBinaryDependencyOptions,
): DependencyDeclaration {
  return new SonarSourceBinaryDependency(options);
}

export class SonarSourceBinaryDependency implements DependencyDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly dependencyType = 'sonarsource-binary';
  readonly version: string;

  constructor(private readonly options: SonarSourceBinaryDependencyOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version ?? options.binary.spec.version;
  }

  async installOrUpdate(_context: DependencyInstallContext): Promise<InstalledDependency> {
    const result = await installBinary(this.options.binary.spec);
    return {
      id: this.id,
      dependencyType: this.dependencyType,
      version: this.version,
      path: result.binaryPath,
    };
  }

  isInstalled(_context: IntegrationContext): boolean {
    return resolveBinaryPath(this.options.binary.spec) !== null;
  }
}

export const sonarSecretsBinaryDependency = sonarSourceBinary({
  id: 'sonar-secrets',
  displayName: 'sonar-secrets binary',
  binary: SonarSourceBinary.SonarSecrets,
});
