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

// The architecture port: what the `sonar architecture` commands need from SonarQube,
// independent of which endpoints serve it.

import type { SonarConnection } from '@/core/server/connection.ts';

import { SonarArchitectureApi } from './sonar-architecture-api.ts';

export const ECOSYSTEMS = ['java', 'cs', 'js', 'ts', 'py'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface StructureEdge {
  toId: number;
  weight: number;
}

export interface StructureNode {
  id: number;
  name: string;
  kind: string;
  /** What this node's children are joined to it with, e.g. `:` for a module. */
  separator?: string;
  edges: StructureEdge[];
  nodes?: StructureNode[];
}

export interface StructureGraph {
  /** Absent from the public API, whose graphs have no id. */
  id?: string;
  nodeCount: number;
  edgeCount: number;
  nodes: StructureNode[];
}

/** One analyzed language of the current architecture. */
export interface CurrentGraph {
  ecosystem: Ecosystem;
  graph: StructureGraph;
}

export interface IntendedGroup {
  label: string;
  patterns?: string[];
  groups?: IntendedGroup[];
  interface?: boolean;
  interfaceAccess?: boolean;
}

export interface IntendedConstraint {
  from: string;
  to: string;
}

/** The intended architecture of one language, as SonarQube exports it. */
export interface IntendedArchitecture {
  type: 'file' | 'namespace';
  language: Ecosystem;
  groups: IntendedGroup[];
  constraints: IntendedConstraint[];
}

export interface ArchitectureApi {
  /** The current architecture per analyzed language; `[]` when nothing was analyzed yet. */
  getCurrent(language?: Ecosystem): Promise<CurrentGraph[]>;
  /** The intended architecture per language; `[]` when the project has none. */
  getIntended(): Promise<IntendedArchitecture[]>;
  /** Saves `models` as the project's intended architecture; the project must have none. */
  createIntended(models: IntendedArchitecture[]): Promise<void>;
  /** Removes the project's intended architecture. */
  deleteIntended(): Promise<void>;
}

export function createArchitectureApi(
  connection: SonarConnection,
  projectKey: string,
): ArchitectureApi {
  return new SonarArchitectureApi(connection, projectKey);
}
