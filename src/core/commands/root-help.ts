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

import { cyan, gray, purple, softBlue, underline } from '@/core/ui/colors.ts';

import { version as VERSION } from '../../../package.json';
import { COMMAND_CATEGORIES, type SonarCommand } from './sonar-command.ts';

const BANNER_ART = [
  '  █▀ █▀█ █▄ █ ▄▀█ █▀█ █▀█ █ █ █▄▄ █▀▀   ▄█▀ █   █',
  '  ▄█ █▄█ █ ▀█ █▀█ █▀▄ ▀▀█ █▄█ █▄█ ██▄   ▀█▄ ██▄ █',
] as const;
const MIN_WIDTH = 60;
const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 80;
const INLINE_LABEL_LIMIT = 28;
const ROW_INDENT = 4;
const TARGET_INDENT = 6;
const COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 24;
const ROOT_DOCUMENTATION_URL = 'https://sonarsource.com/sonarqube/cli';
const ROOT_FEEDBACK_URL = 'https://forms.gle/jrGic3awT5t5vf7V9';

interface HelpMenuEntry {
  label: string;
  summary: string;
  targets?: string[];
}

export function getBanner(version: string): string {
  const versionLabel = softBlue(`v${version}`);
  return [...BANNER_ART, `  ${versionLabel}`].join('\n');
}

function terminalWidth(): number {
  const columns = Number((process.env.COLUMNS ?? process.stdout.columns) || DEFAULT_WIDTH);
  return Number.isFinite(columns) && columns > 0
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns)))
    : DEFAULT_WIDTH;
}

function wrap(text: string, width: number): string[] {
  // Bracketed badges stay atomic, including multi-word availability badges.
  const words = text.match(/\[Cloud only\]|\S+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && Bun.stringWidth(line) + 1 + Bun.stringWidth(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line += `${line ? ' ' : ''}${word}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function colorBadges(text: string): string {
  return text.replace(/\[(BETA|ALPHA|DEPRECATED|Cloud only|Vortex)\]/g, (badge, kind: string) =>
    ['Cloud only', 'Vortex'].includes(kind) ? cyan(badge) : purple(badge),
  );
}

function renderTargets(targets: string[], width: number): string[] {
  const text = targets.join(', ');
  let targetWidth = width - TARGET_INDENT;
  let lines = wrap(text, targetWidth);
  // Rebalance a final singleton by moving a preceding name onto its last line.
  while (lines.length > 1 && !lines.at(-1)?.includes(',') && targetWidth > 1) {
    targetWidth--;
    lines = wrap(text, targetWidth);
  }
  return lines.map((line) => `      ${gray(line)}`);
}

function renderEntry(entry: HelpMenuEntry, labelWidth: number, width: number): string[] {
  const descriptionColumn = ROW_INDENT + labelWidth + COLUMN_GAP;
  const descriptionWidth = Math.max(MIN_DESCRIPTION_WIDTH, width - descriptionColumn);
  const lines = wrap(entry.summary, descriptionWidth);
  return [
    `    ${softBlue(entry.label.padEnd(labelWidth))}  ${colorBadges(lines[0] ?? '')}`,
    ...lines.slice(1).map((line) => `${' '.repeat(descriptionColumn)}${colorBadges(line)}`),
    ...(entry.targets ? renderTargets(entry.targets, width) : []),
  ];
}

function getVisibleChildCommands(command: SonarCommand, helper: Help): SonarCommand[] {
  return (helper.visibleCommands(command) as SonarCommand[]).filter(
    (child) => child.name() !== 'help' && !child.rootHelpMetadata.hidden,
  );
}

function getCommandNameWithAlias(command: SonarCommand): string {
  const alias = command.alias();
  return alias ? `${command.name()}|${alias}` : command.name();
}

function getLabel(
  command: SonarCommand,
  helper: Help,
  prefix = '',
): Pick<HelpMenuEntry, 'label' | 'targets'> {
  const metadata = command.rootHelpMetadata;
  const name = `${prefix}${getCommandNameWithAlias(command)}`;
  const children = getVisibleChildCommands(command, helper);
  if (metadata.label) {
    return {
      label: metadata.label.replace(/^\S+/, name),
      targets: metadata.targets ? children.map((child) => child.name()) : undefined,
    };
  }
  if (metadata.expandSubcommands) return { label: name };
  if (children.length === 1) return getLabel(children[0], helper, `${name} `);
  if (children.length > 1) {
    const names = children.map((child) => child.name());
    const inline = `${name} (${names.join('|')})`;
    return inline.length <= INLINE_LABEL_LIMIT
      ? { label: inline }
      : { label: `${name} <command>`, targets: names };
  }
  const args = command.registeredArguments
    .filter((argument) => argument.required)
    .map((argument) => {
      const name = argument.name().replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
      return `<${name}${argument.variadic ? '...' : ''}>`;
    });
  return { label: [name, ...args].join(' ') };
}

function getSummary(command: SonarCommand): string {
  const stage = command.lifecycle.stage;
  const metadata = command.rootHelpMetadata;
  const description =
    metadata.summary ?? command.description().replace(/ \[(?:BETA|ALPHA|DEPRECATED)\]$/, '');
  const lifecycle = stage === 'stable' ? '' : `[${stage.toUpperCase()}] `;
  const availability = [
    metadata.cloudOnly ? ' [Cloud only]' : '',
    metadata.requiresVortex ? ' [Vortex]' : '',
  ].join('');
  return `${lifecycle}${description}${availability}`;
}

function getCommandEntries(command: SonarCommand, helper: Help): HelpMenuEntry[] {
  return [
    { ...getLabel(command, helper), summary: getSummary(command) },
    ...(command.rootHelpMetadata.expandSubcommands
      ? getVisibleChildCommands(command, helper).map((child) => ({
          ...getLabel(child, helper, `${getCommandNameWithAlias(command)} `),
          summary: getSummary(child),
        }))
      : []),
  ];
}

function compareRootOptions(a: Option, b: Option): number {
  if (a.long === '--help') return b.long === '--help' ? 0 : -1;
  if (b.long === '--help') return 1;
  return (a.long ?? a.flags).localeCompare(b.long ?? b.flags);
}

const ROOT_OPTION_SUMMARIES = new Map([
  ['--help', 'Display help'],
  ['--version', 'Show current version'],
]);

function getRootOptionEntries(root: SonarCommand, helper: Help): HelpMenuEntry[] {
  return helper
    .visibleOptions(root)
    .slice()
    .sort(compareRootOptions)
    .map((option) => ({
      label: option.flags,
      summary: ROOT_OPTION_SUMMARIES.get(option.long ?? '') ?? helper.optionDescription(option),
    }));
}

export function getCustomRootHelp(rootCommand: SonarCommand, helper: Help): string {
  const width = terminalWidth();
  const commands = getVisibleChildCommands(rootCommand, helper);
  const sections = COMMAND_CATEGORIES.map((section) => ({
    title: section.toUpperCase(),
    entries: commands
      .filter(
        (command) =>
          command.lifecycle.stage !== 'alpha' &&
          (command.rootHelpMetadata.category ?? 'cli') === section,
      )
      .sort(
        (a, b) =>
          (a.rootHelpMetadata.order ?? Number.MAX_SAFE_INTEGER) -
          (b.rootHelpMetadata.order ?? Number.MAX_SAFE_INTEGER),
      )
      .flatMap((command) => getCommandEntries(command, helper)),
  }));
  sections.push({
    title: 'ALPHA',
    entries: commands
      .filter((command) => command.lifecycle.stage === 'alpha')
      .flatMap((command) => getCommandEntries(command, helper)),
  });
  const options = getRootOptionEntries(rootCommand, helper);
  const labelWidth = Math.max(
    0,
    ...[...sections.flatMap((section) => section.entries), ...options].map((entry) =>
      Bun.stringWidth(entry.label),
    ),
  );
  const prose = (text: string) => wrap(text, width - COLUMN_GAP).map((line) => `  ${line}`);
  const quickstart = (text: string) =>
    wrap(text, width - ROW_INDENT).map(
      (line) =>
        `    ${line.replace(/sonar auth login|sonar integrate/g, (command) => softBlue(command))}`,
    );
  return [
    getBanner(VERSION),
    '',
    ...prose('SonarQube CLI helps you detect security vulnerabilities'),
    ...prose('and code quality issues directly from your terminal.'),
    '',
    `  ${underline('QUICKSTART')}`,
    ...quickstart('1. Run sonar auth login to authenticate with SonarQube'),
    ...quickstart('2. Run sonar integrate to connect SonarQube to your AI agent or Git'),
    '',
    ...sections
      .filter((section) => section.entries.length > 0)
      .flatMap((section) => [
        `  ${underline(section.title)}`,
        ...section.entries.flatMap((entry) => renderEntry(entry, labelWidth, width)),
        '',
      ]),
    `  ${underline('OPTIONS')}`,
    ...options.flatMap((entry) => renderEntry(entry, labelWidth, width)),
    '',
    ...prose('Run sonar <command> --help for options and examples.'),
    '',
    `  Docs      ${softBlue(ROOT_DOCUMENTATION_URL)}`,
    `  Feedback  ${softBlue(ROOT_FEEDBACK_URL)}`,
    '',
  ].join('\n');
}
