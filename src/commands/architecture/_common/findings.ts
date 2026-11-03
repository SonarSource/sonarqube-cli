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

import { CommandFailedError } from '@/core/commands/command-error.ts';

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';

export const DEFAULT_FINDINGS_PAGE_SIZE = 50;
export const FINDING_CATEGORIES = ['deviation', 'flaw', 'smell'] as const;
export const FINDING_TYPES = [
  'structuralDeviation',
  'relationshipDeviation',
  'tangle',
  'oversizedComponent',
  'weakTangle',
  'splitResponsibility',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export type FindingType = (typeof FINDING_TYPES)[number];

export interface FindingDetails {
  reason?:
    'misplacedComponent' | 'unimplementedComponent' | 'disallowedDependency' | 'interfaceViolation';
  nodeKey?: string;
  fromNodeKey?: string;
  toNodeKey?: string;
  nodeKeys?: string[];
  nodeCount?: number;
  misplacedComponentCount?: number;
  dependencyCount?: number;
  leafArtifactCount?: number;
  fragmentCount?: number;
}
export interface ProjectFinding {
  type: FindingType;
  category: FindingCategory;
  language: Ecosystem;
  details: FindingDetails;
  files: string[];
}
export interface FindingFilters {
  category?: FindingCategory;
  type?: FindingType;
  language?: Ecosystem;
}
export interface FindingPage {
  findings: ProjectFinding[];
  page: { pageIndex: number; pageSize: number; total: number };
}
export interface FindingsApi {
  getFindingsPage(
    filters: FindingFilters,
    pageIndex: number,
    pageSize: number,
  ): Promise<FindingPage>;
}

const CATEGORIES_BY_TYPE: Record<FindingType, FindingCategory> = {
  structuralDeviation: 'deviation',
  relationshipDeviation: 'deviation',
  tangle: 'flaw',
  oversizedComponent: 'flaw',
  weakTangle: 'smell',
  splitResponsibility: 'smell',
};

export function parseProjectFinding(value: unknown): ProjectFinding {
  const finding = objectOf(value);
  if (!(FINDING_TYPES as readonly unknown[]).includes(finding.type))
    throw invalidFinding('unsupported type');
  const type = finding.type as FindingType;
  if (finding.category !== CATEGORIES_BY_TYPE[type])
    throw invalidFinding('invalid category for type');
  if (!(ECOSYSTEMS as readonly unknown[]).includes(finding.language))
    throw invalidFinding('unsupported language');
  return {
    type,
    category: CATEGORIES_BY_TYPE[type],
    language: finding.language as Ecosystem,
    details: parseDetails(type, objectOf(finding.details)),
    files: stringsOf(finding.files),
  };
}

function parseDetails(type: FindingType, details: Record<string, unknown>): FindingDetails {
  switch (type) {
    case 'structuralDeviation':
      return {
        reason: reasonOf(details, ['misplacedComponent', 'unimplementedComponent']),
        nodeKey: stringOf(details.nodeKey),
        ...optionalCount(details, 'misplacedComponentCount'),
      };
    case 'relationshipDeviation':
      return {
        reason: reasonOf(details, ['disallowedDependency', 'interfaceViolation']),
        fromNodeKey: stringOf(details.fromNodeKey),
        toNodeKey: stringOf(details.toNodeKey),
        ...optionalCount(details, 'dependencyCount'),
      };
    case 'tangle':
    case 'weakTangle':
      return { nodeKeys: stringsOf(details.nodeKeys), nodeCount: countOf(details.nodeCount) };
    case 'oversizedComponent':
    case 'splitResponsibility':
      return {
        nodeKey: stringOf(details.nodeKey),
        ...optionalCount(details, 'leafArtifactCount'),
        ...optionalCount(details, 'fragmentCount'),
      };
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidFinding('expected object');
  return value as Record<string, unknown>;
}
function stringOf(value: unknown): string {
  if (typeof value !== 'string') throw invalidFinding('expected string');
  return value;
}
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalidFinding('expected string array');
  return value as string[];
}
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw invalidFinding('expected nonnegative integer count');
  return value;
}
function optionalCount(details: Record<string, unknown>, name: string): Record<string, number> {
  return details[name] == null ? {} : { [name]: countOf(details[name]) };
}
function reasonOf(
  details: Record<string, unknown>,
  reasons: NonNullable<FindingDetails['reason']>[],
): NonNullable<FindingDetails['reason']> {
  if (!(reasons as readonly unknown[]).includes(details.reason))
    throw invalidFinding('unsupported deviation reason');
  return details.reason as NonNullable<FindingDetails['reason']>;
}
function invalidFinding(reason: string): CommandFailedError {
  return new CommandFailedError(`Invalid public finding response: ${reason}.`);
}
