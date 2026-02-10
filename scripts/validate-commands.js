#!/usr/bin/env node

/**
 * Validate that implemented commands match cli-spec.yaml
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
const REGEX_CMDNAME = 1;
const REGEX_DESCRIPTION = 2;
const REGEX_OPTIONS = 3;
const REGEX_SUBNAME = 1;
const REGEX_SUBOPTIONS = 3;
const SHORT_FLAG_INDEX = 1;
const LONG_FLAG_INDEX = 2;

// Load spec
const specPath = join(rootDir, 'cli-spec.yaml');
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
 * Extract commands from cli-spec.yaml
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
 * Extract command registrations from src/index.ts
 */
function parseIndexCommands(content) {
  const commands = [];

  // Match simple commands: program.command('name')
  // Pattern limits content length to prevent backtracking vulnerability
  const simplePattern = /program\s*\.command\(['"]([^'"]+)['"]\)\s*\.description\(['"]([^'"]+)['"]\)([\s\S]{0,10000}?)\.action\(/g;

  let match;
  while ((match = simplePattern.exec(content)) !== null) {
    let name = match[REGEX_CMDNAME];
    const description = match[REGEX_DESCRIPTION];
    const optionsBlock = match[REGEX_OPTIONS];

    // Remove positional arguments from command name
    name = stripPositionalArgs(name);

    const options = parseOptions(optionsBlock);

    commands.push({ name, description, options });
  }

  // Match subcommands: const daemon = program.command('daemon')
  // daemon.command('start')
  const subcommandGroupPattern = /const\s+(\w+)\s*=\s*program\s*\.command\(['"]([^'"]+)['"]\)/g;

  while ((match = subcommandGroupPattern.exec(content)) !== null) {
    const varName = match[REGEX_CMDNAME];
    const groupName = match[REGEX_DESCRIPTION];

    // Find subcommands for this group
    // Escape special regex characters (excluding brackets which are already handled)
    const specialChars = '.*+?^${}()|\\';
    let escapedVarName = '';
    for (const char of varName) {
      if (specialChars.includes(char)) {
        escapedVarName += '\\' + char;
      } else {
        escapedVarName += char;
      }
    }

    const subPattern = new RegExp(
      escapedVarName +
      String.raw`\s*\.command\(['"]([^'"]+)['"]\)\s*\.description\(['"]([^'"]+)['"]\)([\s\S]{0,10000}?)\.action\(`,
      'g'
    );

    let subMatch;
    while ((subMatch = subPattern.exec(content)) !== null) {
      const subName = subMatch[REGEX_SUBNAME];
      const description = subMatch[REGEX_DESCRIPTION];
      const optionsBlock = subMatch[REGEX_SUBOPTIONS];

      const options = parseOptions(optionsBlock);

      commands.push({
        name: `${groupName} ${subName}`,
        description,
        options
      });
    }
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

    const flags = matches[0];
    const description = matches[1] || '';
    const defaultValue = matches[2];

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
  const indexCmd = indexCommands.find(c => c.name === specCmd.name);

  if (!indexCmd) {
    errors.push(`Command "${specCmd.name}" is defined in spec but not registered in src/index.ts`);
    continue;
  }

  // Skip option checks for group commands
  if (specCmd.isGroup) continue;

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
    errors.push(`Command "${indexCmd.name}" is registered in src/index.ts but not declared in cli-spec.yaml`);
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

// Check 4: Verify imports in index.ts
console.log('4️⃣  Checking imports...');
for (const specCmd of specCommands) {
  // Skip group commands without handlers
  if (!specCmd.handler) continue;

  // Extract function name from command name
  // For subcommands like "daemon start", use full name: daemonStartCommand
  // For simple commands like "status", use: statusCommand
  const nameParts = specCmd.name.split(' ');
  const functionName = nameParts
    .map((part, i) => {
      const camelPart = toCamelCase(part);
      return i === 0 ? camelPart : camelPart.charAt(0).toUpperCase() + camelPart.slice(1);
    })
    .join('') + 'Command';

  if (!indexContent.includes(`import { ${functionName} }`)) {
    errors.push(`Missing import for ${functionName} in src/index.ts`);
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
