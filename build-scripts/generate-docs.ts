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
 * Generate README.md from the command tree.
 *
 * Usage:
 *   bun run build-scripts/generate-docs.ts
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Option } from 'commander';
import { COMMAND_TREE } from '../src/cli/command-tree.ts';
import { EXAMPLES } from './examples.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Wide characters used in option tables (display as 2 columns in monospace fonts)
const WIDE_CHARS = new Set(['Yes', 'No']);

/**
 * Visual display width of a string in monospace fonts.
 * Characters in WIDE_CHARS count as 2 columns, all others as 1.
 */
function displayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    width += WIDE_CHARS.has(char) ? 2 : 1;
  }
  return width;
}

function padEnd(str: string, width: number): string {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}

function optionType(
  opt: Option,
): 'undefined' | 'object' | 'boolean' | 'number' | 'string' | 'function' | 'symbol' | 'bigint' {
  const type = typeof opt.defaultValue;
  if (type !== 'undefined') {
    return type;
  }
  return opt.required || opt.optional ? 'string' : 'boolean';
}

function renderOptionsTable(options: readonly Option[]): string {
  const visible = options.filter((o) => !o.hidden && o.long !== '--help');
  if (visible.length === 0) return '';

  const headers = ['Option', 'Type', 'Required', 'Description', 'Default'];
  const cells = visible.map((opt) => {
    const flag = opt.short ? `\`${opt.long}\`, \`${opt.short}\`` : `\`${opt.long}\``;
    const type = optionType(opt);
    const required = opt.mandatory ? 'Yes' : 'No';
    const def = opt.defaultValue !== undefined ? `\`${opt.defaultValue}\`` : '-';
    return [flag, type, required, opt.description ?? '', def];
  });

  const colWidths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...cells.map((r) => displayWidth(r[i]))),
  );

  const headerRow = '| ' + headers.map((h, i) => padEnd(h, colWidths[i])).join(' | ') + ' |';
  const separator = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  const rows = cells.map(
    (row) => '| ' + row.map((cell, i) => padEnd(cell, colWidths[i])).join(' | ') + ' |',
  );

  return ['**Options:**\n', headerRow, separator, ...rows, ''].join('\n');
}

function renderExamples(name: string): string {
  const examples = EXAMPLES[name];
  if (!examples || examples.length === 0) return '';
  const lines = ['**Examples:**\n'];
  for (const ex of examples) {
    lines.push('```bash', ex.command, '```', ex.description, '');
  }
  return lines.join('\n');
}

function renderCommand(cmd: Command, prefix: string, depth: number): string {
  const name = `${prefix} ${cmd.name()}`.trim();
  const heading = '#'.repeat(depth);
  const lines: string[] = [`${heading} \`${name}\``, '', cmd.description(), ''];

  const optTable = renderOptionsTable(cmd.options);
  if (optTable) lines.push(optTable);

  const examples = renderExamples(name);
  if (examples) lines.push(examples);

  const subcommands = cmd.commands.filter((c) => !c.hidden);
  if (subcommands.length > 0) {
    for (const sub of subcommands) {
      lines.push(renderCommand(sub, name, depth + 1));
    }
  } else {
    lines.push('---', '');
  }

  return lines.join('\n');
}

const visibleCommands = COMMAND_TREE.commands.filter((cmd) => !cmd.hidden);
const authCmd = visibleCommands.find((cmd) => cmd.name() === 'auth');
const otherCmds = visibleCommands.filter((cmd) => cmd.name() !== 'auth');
const orderedCommands = authCmd ? [authCmd, ...otherCmds] : otherCmds;

const renderedCommands = orderedCommands.map((cmd) => renderCommand(cmd, 'sonar', 3)).join('\n');

const template = readFileSync(join(ROOT, 'build-scripts/README.template.md'), 'utf8');
const output = template.replace('<!-- COMMANDS -->', renderedCommands.trimEnd());

writeFileSync(join(ROOT, 'README.md'), output);
console.log('✅ README.md generated from command-tree.ts');
