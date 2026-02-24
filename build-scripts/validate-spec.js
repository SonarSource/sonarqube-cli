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
 * Validate spec.yaml against spec.schema.json
 *
 * Usage:
 *   node build-scripts/validate-spec.js
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, verbose: true });

// Load schema
const schema = JSON.parse(readFileSync('./spec.schema.json', 'utf8'));

// Load spec
const specYaml = readFileSync('./spec.yaml', 'utf8');
const spec = yaml.load(specYaml);

// Validate
const validate = ajv.compile(schema);
const valid = validate(spec);

if (valid) {
  console.log('✅ spec.yaml is valid!');
  console.log(`   CLI: ${spec.cli.name}`);
  console.log(`   Commands: ${spec.commands.length}`);

  // Count total commands including subcommands
  let totalCommands = 0;
  const countCommands = (commands) => {
    commands.forEach(cmd => {
      totalCommands++;
      if (cmd.subcommands) {
        countCommands(cmd.subcommands);
      }
    });
  };
  countCommands(spec.commands);

  console.log(`   Total commands (including subcommands): ${totalCommands}`);
  process.exit(0);
} else {
  console.error('❌ spec.yaml validation failed:\n');
  validate.errors.forEach((error, i) => {
    console.error(`${i + 1}. ${error.instancePath} ${error.message}`);
    if (error.params) {
      console.error(`   Params:`, error.params);
    }
  });
  process.exit(1);
}
