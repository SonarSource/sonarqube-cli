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

import type { InstalledDependency, IntegrationContext, MaybePromise } from '../types';

export interface BaseDependencyOptions {
  id: string;
  displayName?: string;
  version?: string;
}

export interface DependencyUpdateContext extends IntegrationContext {
  dependency: DependencyDeclaration;
  installedDependency?: InstalledDependency;
}

export type DependencyBeforeUpdate = (context: DependencyUpdateContext) => MaybePromise<void>;

export interface DependencyDeclaration {
  id: string;
  displayName?: string;
  dependencyType: string;
  version?: string;
  beforeUpdate?: DependencyBeforeUpdate;
  install: (context: IntegrationContext) => MaybePromise<InstalledDependency>;
  isInstalled: (context: IntegrationContext) => MaybePromise<boolean>;
}
