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

import type { IntegrationDeclaration } from './types';

export {
  installIntegration,
  type InstallIntegrationOptions,
  IntegrationInstaller,
  integrationInstaller,
} from './installer';
export {
  jsonPatch,
  type JsonPatchOptions,
  type PlatformSpecificContent,
  type ResourceDeclaration,
  SonarSourceBinary,
  sonarSourceBinary,
  type SonarSourceBinaryDescriptor,
  type SonarSourceBinaryResourceOptions,
  textSnippet,
  type TextSnippetResourceOptions,
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
  FeatureDeclaration,
  FeatureOperation,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationInvocation,
  LegacyFeatureDeclaration,
  MaybePromise,
} from './types';

export class IntegrationRegistry {
  private readonly declarations = new Map<string, IntegrationDeclaration>();

  register(declaration: IntegrationDeclaration): void {
    this.validateDeclaration(declaration);
    if (this.declarations.has(declaration.id)) {
      throw new Error(`Integration declaration already registered: ${declaration.id}`);
    }
    this.declarations.set(declaration.id, declaration);
  }

  get(id: string): IntegrationDeclaration | undefined {
    return this.declarations.get(id);
  }

  list(): IntegrationDeclaration[] {
    return [...this.declarations.values()];
  }

  private validateDeclaration(declaration: IntegrationDeclaration): void {
    this.ensureNonEmptyId(declaration.id, 'Integration');
    this.ensureUnique(
      declaration.features.map((feature) => feature.id),
      `Duplicate feature id in integration ${declaration.id}`,
    );
    for (const feature of declaration.features) {
      this.ensureNonEmptyId(feature.id, 'Feature');
      this.ensureUnique(
        (feature.resources ?? []).map((resource) => resource.id),
        `Duplicate resource id in feature ${declaration.id}.${feature.id}`,
      );
      this.ensureUnique(
        (feature.operations ?? []).map((operation) => operation.id),
        `Duplicate operation id in feature ${declaration.id}.${feature.id}`,
      );
      for (const resource of feature.resources ?? []) {
        this.ensureNonEmptyId(resource.id, 'Resource');
      }
      for (const operation of feature.operations ?? []) {
        this.ensureNonEmptyId(operation.id, 'Operation');
      }
    }
    this.ensureUnique(
      (declaration.legacyFeatures ?? []).map((feature) => feature.id),
      `Duplicate legacy feature id in integration ${declaration.id}`,
    );
    for (const legacyFeature of declaration.legacyFeatures ?? []) {
      this.ensureNonEmptyId(legacyFeature.id, 'Legacy feature');
    }
  }

  private ensureUnique(values: string[], message: string): void {
    if (new Set(values).size !== values.length) {
      throw new Error(message);
    }
  }

  private ensureNonEmptyId(id: string, entity: string): void {
    if (id.trim().length === 0) {
      throw new Error(`${entity} id must not be empty`);
    }
  }
}

export const supportedIntegrations = new IntegrationRegistry();
