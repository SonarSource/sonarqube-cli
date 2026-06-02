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

import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../../../lib/install-types';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../../../lib/signatures';
import {
  installContextAugmentationBinary,
  resolveContextAugmentationBinaryPath,
} from '../../../../_common/install/context-augmentation';
import { stopAllContextAugmentationTools } from '../../context-augmentation';
import type { InstalledDependency, IntegrationContext } from '../types';
import type { BaseDependencyOptions, DependencyDeclaration } from './common';

export type ContextAugmentationBinaryDependencyOptions = BaseDependencyOptions;

export class ContextAugmentationBinaryDependency implements DependencyDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly dependencyType = 'context-augmentation-binary';
  readonly version: string;
  readonly beforeUpdate = async ({
    installedDependency,
  }: {
    installedDependency?: InstalledDependency;
  }) => {
    const binaryPath = installedDependency?.path ?? resolveContextAugmentationBinaryPath();
    if (!binaryPath) {
      return;
    }
    await stopAllContextAugmentationTools(binaryPath);
  };

  constructor(options: ContextAugmentationBinaryDependencyOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version ?? SONAR_CONTEXT_AUGMENTATION_VERSION;
  }

  async install(_context: IntegrationContext): Promise<InstalledDependency> {
    const binaryPath = await installContextAugmentationBinary();
    return {
      id: this.id,
      dependencyType: this.dependencyType,
      version: this.version,
      path: binaryPath,
    };
  }

  isInstalled(_context: IntegrationContext): boolean {
    return resolveContextAugmentationBinaryPath() !== null;
  }
}

export const contextAugmentationBinaryDependency = new ContextAugmentationBinaryDependency({
  id: CONTEXT_AUGMENTATION_BINARY_NAME,
  displayName: 'sonar-context-augmentation binary',
});
