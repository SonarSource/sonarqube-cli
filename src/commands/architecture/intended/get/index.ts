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

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';

import { createArchitectureApi } from '../../_common/architecture-api.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import { assertGroupExists, revisionOf, viewIntended } from '../../_common/intended-model.ts';
import {
  describeFileSource,
  resolveIntendedSource,
  toSourcePayload,
} from '../../_common/model-source.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  resolveDepth,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';
import { formatIntendedText } from './intended-text.ts';

export async function getIntended(
  options: ArchitectureReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const depth = resolveDepth(options, Number.POSITIVE_INFINITY);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const projectKey = await resolveProject(options, ctx);
  const intendedSource = await resolveIntendedSource(ctx, projectKey);
  const source = toSourcePayload(intendedSource);
  if (intendedSource.type === 'FILE') {
    const message = `The intended architecture of '${projectKey}' is managed by ${describeFileSource(intendedSource)}; analyses don't use the model stored in SonarQube.`;
    if (format === 'text') {
      ctx.console.print(message);
      return;
    }
    ctx.console.warn(message);
    printPayload(ctx, format, { project: projectKey, source, models: [] });
    return;
  }
  const all = await createArchitectureApi(ctx.connection, projectKey)
    .getIntended()
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });
  // The revision covers every stored language, so intended set can check a filtered file too.
  const revision = revisionOf(all);
  const { language } = options;
  const models = language ? all.filter((model) => model.language === language) : all;

  if (models.length === 0) {
    ctx.console.warn(`No intended architecture yet for '${projectKey}'.`);
  }
  const partial = options.component !== undefined || options.depth !== undefined;
  if (options.component !== undefined) assertGroupExists(models, options.component);
  const views = models.flatMap((model) => viewIntended(model, options.component, depth) ?? []);
  if (format === 'text') {
    if (models.length > 0)
      ctx.console.print(formatIntendedText(projectKey, revision, models, views));
    return;
  }
  if (partial) {
    printPayload(ctx, format, {
      project: projectKey,
      revision,
      source,
      partial: true,
      models: views,
    });
    return;
  }
  printPayload(ctx, format, {
    project: projectKey,
    revision,
    source,
    ...(language ? { language } : {}),
    models,
  });
}
