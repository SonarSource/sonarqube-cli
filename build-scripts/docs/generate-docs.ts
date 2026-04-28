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
 * Generate cli.sonarqube.com data files from the command tree.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Option } from 'commander';

import { version } from '../../package.json';
import { COMMAND_TREE } from '../../src/cli/command-tree';
import type { SonarCommand } from '../../src/cli/commands/_common/sonar-command';
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

interface ClidocOption {
  flags: string;
  long: string;
  short: string | undefined;
  description: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  allowedValues?: string[];
}

interface ClidocCommand {
  id: string;
  name: string;
  fullName: string;
  description: string;
  isGroup: boolean;
  isRoot: boolean;
  requiresAuth: boolean;
  depth: number;
  parentId: string | null;
  arguments: ClidocArgument[];
  options: ClidocOption[];
  examples: { command: string; description: string }[];
  children: string[];
}

const allCommands: ClidocCommand[] = [];
const help = COMMAND_TREE.createHelp();

function serializeCommand(
  cmd: SonarCommand,
  prefix: string,
  depth: number,
  parentId: string | null,
) {
  const fullName = `${prefix} ${cmd.name()}`.trim();
  const id = fullName.replaceAll(/\s+/g, '-');
  // we don't want to display implicit child help menus
  const visibleChildren = help.visibleCommands(cmd).filter((c) => c.name() !== 'help');

  const entry: ClidocCommand = {
    id,
    name: cmd.name(),
    fullName,
    description: cmd.description() ?? '',
    isGroup: visibleChildren.length > 0,
    isRoot: depth === 0,
    requiresAuth: cmd.requiresAuth,
    depth,
    parentId,
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      description: a.description ?? '',
      required: a.required,
      variadic: a.variadic,
    })),
    options: cmd.options
      .filter((o) => !o.hidden && o.long !== '--help')
      .map((o) => ({
        flags: o.flags,
        long: o.long ?? '',
        short: o.short,
        description: o.description ?? '',
        type: optionType(o),
        required: o.mandatory,
        defaultValue: o.defaultValue,
        allowedValues: o.argChoices?.length ? o.argChoices : undefined,
      })),
    examples: EXAMPLES[fullName] ?? [],
    children: visibleChildren.map((c) => `${id}-${c.name()}`),
  };

  allCommands.push(entry);

  for (const child of visibleChildren) {
    serializeCommand(child as SonarCommand, fullName, depth + 1, id);
  }
}

// Root entry
const rootId = 'sonar';
const visibleTopLevel = help.visibleCommands(COMMAND_TREE);

const rootEntry: ClidocCommand = {
  id: rootId,
  name: 'sonar',
  fullName: 'sonar',
  description: COMMAND_TREE.description() ?? 'SonarQube CLI',
  isGroup: true,
  isRoot: true,
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
  serializeCommand(cmd as SonarCommand, 'sonar', 1, rootId);
}

const data = {
  version,
  commands: allCommands,
};

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'commands.json'), JSON.stringify(data, null, 2));

// ── llms.txt ─────────────────────────────────────────────────
function buildLlmsTxt(): string {
  const template = readFileSync(join(__dirname, 'llms.txt.template'), 'utf-8');
  const commandLines: string[] = [];

  // Emit every non-root command
  for (const cmd of allCommands) {
    if (cmd.isRoot) continue;

    const authMarker = cmd.requiresAuth ? ' *' : '';
    commandLines.push(`### ${cmd.fullName}${authMarker}`);
    if (cmd.description) commandLines.push(cmd.description);

    if (!cmd.isGroup) {
      // Usage line
      const args = cmd.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
      const optsSummary = cmd.options
        .map((o) => {
          const flag = o.short ? `${o.short}` : o.long;
          return o.type === 'boolean' ? `[${o.long}]` : `[${flag} <value>]`;
        })
        .join(' ');
      const usageParts = [cmd.fullName, optsSummary, args].filter(Boolean).join(' ');
      commandLines.push(`Usage: ${usageParts}`);

      if (cmd.options.length > 0) {
        commandLines.push('');
        commandLines.push('Options:');
        for (const opt of cmd.options) {
          const flagPart = opt.short ? `${opt.long}, ${opt.short}` : opt.long;
          const typePart = opt.type === 'boolean' ? '' : `  <${opt.type}>`;
          commandLines.push(`  ${flagPart}${typePart}   ${opt.description}`);
        }
      }
    }

    if (cmd.examples.length > 0) {
      commandLines.push('');
      commandLines.push('Examples:');
      for (const ex of cmd.examples) {
        commandLines.push(`  ${ex.command}`);
      }
    }

    commandLines.push('');
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

// ── JSON-LD softwareVersion in index.html ─────────────────────
const indexHtmlPath = join(CLIDOC_ROOT, 'index.html');
const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
const updatedIndexHtml = indexHtml.replace(
  /("license":\s*"[^"]*")(\s*})/,
  `$1,\n    "softwareVersion": "${version}"$2`,
);
const alreadyPatched = indexHtml.includes('"softwareVersion"');
const finalIndexHtml = alreadyPatched
  ? indexHtml.replace(/"softwareVersion":\s*"[^"]*"/, `"softwareVersion": "${version}"`)
  : updatedIndexHtml;
writeFileSync(indexHtmlPath, finalIndexHtml);
