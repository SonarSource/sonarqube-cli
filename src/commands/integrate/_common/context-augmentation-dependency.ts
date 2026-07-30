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

import { rmSync } from 'node:fs';

import type {
  BaseDependencyOptions,
  DependencyDeclaration,
} from '@/core/framework/dependencies/common.ts';
import type {
  DependencyInstallContext,
  InstalledDependency,
  IntegrationContext,
} from '@/core/framework/features/types.ts';
import {
  installContextAugmentationBinary,
  resolveContextAugmentationBinaryPath,
} from '@/core/host/install/context-augmentation.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install-types.ts';

import { stopAllContextAugmentationTools } from './context-augmentation.ts';

export type ContextAugmentationBinaryDependencyOptions = BaseDependencyOptions;

export class ContextAugmentationBinaryDependency implements DependencyDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly dependencyType = 'context-augmentation-binary';
  readonly version: string;

  constructor(options: ContextAugmentationBinaryDependencyOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version ?? SONAR_CONTEXT_AUGMENTATION_VERSION;
  }

  async installOrUpdate(context: DependencyInstallContext): Promise<InstalledDependency> {
    const previousBinaryPath =
      context.existingDependency?.path ?? resolveContextAugmentationBinaryPath();
    if (previousBinaryPath) {
      await stopAllContextAugmentationTools(previousBinaryPath);
    }

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

  async remove(_context: IntegrationContext): Promise<void> {
    const binaryPath = resolveContextAugmentationBinaryPath();
    if (binaryPath === null) {
      return;
    }
    await stopAllContextAugmentationTools(binaryPath);
    rmSync(binaryPath, { force: true });
  }
}

export const contextAugmentationBinaryDependency = new ContextAugmentationBinaryDependency({
  id: CONTEXT_AUGMENTATION_BINARY_NAME,
  displayName: 'sonar-context-augmentation binary',
});
