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

import type { StructureGraph, StructureNode } from '@/core/architecture/architecture-api.ts';

// Generated entirely from counters; no captured project or analysis data.
const MODULE_COUNT = 28;
const PACKAGE_COUNT = 6;
const CLASS_COUNT = 8;
let nextId = 1;
const modules: StructureNode[] = Array.from({ length: MODULE_COUNT }, (_, moduleIndex) => ({
  id: nextId++,
  name: `module-${String(moduleIndex).padStart(2, '0')}`,
  kind: 'module',
  edges: [],
  nodes: [
    {
      id: nextId++,
      name: 'com.example.synthetic',
      kind: 'package',
      edges: [],
      nodes: Array.from({ length: PACKAGE_COUNT }, (_, packageIndex) => ({
        id: nextId++,
        name: `layer${packageIndex}`,
        kind: 'package',
        edges: [],
        nodes: Array.from({ length: CLASS_COUNT }, (_, classIndex) => ({
          id: nextId++,
          name: `Component${classIndex}`,
          kind: 'class',
          edges: [],
        })),
      })),
    },
  ],
}));
for (const [moduleIndex, module] of modules.entries()) {
  const packages = module.nodes![0].nodes!;
  for (const [fromIndex, from] of packages.entries()) {
    for (const [toIndex, to] of packages.entries()) {
      if (fromIndex === toIndex) continue;
      const low = Math.min(fromIndex, toIndex);
      const high = Math.max(fromIndex, toIndex);
      from.edges.push({ toId: to.id, weight: (fromIndex < toIndex ? 100 : 50) - low * 6 - high });
    }
    if (moduleIndex + 1 < modules.length) {
      for (const child of from.nodes!) {
        child.edges.push({ toId: modules[moduleIndex + 1].id, weight: 3 });
      }
    }
  }
}

export const SYNTHETIC_NODE_COUNT = MODULE_COUNT * (2 + PACKAGE_COUNT * (1 + CLASS_COUNT));
export const SYNTHETIC_MODULE_COUNT = MODULE_COUNT;
export const SYNTHETIC_GRAPH: StructureGraph[] = [
  {
    id: 'synthetic-graph',
    nodeCount: SYNTHETIC_NODE_COUNT,
    edgeCount:
      MODULE_COUNT * PACKAGE_COUNT * (PACKAGE_COUNT - 1) +
      (MODULE_COUNT - 1) * PACKAGE_COUNT * CLASS_COUNT,
    nodes: modules,
  },
];
