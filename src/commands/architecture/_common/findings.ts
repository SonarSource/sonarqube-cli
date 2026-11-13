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

import { InvalidArgumentError } from 'commander';

import { type CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';
import { MAX_ARCHITECTURE_PAGE_INDEX } from './dependency-query.ts';
import { collectionFailure, incompatibleResponse } from './errors.ts';
import type { SummaryResult } from './summary.ts';

export const DEFAULT_FINDINGS_PAGE_SIZE = 50;
export const MAX_FINDINGS_PAGE_SIZE = 1000;
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
  skippedFindings?: number;
}
export interface FindingsApi {
  getSummaryCounts(language?: Ecosystem): Promise<SummaryResult>;
  getFindingsPage(
    filters: FindingFilters,
    pageIndex: number,
    pageSize: number,
  ): Promise<FindingPage>;
}

export const CATEGORIES_BY_TYPE: Record<FindingType, FindingCategory> = {
  structuralDeviation: 'deviation',
  relationshipDeviation: 'deviation',
  tangle: 'flaw',
  oversizedComponent: 'flaw',
  weakTangle: 'smell',
  splitResponsibility: 'smell',
};

export async function fetchFindingsPage(
  http: SonarHttpClient,
  path: string,
  scope: { organizationId: string; branchId: string },
  filters: FindingFilters,
  pageIndex: number,
  pageSize: number,
): Promise<FindingPage> {
  const result = await http
    .get<{ findings?: unknown[]; page?: FindingPage['page'] } | null>(path, {
      ...scope,
      ...(filters.category === undefined ? {} : { category: filters.category }),
      ...(filters.type === undefined ? {} : { type: filters.type }),
      ...(filters.language === undefined ? {} : { language: filters.language }),
      pageIndex,
      pageSize,
    })
    .orThrow()
    .catch((error: unknown) => collectionFailure(error, http.isCloud));
  return parseFindingPage(result, filters, pageIndex, pageSize);
}

export function parseFindingPageIndex(value: string): number {
  return parseFindingNumber(value, 1, MAX_ARCHITECTURE_PAGE_INDEX, 'page');
}

export function parseFindingPageSize(value: string): number {
  return parseFindingNumber(value, 0, MAX_FINDINGS_PAGE_SIZE, 'page size');
}

function parseFindingNumber(value: string, minimum: number, maximum: number, name: string): number {
  const number = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    const error = new InvalidArgumentError(
      `Finding ${name} must be a whole decimal integer between ${minimum} and ${maximum}.`,
    );
    error.exitCode = 2;
    throw error;
  }
  return number;
}

export function validateFindingFilters(filters: FindingFilters): void {
  if (filters.type && filters.category && CATEGORIES_BY_TYPE[filters.type] !== filters.category) {
    throw new InvalidOptionError(
      `Finding type ${filters.type} belongs to category ${CATEGORIES_BY_TYPE[filters.type]}, not ${filters.category}.`,
    );
  }
}

export function validateFindingPagination(pageIndex: number, pageSize: number): void {
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 1 ||
    pageIndex > MAX_ARCHITECTURE_PAGE_INDEX ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 0 ||
    pageSize > MAX_FINDINGS_PAGE_SIZE
  )
    throw new InvalidOptionError(
      `Finding page must be between 1 and ${MAX_ARCHITECTURE_PAGE_INDEX} and page size must be between 0 and 1000.`,
    );
}

export function parseFindingPage(
  result: { findings?: unknown[]; page?: FindingPage['page'] } | null,
  filters: FindingFilters,
  pageIndex: number,
  pageSize: number,
): FindingPage {
  const page = result?.page;
  if (
    !Array.isArray(result?.findings) ||
    page?.pageIndex !== pageIndex ||
    page.pageSize !== pageSize ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    result.findings.length > pageSize
  )
    throw incompatibleResponse('Invalid public findings page; no complete page was read.');
  if (result.findings.some((value) => !matchesFindingFilters(value, filters)))
    throw incompatibleResponse(
      'The public findings page returned a finding outside the requested filters.',
    );
  const parsed = result.findings.map(parseProjectFinding);
  const findings = parsed.filter((finding) => finding !== undefined);
  const skippedFindings = parsed.length - findings.length;
  return { findings, page, ...(skippedFindings > 0 ? { skippedFindings } : {}) };
}

function matchesFindingFilters(value: unknown, filters: FindingFilters): boolean {
  const row = objectOf(value);
  return (
    (filters.category === undefined || row.category === filters.category) &&
    (filters.type === undefined || row.type === filters.type) &&
    (filters.language === undefined || row.language === filters.language)
  );
}

export function parseProjectFinding(value: unknown): ProjectFinding | undefined {
  const finding = objectOf(value);
  if (typeof finding.type !== 'string' || !finding.type.trim())
    throw invalidFinding('expected type string');
  if (!(FINDING_TYPES as readonly unknown[]).includes(finding.type)) return undefined;
  const type = finding.type as FindingType;
  if (finding.category !== CATEGORIES_BY_TYPE[type])
    throw invalidFinding('invalid category for type');
  if (typeof finding.language !== 'string' || !finding.language.trim())
    throw invalidFinding('expected language string');
  if (!(ECOSYSTEMS as readonly unknown[]).includes(finding.language)) return undefined;
  const details = objectOf(finding.details);
  const isDeviation = type === 'structuralDeviation' || type === 'relationshipDeviation';
  const knownReasons = [
    'misplacedComponent',
    'unimplementedComponent',
    'disallowedDependency',
    'interfaceViolation',
  ];
  if (
    isDeviation &&
    typeof details.reason === 'string' &&
    details.reason.trim() &&
    !knownReasons.includes(details.reason)
  )
    return undefined;

  return {
    type,
    category: CATEGORIES_BY_TYPE[type],
    language: finding.language as Ecosystem,
    details: parseDetails(type, details),
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
  return incompatibleResponse(`Invalid public finding response: ${reason}.`);
}
