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

export {
  type DependencyDeclaration,
  scaScannerBinaryDependency,
  sonarSecretsBinaryDependency,
  SonarSourceBinary,
  sonarSourceBinary,
  type SonarSourceBinaryDependencyOptions,
  type SonarSourceBinaryDescriptor,
} from '../dependencies';
export {
  jsonPatch,
  type JsonPatchOptions,
  jsonPatchRemover,
  type JsonPatchRemoverOptions,
  type PlatformSpecificContent,
  type RemovableResource,
  type ResourceDeclaration,
  textSnippet,
  textSnippetRemover,
  type TextSnippetRemoverOptions,
  type TextSnippetResourceOptions,
  tomlPatch,
  type TomlPatchOptions,
  tomlPatchRemover,
  type TomlPatchRemoverOptions,
  wholeFile,
  type WholeFileContent,
  wholeFileRemover,
  type WholeFileRemoverOptions,
  type WholeFileResourceOptions,
  yamlPatch,
  type YamlPatchOptions,
  yamlPatchRemover,
  type YamlPatchRemoverOptions,
} from '../resources';
export { renderCompletionSummary } from './completion-summary.ts';
export { buildApplications } from './feature-target.ts';
export {
  installIntegration,
  type InstallIntegrationOptions,
  makeContext,
} from './install-integration.ts';
export {
  findInstalledFeature,
  findInstalledIntegration,
  isFeatureInstalledGloballyForProject,
  recordedFeatureOperations,
  recordedFeatureResources,
} from './installation-recorder.ts';
export {
  IntegrationInstaller,
  integrationInstaller,
  type RemoveFeatureCallbacks,
} from './installer.ts';
export { reconcileInstalledIntegrations } from './reconcile.ts';
export {
  createIntegrationRegistry,
  IntegrationRegistry,
  registerIntegrations,
} from './registry.ts';
export {
  askUser,
  install,
  type InstallDecision,
  selectFeaturesForInvocation,
  skip,
  uninstall,
} from './selection.ts';
export type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  ContainerIntegrationContext,
  DependencyInstallContext,
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  FeatureOperation,
  FeatureSelectionResult,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
  LegacyFeatureDeclaration,
  MaybePromise,
  PostInstallExample,
  SubfeatureDeclaration,
} from './types.ts';
export { isContainerIntegrationContext, isFeatureContainer } from './types.ts';
