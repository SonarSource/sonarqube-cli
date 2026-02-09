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

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Load spec
const specPath = join(rootDir, 'cli-spec.yaml');
const spec = yaml.load(readFileSync(specPath, 'utf8'));

// Load index.ts
const indexPath = join(rootDir, 'src/index.ts');
const indexContent = readFileSync(indexPath, 'utf8');

let errors = [];
let warnings = [];

/**
 * Extract commands from cli-spec.yaml
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

    if (cmd.subcommands) {
      result.push(...getSpecCommands(cmd.subcommands, fullName));
    }
  }

  return result;
}

/**
 * Extract command registrations from src/index.ts
 */
function parseIndexCommands(content) {
  const commands = [];

  // Match simple commands: program.command('name')
  const simplePattern = /program\s*\.command\(['"]([^'"]+)['"]\)\s*\.description\(['"]([^'"]+)['"]\)([\s\S]*?)\.action\(/g;

  let match;
  while ((match = simplePattern.exec(content)) !== null) {
    let name = match[1];
    const description = match[2];
    const optionsBlock = match[3];

    // Remove positional arguments from command name: 'onboard-agent <agent>' -> 'onboard-agent'
    name = name.replace(/\s*<[^>]+>/g, '').replace(/\s*\[[^\]]+\]/g, '').trim();

    const options = parseOptions(optionsBlock);

    commands.push({ name, description, options });
  }

  // Match subcommands: const daemon = program.command('daemon')
  // daemon.command('start')
  const subcommandGroupPattern = /const\s+(\w+)\s*=\s*program\s*\.command\(['"]([^'"]+)['"]\)/g;

  while ((match = subcommandGroupPattern.exec(content)) !== null) {
    const varName = match[1];
    const groupName = match[2];

    // Find subcommands for this group
    const subPattern = new RegExp(
      varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*\\.command\\([\'"]([^\'"]+)[\'"]\\)\\s*\\.description\\([\'"]([^\'"]+)[\'"]\\)([\\s\\S]*?)\\.action\\(',
      'g'
    );

    let subMatch;
    while ((subMatch = subPattern.exec(content)) !== null) {
      const subName = subMatch[1];
      const description = subMatch[2];
      const optionsBlock = subMatch[3];

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

  // Match .option() and .requiredOption()
  const optionPattern = /\.(required)?[Oo]ption\(['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?(?:,\s*['"]([^'"]+)['"])?\)/g;

  let match;
  while ((match = optionPattern.exec(optionsBlock)) !== null) {
    const isRequired = match[1] === 'required';
    const flags = match[2];
    const description = match[3] || '';
    const defaultValue = match[4];

    // Parse flags: '-n, --name <name>' or '--verbose'
    const flagMatch = flags.match(/(?:-(\w),?\s*)?--([a-z-]+)(?:\s*<[^>]+>)?/);
    if (flagMatch) {
      options.push({
        name: flagMatch[2],
        alias: flagMatch[1],
        required: isRequired,
        description,
        default: defaultValue
      });
    }
  }

  return options;
}

/**
 * Normalize option name (convert kebab-case to camelCase for comparison)
 */
function normalizeOptionName(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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
      const camelPart = part.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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
