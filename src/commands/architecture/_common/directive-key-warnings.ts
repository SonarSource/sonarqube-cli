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

import type { ArchitectureApi } from './architecture-api.ts';
import {
  DEFAULT_DIRECTIVE_PERSPECTIVE,
  type DirectiveInput,
  identityPerspective,
} from './directives.ts';
import { indexStructure } from './graph.ts';

export async function warnDirectiveKeys(
  api: ArchitectureApi,
  directives: DirectiveInput[],
  warn: (message: string) => void,
): Promise<void> {
  const languages = [...new Set(directives.map((directive) => directive.ecosystem))];
  await inSequence(languages, async (language) => {
    let keys: Set<string>;
    try {
      const graphs = await api.getCurrent(language);
      if (graphs.length === 0) {
        warn(`No current ${language} graph is available; directive node keys were not checked.`);
        return;
      }
      keys = new Set(graphs.flatMap(({ graph }) => [...indexStructure(graph).idByKey.keys()]));
    } catch {
      warn(
        `Could not check directive node keys against the current ${language} graph. Review the keys before applying.`,
      );
      return;
    }
    for (const directive of directives.filter((item) => item.ecosystem === language)) {
      const graphType = ['java', 'cs'].includes(language) ? 'namespace_graph' : 'file_graph';
      if (
        directive.graphType !== graphType ||
        identityPerspective(directive.graphPerspective) !== DEFAULT_DIRECTIVE_PERSPECTIVE
      ) {
        warn(
          `Node keys were not checked for ${directive.graphType} perspective ${directive.graphPerspective ?? DEFAULT_DIRECTIVE_PERSPECTIVE}; the public current graph does not identify that view.`,
        );
        continue;
      }
      const checked =
        directive.type === 'RENAME_NODE'
          ? [directive.fromNodeKey]
          : [directive.fromNodeKey, directive.toNodeKey];
      for (const key of new Set(checked)) {
        if (!keys.has(key)) warn(missingDirectiveKeyWarning(directive, key, language));
      }
    }
  });
}

function missingDirectiveKeyWarning(
  directive: DirectiveInput,
  key: string,
  language: string,
): string {
  const guidance =
    directive.type === 'MOVE_NODE' && key === directive.toNodeKey
      ? 'The MOVE_NODE destination must be an existing container, not the moved node’s new key.'
      : 'Review the key before applying.';
  return `Directive ${directive.type}: node '${key}' was not found in the current ${language} graph. ${guidance}`;
}

function inSequence<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((previous, item) => previous.then(() => action(item)), Promise.resolve());
}
