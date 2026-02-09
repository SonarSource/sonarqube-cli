#!/usr/bin/env node

/**
 * Validate cli-spec.yaml against cli-spec.schema.json
 *
 * Usage:
 *   node scripts/validate-spec.js
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, verbose: true });

// Load schema
const schema = JSON.parse(readFileSync('./cli-spec.schema.json', 'utf8'));

// Load spec
const specYaml = readFileSync('./cli-spec.yaml', 'utf8');
const spec = yaml.load(specYaml);

// Validate
const validate = ajv.compile(schema);
const valid = validate(spec);

if (valid) {
  console.log('✅ cli-spec.yaml is valid!');
  console.log(`   CLI: ${spec.cli.name} v${spec.cli.version}`);
  console.log(`   Commands: ${spec.commands.length}`);

  // Count total commands including subcommands
  let totalCommands = 0;
  function countCommands(commands) {
    commands.forEach(cmd => {
      totalCommands++;
      if (cmd.subcommands) {
        countCommands(cmd.subcommands);
      }
    });
  }
  countCommands(spec.commands);

  console.log(`   Total commands (including subcommands): ${totalCommands}`);
  process.exit(0);
} else {
  console.error('❌ cli-spec.yaml validation failed:\n');
  validate.errors.forEach((error, i) => {
    console.error(`${i + 1}. ${error.instancePath} ${error.message}`);
    if (error.params) {
      console.error(`   Params:`, error.params);
    }
  });
  process.exit(1);
}
