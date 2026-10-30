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

import { parseInteger } from '@/core/commands/params.ts';
import { type SonarCommand, SonarOption, Stage } from '@/core/commands/sonar-command.ts';

import { ECOSYSTEMS } from './_common/architecture-api.ts';
import { DEFAULT_MAX_NODES } from './_common/graph.ts';
import { type ArchitectureReadOptions, TEXT_FORMATS } from './_common/read-options.ts';
import { getCurrent } from './current/get/index.ts';
import {
  type DirectivesReadOptions,
  getDirectives as getArchitectureDirectives,
} from './directives/get/index.ts';
import { setProjectDirectives } from './directives/set/index.ts';
import { installSkill, type InstallSkillOptions } from './install-skill.ts';
import { getIntended } from './intended/get/index.ts';
import { type SetFileOptions, setIntended } from './intended/set/index.ts';

export function registerArchitectureCommands(parent: SonarCommand): void {
  const architecture = parent
    .command('architecture')
    .alias('arch')
    .description('Read and set the architecture of a project')
    .rootHelp({ category: 'data' });

  const currentArchitecture = architecture
    .command('current')
    .description('Read the current architecture');
  const intendedArchitecture = architecture
    .command('intended')
    .description('Read and set the intended architecture');
  const languageOption = (): SonarOption =>
    new SonarOption('--language <language>', 'Only this language (default: all)').choices(
      ECOSYSTEMS,
    );
  const textFormatOption = (): SonarOption =>
    new SonarOption(
      '--format <format>',
      'Output format (default: text on a terminal, toon otherwise)',
    ).choices(TEXT_FORMATS);
  currentArchitecture
    .command('get')
    .description(
      `Current architecture, at most ${DEFAULT_MAX_NODES} nodes, 20 dependencies and 5 feedback pairs across languages; drill down with --component and --depth`,
    )
    .option('-p, --project <project>', 'Project key')
    .option('--component <key>', 'Node key to start below, from a previous current get')
    .option('--depth <n>', 'Levels below the start node (default 1)', parseInteger)
    .addOption(languageOption())
    .addOption(textFormatOption())
    .authenticatedAction((ctx, options: ArchitectureReadOptions) => getCurrent(options, ctx));
  intendedArchitecture
    .command('get')
    .description(
      'Intended architecture; full JSON can be saved with intended set, --component/--depth give partial views, --language exports are CLI-only and cannot be passed to MCP architecture_set',
    )
    .option('-p, --project <project>', 'Project key')
    .option('--component <key>', 'Group key to start below, e.g. Domain/Billing')
    .option('--depth <n>', 'Levels of groups below the start group (default: all)', parseInteger)
    .addOption(languageOption())
    .addOption(textFormatOption())
    .authenticatedAction((ctx, options: ArchitectureReadOptions) => getIntended(options, ctx));

  intendedArchitecture
    .command('set')
    .description(
      'Replace the intended architecture with a file shaped like the output of intended get --format json',
    )
    .requiredOption('--file <file>', 'Intended architecture JSON file')
    .option('--dry-run', 'Validate and show the changes, removals first, without writing')
    .option('-p, --project <project>', 'Project key')
    .authenticatedAction((ctx, options: SetFileOptions) => setIntended(options, ctx));

  const directives = architecture
    .command('directives')
    .description('Read, create, update and delete project directives');
  directives
    .command('get')
    .description('Read a directive by id or list a page of visible project directives')
    .option('--id <id>', 'Directive UUID; cannot be combined with pagination')
    .option('-p, --project <project>', 'Project key')
    .addOption(textFormatOption())
    .option('--page <n>', 'Page number (default 1)', parseInteger)
    .option('--page-size <n>', 'Items per page (default 50, maximum 1000)', parseInteger)
    .authenticatedAction((ctx, options: DirectivesReadOptions) =>
      getArchitectureDirectives(options, ctx),
    );
  directives
    .command('set')
    .description('Create, update or delete explicit project directives')
    .requiredOption('--file <file>', 'JSON object with create, update and delete arrays')
    .option('--dry-run', 'Preview changes without writing')
    .option('-p, --project <project>', 'Project key')
    .addHelpText(
      'after',
      '\nCreation skips existing directives. Updates retain unspecified fields. Deletion requires an explicit ID; omissions never delete entries.',
    )
    .authenticatedAction((ctx, options: SetFileOptions) => setProjectDirectives(options, ctx));

  architecture
    .command('install-skill')
    .stage(Stage.Beta())
    .description('Install the architecture skill for Claude Code and Cursor in this repository')
    .option('--global', 'Install in the home directory instead of the repository')
    .option('--force', 'Replace a SKILL.md that was not written by this command')
    .authenticatedAction((ctx, options: InstallSkillOptions) => installSkill(options, ctx));
}
