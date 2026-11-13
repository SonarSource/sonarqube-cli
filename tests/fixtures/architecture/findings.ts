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

import type { ProjectFinding } from '@/commands/architecture/_common/findings.ts';

export const findings: ProjectFinding[] = [
  {
    type: 'structuralDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'misplacedComponent', nodeKey: 'app:web', misplacedComponentCount: 3 },
    files: ['Web.java'],
  },
  {
    type: 'structuralDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'unimplementedComponent', nodeKey: 'app:missing' },
    files: [],
  },
  {
    type: 'relationshipDeviation',
    category: 'deviation',
    language: 'java',
    details: {
      reason: 'disallowedDependency',
      fromNodeKey: 'app:web',
      toNodeKey: 'app:db',
      dependencyCount: 4,
    },
    files: ['Web.java'],
  },
  {
    type: 'relationshipDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'interfaceViolation', fromNodeKey: 'app:web', toNodeKey: 'app:internal' },
    files: [],
  },
  {
    type: 'tangle',
    category: 'flaw',
    language: 'java',
    details: { nodeKeys: ['a', 'b'], nodeCount: 2 },
    files: [],
  },
  {
    type: 'oversizedComponent',
    category: 'flaw',
    language: 'java',
    details: { nodeKey: 'large', leafArtifactCount: 40 },
    files: [],
  },
  {
    type: 'weakTangle',
    category: 'smell',
    language: 'ts',
    details: { nodeKeys: ['c', 'd'], nodeCount: 2 },
    files: [],
  },
  {
    type: 'splitResponsibility',
    category: 'smell',
    language: 'ts',
    details: { nodeKey: 'util', fragmentCount: 3 },
    files: [],
  },
];
