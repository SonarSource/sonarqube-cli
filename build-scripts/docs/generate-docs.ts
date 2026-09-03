#!/usr/bin/env bun

/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

/**
 * Generate SonarQube CLI data files from the command tree.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Option } from 'commander';

import { createCommandTree } from '@/commands/command-tree.ts';
import {
  type LifecycleState,
  type SonarCommand,
  SonarOption,
} from '@/core/commands/sonar-command.ts';
import { stageHelpTag, type StageName } from '@/core/commands/stage.ts';

import { version } from '../../package.json';
import { EXAMPLES } from './examples';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(ROOT, 'docs/data');
const CLIDOC_ROOT = join(ROOT, 'docs');

function optionType(
  opt: Option,
): 'undefined' | 'object' | 'boolean' | 'number' | 'string' | 'function' | 'symbol' | 'bigint' {
  const type = typeof opt.defaultValue;
  if (type !== 'undefined') {
    return type;
  }
  return opt.required || opt.optional ? 'string' : 'boolean';
}

interface ClidocArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
}

interface ClidocDeprecation {
  sinceVersion: string;
  replacement: string | null;
}

type PublicStage = Exclude<StageName, 'alpha'>;

interface ClidocOption {
  flags: string;
  long: string;
  short: string | undefined;
  description: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  allowedValues?: string[];
  stage?: PublicStage;
  deprecation?: ClidocDeprecation;
}

/** Alpha is omitted from public docs, so it is serialized as stable. */
function publicStage(lifecycle: LifecycleState): PublicStage {
  return lifecycle.stage === 'alpha' ? 'stable' : lifecycle.stage;
}

function lifecycleHelpTag(stage: PublicStage): string {
  const tag = stageHelpTag(stage);
  return tag === '' ? '' : ` ${tag}`;
}

function clidocDeprecation(lifecycle: LifecycleState): ClidocDeprecation | undefined {
  if (lifecycle.stage !== 'deprecated') {
    return undefined;
  }
  return {
    sinceVersion: lifecycle.sinceVersion,
    replacement: lifecycle.replacement,
  };
}

function formatClidocDeprecation(subject: string, deprecation: ClidocDeprecation): string {
  const base = `${subject} is deprecated since ${deprecation.sinceVersion} and will be removed in a future version`;
  return deprecation.replacement === null
    ? `${base}. There is no replacement.`
    : `${base}. Use '${deprecation.replacement}' instead.`;
}

interface ClidocCommand {
  id: string;
  name: string;
  fullName: string;
  aliases: string[];
  description: string;
  isGroup: boolean;
  isRoot: boolean;
  stage: PublicStage;
  deprecation?: ClidocDeprecation;
  requiresAuth: boolean;
  depth: number;
  parentId: string | null;
  arguments: ClidocArgument[];
  options: ClidocOption[];
  examples: { command: string; description: string }[];
  children: string[];
}

// Docs use the default runtime (Private Beta omitted; Open Beta and Deprecated included).
const COMMAND_TREE = await createCommandTree();
const allCommands: ClidocCommand[] = [];
const help = COMMAND_TREE.createHelp();

function visibleDocumentedCommands(cmd: SonarCommand): SonarCommand[] {
  return (help.visibleCommands(cmd) as SonarCommand[]).filter(
    (child) =>
      child.name() !== 'help' &&
      child.lifecycle.stage !== 'alpha' &&
      (child.lifecycle.stage !== 'beta' || child.lifecycle.betaFlagKey === undefined),
  );
}

function descriptionWithoutLifecycleTag(cmd: SonarCommand): string {
  const description = cmd.description() ?? '';
  const suffix = lifecycleHelpTag(publicStage(cmd.lifecycle));
  return suffix && description.endsWith(suffix)
    ? description.slice(0, -suffix.length)
    : description;
}

function serializeOptions(cmd: SonarCommand): ClidocOption[] {
  return cmd.options
    .filter((option): option is SonarOption => {
      if (!(option instanceof SonarOption) || option.hidden || option.long === '--help') {
        return false;
      }
      const { lifecycle } = option;
      if (lifecycle.stage === 'alpha') {
        return false;
      }
      // Alpha/Private Beta options are already detached from the default docs runtime;
      // skip them explicitly so generating with SONARQUBE_CLI_ALPHA set cannot leak them.
      return lifecycle.stage !== 'beta' || lifecycle.betaFlagKey === undefined;
    })
    .map((option) => {
      const serialized: ClidocOption = {
        flags: option.flags,
        long: option.long ?? '',
        short: option.short,
        description: option.description ?? '',
        type: optionType(option),
        required: option.mandatory,
        defaultValue: option.defaultValue,
        allowedValues: option.argChoices?.length ? option.argChoices : undefined,
      };
      const stage = publicStage(option.lifecycle);
      if (stage !== 'stable') {
        serialized.stage = stage;
      }
      const deprecation = clidocDeprecation(option.lifecycle);
      if (deprecation) {
        serialized.deprecation = deprecation;
      }
      return serialized;
    });
}

function serializeCommand(
  cmd: SonarCommand,
  prefix: string,
  depth: number,
  parentId: string | null,
) {
  const fullName = `${prefix} ${cmd.name()}`.trim();
  const id = fullName.replaceAll(/\s+/g, '-');
  const visibleChildren = visibleDocumentedCommands(cmd);

  const deprecation = clidocDeprecation(cmd.lifecycle);
  const entry: ClidocCommand = {
    id,
    name: cmd.name(),
    fullName,
    aliases: cmd.aliases(),
    description: descriptionWithoutLifecycleTag(cmd),
    isGroup: visibleChildren.length > 0,
    isRoot: depth === 0,
    stage: publicStage(cmd.lifecycle),
    ...(deprecation === undefined ? {} : { deprecation }),
    requiresAuth: cmd.requiresAuth,
    depth,
    parentId,
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      description: a.description ?? '',
      required: a.required,
      variadic: a.variadic,
    })),
    options: serializeOptions(cmd),
    examples: EXAMPLES[fullName] ?? [],
    children: visibleChildren.map((c) => `${id}-${c.name()}`),
  };

  allCommands.push(entry);

  for (const child of visibleChildren) {
    serializeCommand(child, fullName, depth + 1, id);
  }
}

// Root entry
const rootId = 'sonar';
const visibleTopLevel = visibleDocumentedCommands(COMMAND_TREE);

const rootEntry: ClidocCommand = {
  id: rootId,
  name: 'sonar',
  fullName: 'sonar',
  aliases: [],
  description: COMMAND_TREE.description() ?? 'SonarQube CLI',
  isGroup: true,
  isRoot: true,
  stage: 'stable',
  requiresAuth: false,
  depth: 0,
  parentId: null,
  arguments: [],
  options: [],
  examples: [],
  children: visibleTopLevel.map((c) => `sonar-${c.name()}`),
};

allCommands.push(rootEntry);

for (const cmd of visibleTopLevel) {
  serializeCommand(cmd, 'sonar', 1, rootId);
}

const data = {
  version,
  commands: allCommands,
};

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'commands.json'), JSON.stringify(data, null, 2));

// ── llms.txt ─────────────────────────────────────────────────
function aliasSuffix(cmd: ClidocCommand): string {
  return cmd.aliases.length > 0 ? `|${cmd.aliases.join('|')}` : '';
}

function optionUsageToken(option: ClidocOption): string {
  const flag = option.short ? option.short : option.long;
  return option.type === 'boolean' ? `[${option.long}]` : `[${flag} <value>]`;
}

function optionLlmsLine(option: ClidocOption): string {
  const flagPart = option.short ? `${option.long}, ${option.short}` : option.long;
  const typePart = option.type === 'boolean' ? '' : `  <${option.type}>`;
  const lifecycleTag = lifecycleHelpTag(option.stage ?? 'stable');
  const deprecationNote = option.deprecation
    ? ` ${formatClidocDeprecation('This option', option.deprecation)}`
    : '';
  return `  ${flagPart}${typePart}   ${option.description}${lifecycleTag}${deprecationNote}`;
}

function appendLlmsUsage(commandLines: string[], cmd: ClidocCommand): void {
  const args = cmd.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
  const optsSummary = cmd.options.map(optionUsageToken).join(' ');
  const usageParts = [cmd.fullName, optsSummary, args].filter(Boolean).join(' ');
  commandLines.push(`Usage: ${usageParts}`);
}

function appendLlmsOptions(commandLines: string[], cmd: ClidocCommand): void {
  if (cmd.options.length === 0) {
    return;
  }
  commandLines.push('', 'Options:', ...cmd.options.map(optionLlmsLine));
}

function appendLlmsExamples(commandLines: string[], cmd: ClidocCommand): void {
  if (cmd.examples.length === 0) {
    return;
  }
  commandLines.push('', 'Examples:', ...cmd.examples.map((ex) => `  ${ex.command}`));
}

function appendLlmsCommand(commandLines: string[], cmd: ClidocCommand): void {
  const authMarker = cmd.requiresAuth ? ' *' : '';
  commandLines.push(`### ${cmd.fullName}${aliasSuffix(cmd)}${authMarker}`);
  if (cmd.description) {
    commandLines.push(`${cmd.description}${lifecycleHelpTag(cmd.stage)}`);
  }
  if (cmd.deprecation) {
    commandLines.push(formatClidocDeprecation('This command', cmd.deprecation));
  }
  if (!cmd.isGroup) {
    appendLlmsUsage(commandLines, cmd);
    appendLlmsOptions(commandLines, cmd);
  }
  appendLlmsExamples(commandLines, cmd);
  commandLines.push('');
}

function buildLlmsTxt(): string {
  const template = readFileSync(join(__dirname, 'llms.txt.template'), 'utf-8');
  const commandLines: string[] = [];

  for (const cmd of allCommands) {
    if (cmd.isRoot) {
      continue;
    }
    appendLlmsCommand(commandLines, cmd);
  }

  return template.replace('{{VERSION}}', version).replace('{{COMMANDS}}', commandLines.join('\n'));
}

// ── sitemap.xml ───────────────────────────────────────────────
function buildSitemapXml(): string {
  const template = readFileSync(join(__dirname, 'sitemap.xml.template'), 'utf-8');
  const lastmod = new Date().toISOString().split('T')[0];
  return template.replaceAll('{{LASTMOD}}', lastmod);
}

writeFileSync(join(CLIDOC_ROOT, 'llms.txt'), buildLlmsTxt());
writeFileSync(join(CLIDOC_ROOT, 'sitemap.xml'), buildSitemapXml());

function stampNavVersionBadge(html: string): string {
  return html.replace(/(<span[^>]*id="nav-version"[^>]*>)v[^<]*(<\/span>)/, `$1v${version}$2`);
}

// ── Version metadata in docs HTML ─────────────────────────────
const indexHtmlPath = join(CLIDOC_ROOT, 'index.html');
const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
const updatedIndexHtml = indexHtml.replace(
  /("license":\s*"[^"]*")(\s*})/,
  `$1,\n    "softwareVersion": "${version}"$2`,
);
const alreadyPatched = indexHtml.includes('"softwareVersion"');
const finalIndexHtmlWithVersion = alreadyPatched
  ? indexHtml.replace(/"softwareVersion":\s*"[^"]*"/, `"softwareVersion": "${version}"`)
  : updatedIndexHtml;
const finalIndexHtml = stampNavVersionBadge(finalIndexHtmlWithVersion).replace(
  /(<meta name="version" id="meta-version" content=")[^"]*(")/,
  `$1${version}$2`,
);
writeFileSync(indexHtmlPath, finalIndexHtml);

const commandsHtmlPath = join(CLIDOC_ROOT, 'commands.html');
const commandsHtml = readFileSync(commandsHtmlPath, 'utf-8');
writeFileSync(commandsHtmlPath, stampNavVersionBadge(commandsHtml));
