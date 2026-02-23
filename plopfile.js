/**
 * Plop.js Code Generator for Sonar CLI
 *
 * Generates command stubs from spec.yaml
 *
 * Usage:
 *   npx plop command
 *   npx plop docs
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

function toCamelCase(str) {
  return str.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function toPascalCase(str) {
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function collectCommandExports(cmd) {
  const result = [];
  if (cmd.handler) {
    result.push(`${toCamelCase(cmd.name)}Command`);
  }
  for (const sub of (cmd.subcommands || []).filter(s => s.handler)) {
    result.push(`${toCamelCase(cmd.name)}${toPascalCase(sub.name)}Command`);
  }
  return result;
}

function flattenCommands(cmds, parentName = '') {
  const commands = [];
  for (const cmd of cmds) {
    const fullName = parentName ? `${parentName}:${cmd.name}` : cmd.name;
    commands.push({ ...cmd, fullName, parentName });
    if (cmd.subcommands) {
      commands.push(...flattenCommands(cmd.subcommands, fullName));
    }
  }
  return commands;
}

function collectHandlerCommands(cmds, parentName = '') {
  const commands = [];
  for (const cmd of cmds) {
    const fullName = parentName ? `${parentName} ${cmd.name}` : cmd.name;
    if (cmd.handler) {
      commands.push({ name: `${fullName} - ${cmd.description}`, value: { fullName, ...cmd } });
    }
    if (cmd.subcommands) {
      commands.push(...collectHandlerCommands(cmd.subcommands, fullName));
    }
  }
  return commands;
}

function buildCommandActions(cmds, cli, actions = []) {
  for (const cmd of cmds) {
    if (cmd.handler) {
      actions.push({
        type: 'add',
        path: cmd.handler,
        templateFile: 'plop-templates/command.ts.hbs',
        data: { command: cmd, cli, hasOptions: cmd.options && cmd.options.length > 0 },
        skipIfExists: true
      });
    }
    if (cmd.subcommands) {
      buildCommandActions(cmd.subcommands, cli, actions);
    }
  }
  return actions;
}

export default function registerPlopGenerators(plop) {
  const spec = yaml.load(readFileSync('./spec.yaml', 'utf8'));

  plop.setHelper('getAllCommands', () => flattenCommands(spec.commands));

  plop.setHelper('tsType', (type) => {
    const typeMap = { string: 'string', boolean: 'boolean', number: 'number', array: 'string[]' };
    return typeMap[type] ?? 'any';
  });

  plop.setHelper('eq', (a, b) => a === b);

  plop.setHelper('commandImports', (commands) => {
    const moduleMap = new Map();
    for (const cmd of commands) {
      const exps = collectCommandExports(cmd);
      if (exps.length > 0) {
        moduleMap.set(cmd.name, exps);
      }
    }
    return Array.from(moduleMap.entries())
      .map(([moduleName, exps]) => `import { ${exps.join(', ')} } from './commands/${moduleName}.js';`)
      .join('\n');
  });

  plop.setHelper('requiredOptions', (options) => {
    if (!options) return [];
    return options.filter(opt => opt.required);
  });

  plop.setGenerator('command', {
    description: 'Generate command handler from spec.yaml',
    prompts: [
      {
        type: 'list',
        name: 'commandPath',
        message: 'Which command to generate?',
        choices: () => collectHandlerCommands(spec.commands)
      }
    ],
    actions: (answers) => {
      const cmd = answers.commandPath;
      if (!cmd.handler) return [];
      return [
        {
          type: 'add',
          path: cmd.handler,
          templateFile: 'plop-templates/command.ts.hbs',
          data: { command: cmd, cli: spec.cli, hasOptions: cmd.options && cmd.options.length > 0 },
          skipIfExists: true
        },
        () => '✓ Command generated! Run "npx plop sync-index" to register it in src/index.ts'
      ];
    }
  });

  plop.setGenerator('sync-index', {
    description: 'Regenerate src/index.ts from spec.yaml',
    prompts: [
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Regenerate src/index.ts? This will OVERWRITE the existing file.',
        default: false
      }
    ],
    actions: (answers) => {
      if (!answers.confirm) return [];
      return [
        {
          type: 'add',
          path: 'src/index.ts',
          templateFile: 'plop-templates/index.ts.hbs',
          data: { cli: spec.cli, commands: spec.commands },
          force: true
        }
      ];
    }
  });

  plop.setGenerator('docs', {
    description: 'Generate CLI documentation from spec.yaml',
    prompts: [],
    actions: [
      {
        type: 'add',
        path: 'docs/CLI.md',
        templateFile: 'plop-templates/docs.md.hbs',
        data: { spec, generatedAt: new Date().toISOString() },
        force: true
      }
    ]
  });

  plop.setGenerator('all-commands', {
    description: 'Generate all command handlers from spec.yaml',
    prompts: [
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Generate ALL command handlers? This will skip existing files.',
        default: false
      }
    ],
    actions: (answers) => {
      if (!answers.confirm) return [];
      const actions = buildCommandActions(spec.commands, spec.cli);
      actions.push(() => '✓ Commands generated! Run "npx plop sync-index" to register them in src/index.ts');
      return actions;
    }
  });
}
