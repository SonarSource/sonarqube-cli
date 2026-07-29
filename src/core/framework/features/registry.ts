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

import type { FeatureDeclaration, IntegrationDeclaration } from './types.ts';
import { isFeatureContainer } from './types.ts';

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
      this.validateFeature(declaration, feature);
    }
    this.validateReplacements(declaration);
    this.ensureUnique(
      (declaration.legacyFeatures ?? []).map((feature) => feature.id),
      `Duplicate legacy feature id in integration ${declaration.id}`,
    );
    for (const legacyFeature of declaration.legacyFeatures ?? []) {
      this.ensureNonEmptyId(legacyFeature.id, 'Legacy feature');
    }
  }

  private validateReplacements(declaration: IntegrationDeclaration): void {
    const featureIds = new Set(declaration.features.map((feature) => feature.id));
    const replacedIds: string[] = [];

    for (const feature of declaration.features) {
      for (const replacedId of feature.replacedIds ?? []) {
        this.ensureNonEmptyId(replacedId, 'Replaced feature');
        if (featureIds.has(replacedId)) {
          throw new Error(
            `Feature ${declaration.id}.${feature.id} replaces an active feature id: ${replacedId}`,
          );
        }
        replacedIds.push(replacedId);
      }
    }

    this.ensureUnique(
      replacedIds,
      `Duplicate replaced feature id in integration ${declaration.id}`,
    );
  }

  private validateFeature(declaration: IntegrationDeclaration, feature: FeatureDeclaration): void {
    this.ensureNonEmptyId(feature.id, 'Feature');
    const featurePath = `${declaration.id}.${feature.id}`;
    const subfeatures = isFeatureContainer(feature) ? feature.subfeatures : [];
    const resources = [
      ...(feature.resources ?? []),
      ...subfeatures.flatMap((subfeature) => subfeature.resources ?? []),
    ];
    const operations = [
      ...(feature.operations ?? []),
      ...subfeatures.flatMap((subfeature) => subfeature.operations ?? []),
    ];

    this.ensureUnique(
      (feature.dependencies ?? []).map((dependency) => dependency.id),
      `Duplicate dependency id in feature ${featurePath}`,
    );
    this.ensureUnique(
      resources.map((resource) => resource.id),
      `Duplicate resource id in feature ${featurePath}`,
    );
    this.ensureUnique(
      operations.map((operation) => operation.id),
      `Duplicate operation id in feature ${featurePath}`,
    );
    for (const dependency of feature.dependencies ?? []) {
      this.ensureNonEmptyId(dependency.id, 'Dependency');
    }
    for (const resource of resources) {
      this.ensureNonEmptyId(resource.id, 'Resource');
    }
    for (const operation of operations) {
      this.ensureNonEmptyId(operation.id, 'Operation');
    }
    if (isFeatureContainer(feature)) {
      this.ensureUnique(
        feature.subfeatures.map((subfeature) => subfeature.id),
        `Duplicate subfeature id in container ${featurePath}`,
      );
      for (const subfeature of feature.subfeatures) {
        this.ensureNonEmptyId(subfeature.id, 'Subfeature');
      }
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

export function registerIntegrations(
  registry: IntegrationRegistry,
  declarations: Iterable<IntegrationDeclaration>,
): void {
  for (const declaration of declarations) {
    registry.register(declaration);
  }
}

export function createIntegrationRegistry(
  declarations: Iterable<IntegrationDeclaration> = [],
): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  registerIntegrations(registry, declarations);
  return registry;
}
