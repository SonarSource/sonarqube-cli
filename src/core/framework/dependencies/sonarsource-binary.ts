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

import {
  type BinarySpec,
  installBinary,
  removeBinary,
  resolveBinaryPath,
} from '@/core/host/install/binary.ts';
import { SCA_SCANNER_SPEC } from '@/core/host/install/sca-scanner.ts';
import { SECRETS_SPEC } from '@/core/host/install/secrets.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

import type {
  DependencyInstallContext,
  InstalledDependency,
  IntegrationContext,
} from '../features/types.ts';
import { type BaseDependencyOptions, type DependencyDeclaration } from './common.ts';

export interface SonarSourceBinaryDependencyOptions extends BaseDependencyOptions {
  spec: BinarySpec;
}

export function sonarSourceBinary(
  options: SonarSourceBinaryDependencyOptions,
): DependencyDeclaration {
  return new SonarSourceBinaryDependency(options);
}

export class SonarSourceBinaryDependency implements DependencyDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly version: string;

  constructor(private readonly options: SonarSourceBinaryDependencyOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version ?? options.spec.version;
  }

  async installOrUpdate(_context: DependencyInstallContext): Promise<InstalledDependency> {
    const result = await installBinary(this.options.spec, {
      console: new TerminalConsole(),
    });
    return {
      id: this.id,
      version: this.version,
      path: result.binaryPath,
    };
  }

  isInstalled(_context: IntegrationContext): boolean {
    return resolveBinaryPath(this.options.spec) !== null;
  }

  remove(_context: IntegrationContext): void {
    removeBinary(this.options.spec);
  }
}

export const sonarSecretsBinaryDependency = sonarSourceBinary({
  id: SECRETS_SPEC.name,
  displayName: 'sonar-secrets binary',
  spec: SECRETS_SPEC,
});

export const scaScannerBinaryDependency = sonarSourceBinary({
  id: SCA_SCANNER_SPEC.name,
  displayName: 'sca-scanner-cli binary',
  spec: SCA_SCANNER_SPEC,
});
