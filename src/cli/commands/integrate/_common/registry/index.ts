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

export { createIntegrationRegistry, IntegrationRegistry, registerIntegrations } from './core';
export {
  type DependencyDeclaration,
  sonarSecretsBinaryDependency,
  SonarSourceBinary,
  sonarSourceBinary,
  type SonarSourceBinaryDependencyOptions,
  type SonarSourceBinaryDescriptor,
} from './dependencies';
export {
  installIntegration,
  type InstallIntegrationOptions,
  makeContext,
} from './install-integration';
export {
  IntegrationInstaller,
  integrationInstaller,
  type RemoveFeatureCallbacks,
} from './installer';
export {
  jsonPatch,
  type JsonPatchOptions,
  type PlatformSpecificContent,
  type ResourceDeclaration,
  textSnippet,
  type TextSnippetResourceOptions,
  tomlPatch,
  type TomlPatchOptions,
  wholeFile,
  type WholeFileContent,
  type WholeFileResourceOptions,
  yamlPatch,
  type YamlPatchOptions,
} from './resources';
export type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  DependencyInstallContext,
  FeatureDeclaration,
  FeatureOperation,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
  LegacyFeatureDeclaration,
  MaybePromise,
} from './types';
