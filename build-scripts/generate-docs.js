#!/usr/bin/env node

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
 * Generate README.md from spec.yaml
 *
 * Usage:
 *   node build-scripts/generate-docs.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const spec = yaml.load(readFileSync(join(ROOT, 'spec.yaml'), 'utf8'));

// Wide characters used in option tables (display as 2 columns in monospace fonts)
const WIDE_CHARS = new Set(['Yes', 'No']);

/**
 * Visual display width of a string in monospace fonts.
 * Characters in WIDE_CHARS count as 2 columns, all others as 1.
 */
function displayWidth(str) {
  let width = 0;
  for (const char of str) {
    width += WIDE_CHARS.has(char) ? 2 : 1;
  }
  return width;
}

function padEnd(str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}

function renderOptionsTable(options) {
  if (options && options.length > 0) {
    const headers = ['Option', 'Type', 'Required', 'Description', 'Default'];
    const cells = options.map(opt => {
      const flag = opt.alias ? `\`--${opt.name}\`, \`-${opt.alias}\`` : `\`--${opt.name}\``;
      const required = opt.required ? '✅' : '❌';
      const def = 'default' in opt ? `\`${opt.default}\`` : '-';
      return [flag, opt.type, required, opt.description, def];
    });

    const colWidths = headers.map((h, i) =>
      Math.max(displayWidth(h), ...cells.map(r => displayWidth(r[i])))
    );

    const headerRow = '| ' + headers.map((h, i) => padEnd(h, colWidths[i])).join(' | ') + ' |';
    const separator = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    const rows = cells.map(row =>
      '| ' + row.map((cell, i) => padEnd(cell, colWidths[i])).join(' | ') + ' |'
    );

    return [
      '**Options:**\n',
      headerRow,
      separator,
      ...rows,
      ''
    ].join('\n');
  }
  return '';
}

function renderExamples(examples) {
  if (examples && examples.length > 0) {
    const lines = ['**Examples:**\n'];
    for (const ex of examples) {
      lines.push('```bash', ex.command, '```', ex.description, '');
    }
    return lines.join('\n');
  }
  return '';
}

function renderCommand(name, cmd, depth = 3) {
  const heading = '#'.repeat(depth);
  const lines = [`${heading} \`${name}\``, '', cmd.description, ''];
  const options = renderOptionsTable(cmd.options);
  if (options) lines.push(options);
  const examples = renderExamples(cmd.examples);
  if (examples) lines.push(examples);
  if (cmd.subcommands) {
    for (const sub of cmd.subcommands) {
      lines.push(renderCommand(`${name} ${sub.name}`, sub, depth + 1));
    }
  } else {
    lines.push('---', '');
  }
  return lines.join('\n');
}

const sections = [
  `# ${spec.cli.name}`,
  '',
  spec.cli.description,
  '',
  '## Installation',
  '',
  '```bash',
  'brew install local/sonar/sonar',
  '```',
  '',
  '## Commands',
  '',
  ...spec.commands.map(cmd => renderCommand(`${spec.cli.name} ${cmd.name}`, cmd)),
  '## Option Types',
  '',
  '- `string` — text value (e.g. `--server https://sonarcloud.io`)',
  '- `boolean` — flag (e.g. `--verbose`)',
  '- `number` — numeric value (e.g. `--page-size 100`)',
  '- `array` — multiple values (e.g. `--tags tag1 tag2`)',
  '',
  '## Exit Codes',
  '',
  '| Code | Meaning                           |',
  '|------|-----------------------------------|',
  '| 0    | Success                           |',
  '| 1    | Error (validation, execution, etc.) |',
  '',
  '---',
  '',
  '## License',
  '',
  'Copyright 2026 SonarSource Sàrl.',
  '',
  'SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).',
  '',
  `*Generated from \`spec.yaml\` — do not edit manually*`,
  ''
];

writeFileSync(join(ROOT, 'README.md'), sections.join('\n'));
console.log('✅ README.md generated from spec.yaml');
