/**
 * Plop.js Code Generator for Sonar CLI
 *
 * Generates command stubs from cli-spec.yaml
 *
 * Usage:
 *   npx plop command
 *   npx plop docs
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';

export default function (plop) {
  // Load CLI specification
  const spec = yaml.load(readFileSync('./cli-spec.yaml', 'utf8'));

  // Helper: Get all commands (flatten tree)
  plop.setHelper('getAllCommands', () => {
    const commands = [];
    function traverse(cmds, parentName = '') {
      cmds.forEach(cmd => {
        const fullName = parentName ? `${parentName}:${cmd.name}` : cmd.name;
        commands.push({
          ...cmd,
          fullName,
          parentName
        });
        if (cmd.subcommands) {
          traverse(cmd.subcommands, fullName);
        }
      });
    }
    traverse(spec.commands);
    return commands;
  });

  // Helper: Convert option type to TypeScript type
  plop.setHelper('tsType', (type) => {
    const typeMap = {
      'string': 'string',
      'boolean': 'boolean',
      'number': 'number',
      'array': 'string[]'
    };
    return typeMap[type] || 'any';
  });

  // Helper: Equality comparison
  plop.setHelper('eq', (a, b) => a === b);

  // Helper: Get required options
  plop.setHelper('requiredOptions', (options) => {
    if (!options) return [];
    return options.filter(opt => opt.required);
  });

  // Generator: Create command from spec
  plop.setGenerator('command', {
    description: 'Generate command handler from cli-spec.yaml',
    prompts: [
      {
        type: 'list',
        name: 'commandPath',
        message: 'Which command to generate?',
        choices: () => {
          const commands = [];
          function traverse(cmds, parentName = '') {
            cmds.forEach(cmd => {
              const fullName = parentName ? `${parentName} ${cmd.name}` : cmd.name;
              if (cmd.handler) {
                commands.push({
                  name: `${fullName} - ${cmd.description}`,
                  value: { fullName, ...cmd }
                });
              }
              if (cmd.subcommands) {
                traverse(cmd.subcommands, fullName);
              }
            });
          }
          traverse(spec.commands);
          return commands;
        }
      }
    ],
    actions: (answers) => {
      const cmd = answers.commandPath;
      const actions = [];

      // Generate handler file
      if (cmd.handler) {
        actions.push({
          type: 'add',
          path: cmd.handler,
          templateFile: 'plop-templates/command.ts.hbs',
          data: {
            command: cmd,
            cli: spec.cli,
            hasOptions: cmd.options && cmd.options.length > 0
          },
          skipIfExists: true
        });

        // Note: Run "npx plop sync-index" to register the command in src/index.ts
        actions.push(() => {
          return '✓ Command generated! Run "npx plop sync-index" to register it in src/index.ts';
        });
      }

      return actions;
    }
  });

  // Generator: Sync index.ts with cli-spec.yaml
  plop.setGenerator('sync-index', {
    description: 'Regenerate src/index.ts from cli-spec.yaml',
    prompts: [
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Regenerate src/index.ts? This will OVERWRITE the existing file.',
        default: false
      }
    ],
    actions: (answers) => {
      if (!answers.confirm) {
        return [];
      }

      return [
        {
          type: 'add',
          path: 'src/index.ts',
          templateFile: 'plop-templates/index.ts.hbs',
          data: {
            cli: spec.cli,
            commands: spec.commands
          },
          force: true // Overwrite existing
        }
      ];
    }
  });

  // Generator: Generate documentation
  plop.setGenerator('docs', {
    description: 'Generate CLI documentation from cli-spec.yaml',
    prompts: [],
    actions: [
      {
        type: 'add',
        path: 'docs/CLI.md',
        templateFile: 'plop-templates/docs.md.hbs',
        data: {
          spec,
          generatedAt: new Date().toISOString()
        },
        force: true // Overwrite if exists
      }
    ]
  });

  // Generator: Generate all commands at once
  plop.setGenerator('all-commands', {
    description: 'Generate all command handlers from cli-spec.yaml',
    prompts: [
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Generate ALL command handlers? This will skip existing files.',
        default: false
      }
    ],
    actions: (answers) => {
      if (!answers.confirm) {
        return [];
      }

      const actions = [];
      function traverse(cmds, parentName = '') {
        cmds.forEach(cmd => {
          if (cmd.handler) {
            actions.push({
              type: 'add',
              path: cmd.handler,
              templateFile: 'plop-templates/command.ts.hbs',
              data: {
                command: cmd,
                cli: spec.cli,
                hasOptions: cmd.options && cmd.options.length > 0
              },
              skipIfExists: true
            });
          }
          if (cmd.subcommands) {
            traverse(cmd.subcommands, parentName);
          }
        });
      }
      traverse(spec.commands);

      // Note: Run sync-index to register commands
      actions.push(() => {
        return '✓ Commands generated! Run "npx plop sync-index" to register them in src/index.ts';
      });

      return actions;
    }
  });
}
