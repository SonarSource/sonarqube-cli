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

import type { Help, Option } from 'commander';

import { version as VERSION } from '../../package.json';
import { softBlue, underline } from '../ui/colors.ts';
import {
  COMMAND_CATEGORIES,
  type CommandCategory,
  type SonarCommand,
} from './_common/sonar-command.ts';

const BANNER_ART = [
  '  █▀ █▀█ █▄ █ ▄▀█ █▀█ █▀█ █ █ █▄▄ █▀▀   ▄█▀ █   █',
  '  ▄█ █▄█ █ ▀█ █▀█ █▀▄ ▀▀█ █▄█ █▄█ ██▄   ▀█▄ ██▄ █',
] as const;
const ROOT_HELP_OPTION = '--help';
const ROOT_VERSION_OPTION = '--version';
const ROOT_DOCUMENTATION_URL = 'https://sonarsource.com/sonarqube/cli';
const ROOT_FEEDBACK_URL = 'https://forms.gle/jrGic3awT5t5vf7V9';
const QUICKSTART_STEP_AUTH = 'sonar auth login';
const QUICKSTART_STEP_ANALYZE = 'sonar analyze --file <file>';
const ROOT_OPTION_SUMMARIES = new Map<string, string>([
  [ROOT_HELP_OPTION, 'Display help for a specific command'],
  [ROOT_VERSION_OPTION, 'Show current version'],
]);
const DEFAULT_ROOT_COMMAND_CATEGORY: CommandCategory = 'core';

interface HelpMenuEntry {
  label: string;
  summary: string;
}

export function getBanner(version: string): string {
  const bannerVersion = softBlue(`v${version}`);
  return [...BANNER_ART, `  ${bannerVersion}`].join('\n');
}

function renderAlignedEntries(entries: HelpMenuEntry[]): string[] {
  const maxLabelLength = Math.max(...entries.map((entry) => entry.label.length), 0);

  return entries.map(
    (entry) => `    ${softBlue(entry.label.padEnd(maxLabelLength))}  ${entry.summary}`,
  );
}

function renderGroupedAlignedEntries(groups: HelpMenuEntry[][]): string[] {
  const allEntries = groups.flat();
  const maxLabelLength = Math.max(...allEntries.map((entry) => entry.label.length), 0);

  return groups.flatMap((entries, index) => [
    ...entries.map(
      (entry) => `    ${softBlue(entry.label.padEnd(maxLabelLength))}  ${entry.summary}`,
    ),
    ...(index < groups.length - 1 ? [''] : []),
  ]);
}

function getVisibleChildCommands(command: SonarCommand, helper: Help): SonarCommand[] {
  return (helper.visibleCommands(command) as SonarCommand[]).filter(
    (child) => child.name() !== 'help',
  );
}

function getRootCommandLabel(command: SonarCommand, helper: Help): string {
  if (command.rootHelpMetadata.label) {
    return command.rootHelpMetadata.label;
  }
  if (command.rootHelpMetadata.expandSubcommands) {
    return command.name();
  }

  const visibleChildren = getVisibleChildCommands(command, helper);
  if (visibleChildren.length === 0) {
    return command.name();
  }

  return `${command.name()} <${visibleChildren.map((child) => child.name()).join('|')}>`;
}

function getRootCommandCategory(command: SonarCommand): CommandCategory {
  return command.rootHelpMetadata.category ?? DEFAULT_ROOT_COMMAND_CATEGORY;
}

function getRootCommandSubcommandEntries(command: SonarCommand, helper: Help): HelpMenuEntry[] {
  if (!command.rootHelpMetadata.expandSubcommands) {
    return [];
  }

  return getVisibleChildCommands(command, helper).map((child) => ({
    label: `${command.name()} ${child.name()}`,
    summary: child.description(),
  }));
}

function getRootCommandEntries(rootCommand: SonarCommand, helper: Help): HelpMenuEntry[][] {
  const groupedEntries = new Map<CommandCategory, HelpMenuEntry[]>(
    COMMAND_CATEGORIES.map((category) => [category, []]),
  );

  for (const command of getVisibleChildCommands(rootCommand, helper)) {
    const category = getRootCommandCategory(command);
    const entries = groupedEntries.get(category);
    if (!entries) {
      continue;
    }

    entries.push(
      {
        label: getRootCommandLabel(command, helper),
        summary: command.description(),
      },
      ...getRootCommandSubcommandEntries(command, helper),
    );
  }

  return COMMAND_CATEGORIES.map((category) => groupedEntries.get(category) ?? []).filter(
    (entries) => entries.length > 0,
  );
}

function compareRootOptions(optionA: Option, optionB: Option): number {
  if (optionA.long === ROOT_HELP_OPTION) {
    return optionB.long === ROOT_HELP_OPTION ? 0 : -1;
  }
  if (optionB.long === ROOT_HELP_OPTION) {
    return 1;
  }

  const keyA = optionA.long ?? optionA.flags;
  const keyB = optionB.long ?? optionB.flags;
  return keyA.localeCompare(keyB);
}

function getRootOptionEntries(rootCommand: SonarCommand, helper: Help): HelpMenuEntry[] {
  return helper
    .visibleOptions(rootCommand)
    .slice()
    .sort(compareRootOptions)
    .map((option) => ({
      label: option.flags,
      summary: ROOT_OPTION_SUMMARIES.get(option.long ?? '') ?? option.description,
    }));
}

export function getCustomRootHelp(rootCommand: SonarCommand, helper: Help): string {
  const commandLines = renderGroupedAlignedEntries(getRootCommandEntries(rootCommand, helper));
  const optionLines = renderAlignedEntries(getRootOptionEntries(rootCommand, helper));

  return [
    getBanner(VERSION),
    '',
    '  SonarQube CLI helps you detect security vulnerabilities',
    '  and code quality issues directly from your terminal.',
    '',
    `  ${underline('QUICKSTART')}`,
    `    1. Run ${softBlue(QUICKSTART_STEP_AUTH)} to authenticate with SonarQube`,
    `    2. Run ${softBlue(QUICKSTART_STEP_ANALYZE)} to scan your code for issues`,
    '',
    `  ${underline('COMMANDS')}`,
    ...commandLines,
    '',
    `  ${underline('OPTIONS')}`,
    ...optionLines,
    '',
    `  Read documentation: ${underline(softBlue(ROOT_DOCUMENTATION_URL))}`,
    `  Share feedback:     ${underline(softBlue(ROOT_FEEDBACK_URL))}`,
    '',
  ].join('\n');
}
