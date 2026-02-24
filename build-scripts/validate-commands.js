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
 * Validate that implemented commands match spec.yaml
 *
 * Checks:
 * 1. All commands from spec are registered in src/index.ts
 * 2. All commands in src/index.ts are declared in spec
 * 3. All options match between spec and implementation
 * 4. All handler files exist
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Regex match group indices
const SHORT_FLAG_INDEX = 1;
const LONG_FLAG_INDEX = 2;

// How many characters to look back when searching for a variable name before .command(
const LOOKBACK_WINDOW = 40;

// Load spec
const specPath = join(rootDir, 'spec.yaml');
const specContent = readFileSync(specPath, 'utf8');
const spec = yaml.load(specContent);

// Load index.ts
const indexPath = join(rootDir, 'src/index.ts');
const indexContent = readFileSync(indexPath, 'utf8');

let errors = [];
let warnings = [];

/**
 * Command definition from spec
 * @typedef {Object} CommandDef
 * @property {string} name
 * @property {string} [handler]
 * @property {Array} [options]
 * @property {string} [description]
 * @property {Array<CommandDef>} [subcommands]
 */

/**
 * Extract commands from spec.yaml
 * @param {Array<CommandDef>} commands - Commands from spec
 * @param {string} [parentName] - Parent command name
 * @returns {Array} Flattened list of commands
 */
function getSpecCommands(commands, parentName = '') {
  const result = [];

  for (const cmd of commands) {
    const fullName = parentName ? `${parentName} ${cmd.name}` : cmd.name;

    // Add all commands (even group commands without handlers)
    result.push({
      name: fullName,
      handler: cmd.handler,
      options: cmd.options || [],
      description: cmd.description,
      isGroup: !!cmd.subcommands && !cmd.handler
    });

    if (cmd.subcommands && Array.isArray(cmd.subcommands)) {
      result.push(...getSpecCommands(cmd.subcommands, fullName));
    }
  }

  return result;
}

/**
 * Remove pattern from string using loop and replaceAll
 * @param {string} str - Input string
 * @param {string} open - Opening character
 * @param {string} close - Closing character
 * @returns {string} String with pattern removed
 */
function removePattern(str, open, close) {
  let result = str;
  while (result.includes(open)) {
    const start = result.indexOf(open);
    const end = result.indexOf(close, start);
    if (end > start) {
      result = result.slice(0, start) + result.slice(end + 1);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Strip positional arguments from command name
 * @param {string} name - Command name to strip
 * @returns {string} Command name without positional arguments
 */
function stripPositionalArgs(name) {
  // Remove <arg> and [arg] patterns
  let result = removePattern(name, '<', '>');
  result = removePattern(result, '[', ']');

  // Normalize multiple spaces and trim
  return result.replaceAll('  ', ' ').trim();
}

/**
 * Build a map from variable name to full command path.
 *
 * Scans for patterns like: const installSecrets = install.command('secrets')
 * Then resolves the full path by following the chain:
 *   installSecrets → "install secrets"
 *   install → "install"
 *   program → "" (root)
 */
function buildVariablePaths(content) {
  const varPaths = new Map([['program', '']]);

  // Handles both single-line and multiline assignments, e.g.:
  //   const x = program.command('name')
  //   const x = program\n  .command('name')
  const pattern = /const\s+(\w+)\s*=\s*(\w+)\s*\.command\(['"]([^'"]+)['"]\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const [, varName, parentVar, cmdName] = match;
    const parentPath = varPaths.get(parentVar);
    if (parentPath !== undefined) {
      varPaths.set(varName, parentPath ? `${parentPath} ${cmdName}` : cmdName);
    }
  }

  return varPaths;
}

/**
 * Slice the file at every VAR.command( occurrence.
 * Each slice contains exactly one command definition.
 *
 * Example: for auth.command('login')...auth.command('logout')...
 *   slice 0: "auth.command('login').description(...).option(...).action(...)"
 *   slice 1: "auth.command('logout').description(...).action(...)"
 */
function sliceAtCommandBoundaries(content) {
  const slices = [];
  const positions = [];

  // Scan for .command( occurrences, then look backwards (bounded) for the variable name.
  // This avoids combining \w+ with \s* in a single regex (S5852).
  const cmdPattern = /\.command\(/g;
  let match;
  while ((match = cmdPattern.exec(content)) !== null) {
    const lookback = content.slice(Math.max(0, match.index - LOOKBACK_WINDOW), match.index);
    // Split on non-word chars and take the last non-empty token — avoids regex backtracking (S5852)
    const tokens = lookback.trimEnd().split(/\W+/);
    const varName = tokens[tokens.length - 1];
    if (varName) {
      const varStart = match.index - varName.length - (lookback.length - lookback.trimEnd().length);
      positions.push({ index: varStart, varName });
    }
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : content.length;
    slices.push({
      varName: positions[i].varName,
      text: content.slice(start, end),
    });
  }

  return slices;
}

/**
 * Extract command registrations from src/index.ts.
 * Handles arbitrary nesting depth (2-level, 3-level, etc.).
 *
 * Strategy:
 * 1. Build a map: variable name → full command path
 * 2. Slice the file at every .command( boundary
 * 3. Slices with .action() are leaf commands; slices without are groups — skip them
 */
function parseIndexCommands(content) {
  const commands = [];
  const varPaths = buildVariablePaths(content);

  for (const { varName, text } of sliceAtCommandBoundaries(content)) {
    const parentPath = varPaths.get(varName);
    if (parentPath === undefined) continue; // unknown variable, skip

    // Group commands have no .action() — only leaf commands do
    if (!text.includes('.action(')) continue;

    const nameMatch = /\.command\(['"]([^'"]+)['"]\)/.exec(text);
    const descMatch = /\.description\(['"]([^'"]+)['"]\)/.exec(text);
    if (!nameMatch || !descMatch) continue;

    const cleanName = stripPositionalArgs(nameMatch[1]);
    const fullName = parentPath ? `${parentPath} ${cleanName}` : cleanName;
    const options = parseOptions(text);

    commands.push({ name: fullName.trim(), description: descMatch[1], options });
  }

  return commands;
}

/**
 * Parse options from command registration block
 */
function parseOptions(optionsBlock) {
  const options = [];

  if (!optionsBlock) return options;

  // Match .option() and .requiredOption() - simplified with split approach
  const lines = optionsBlock.split('\n');

  for (const line of lines) {
    const isOption = line.includes('.option(') || line.includes('.requiredOption(');
    if (!isOption) continue;

    const isRequired = line.includes('requiredOption');

    // Extract quoted strings (flags, description, default)
    const quoted = /['"]([^'"]{0,100})['"]/g;
    const matches = [];
    let match;
    while ((match = quoted.exec(line)) !== null) {
      matches.push(match[1]);
    }

    if (matches.length === 0) continue;

    const [flags, description = '', defaultValue] = matches;

    // Parse flags: '-n, --name <name>' or '--verbose'
    const flagRegex = /(?:-(\w),?\s*)?--([a-z-]+)/;
    const flagMatch = flagRegex.exec(flags);
    if (flagMatch) {
      options.push({
        name: flagMatch[LONG_FLAG_INDEX],
        alias: flagMatch[SHORT_FLAG_INDEX],
        required: isRequired,
        description,
        default: defaultValue
      });
    }
  }

  return options;
}

/**
 * Convert kebab-case to camelCase
 */
function toCamelCase(str) {
  const chars = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '-' && i + 1 < str.length) {
      i++;
      chars.push(str[i].toUpperCase());
    } else {
      chars.push(str[i]);
    }
    i++;
  }
  return chars.join('');
}

/**
 * Normalize option name (convert kebab-case to camelCase for comparison)
 */
function normalizeOptionName(name) {
  return toCamelCase(name);
}

// Get commands from spec and index.ts
const specCommands = getSpecCommands(spec.commands);
const indexCommands = parseIndexCommands(indexContent);

console.log('🔍 Validating commands...\n');

// Check 1: All spec commands are registered in index.ts
console.log('1️⃣  Checking spec commands are registered...');
for (const specCmd of specCommands) {
  // Group commands are structural only — they don't need a registered action
  if (specCmd.isGroup) continue;

  const indexCmd = indexCommands.find(c => c.name === specCmd.name);

  if (!indexCmd) {
    errors.push(`Command "${specCmd.name}" is defined in spec but not registered in src/index.ts`);
    continue;
  }

  // Check options match
  for (const specOpt of specCmd.options) {
    const indexOpt = indexCmd.options.find(o =>
      o.name === specOpt.name ||
      normalizeOptionName(o.name) === normalizeOptionName(specOpt.name)
    );

    if (!indexOpt) {
      errors.push(`Command "${specCmd.name}": option "--${specOpt.name}" is in spec but not in index.ts`);
      continue;
    }

    // Check required matches
    if (specOpt.required && !indexOpt.required) {
      errors.push(`Command "${specCmd.name}": option "--${specOpt.name}" should be required`);
    }

    // Check alias matches
    if (specOpt.alias && specOpt.alias !== indexOpt.alias) {
      warnings.push(`Command "${specCmd.name}": option "--${specOpt.name}" alias mismatch (spec: ${specOpt.alias}, index: ${indexOpt.alias || 'none'})`);
    }
  }
}

// Check 2: All index.ts commands are in spec
console.log('2️⃣  Checking for undeclared commands...');
for (const indexCmd of indexCommands) {
  const specCmd = specCommands.find(c => c.name === indexCmd.name);

  if (!specCmd) {
    errors.push(`Command "${indexCmd.name}" is registered in src/index.ts but not declared in spec.yaml`);
    continue;
  }

  // Skip option checks for group commands (they typically have no options)
  if (specCmd.isGroup) continue;

  // Check for extra options in index.ts
  for (const indexOpt of indexCmd.options) {
    const specOpt = specCmd.options.find(o =>
      o.name === indexOpt.name ||
      normalizeOptionName(o.name) === normalizeOptionName(indexOpt.name)
    );

    if (!specOpt) {
      errors.push(`Command "${indexCmd.name}": option "--${indexOpt.name}" is in index.ts but not in spec`);
    }
  }
}

// Check 3: All handler files exist
console.log('3️⃣  Checking handler files exist...');
for (const specCmd of specCommands) {
  // Skip group commands without handlers
  if (!specCmd.handler) continue;

  const handlerPath = join(rootDir, specCmd.handler);

  if (!existsSync(handlerPath)) {
    errors.push(`Handler file not found: ${specCmd.handler}`);
  }
}

// Check 4: Verify handler modules are imported in index.ts
console.log('4️⃣  Checking imports...');
// Collect unique handler paths (multiple commands can share a handler, e.g. auth.ts)
const handlerPaths = new Set(
  specCommands
    .filter(cmd => cmd.handler)
    .map(cmd => cmd.handler)
);

for (const handlerPath of handlerPaths) {
  // Convert spec handler path (./src/commands/foo.ts) to import path (./commands/foo.js)
  const importPath = handlerPath
    .replace(/^\.\/src\//, './')
    .replace(/\.ts$/, '.js');

  // Check that the handler module is imported in index.ts
  // Use regex to handle both single and multi-named imports
  const escapedPath = importPath.replaceAll('.', String.raw`\.`);
  const importPattern = new RegExp(String.raw`from ['"]${escapedPath}['"]`);
  if (!importPattern.test(indexContent)) {
    errors.push(`Handler module not imported in src/index.ts: ${importPath}`);
  }
}

// Print results
console.log('\n' + '='.repeat(60));

if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All checks passed! Commands match specification.');
  process.exit(0);
}

if (errors.length > 0) {
  console.log('\n❌ Errors found:\n');
  errors.forEach(err => console.log(`  • ${err}`));
}

if (warnings.length > 0) {
  console.log('\n⚠️  Warnings:\n');
  warnings.forEach(warn => console.log(`  • ${warn}`));
}

console.log('\n' + '='.repeat(60));
console.log(`\nTotal: ${errors.length} error(s), ${warnings.length} warning(s)`);

process.exit(errors.length > 0 ? 1 : 0);
