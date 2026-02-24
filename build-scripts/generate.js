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
 * Automated code generation from spec.yaml
 * Generates: commands, index.ts registration, documentation
 * Works cross-platform: macOS, Linux, Windows
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

function runPlopCommand(command, description) {
  console.log(`🔄 ${description}...`);
  const result = spawnSync('npx', ['plop', command], {
    cwd: PROJECT_ROOT,
    input: 'y\n',
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${description}: ${result.stderr || result.error?.message}`);
  }
}

try {
  console.log('');
  console.log('🔄 Generating code from spec.yaml...\n');

  runPlopCommand('all-commands', 'Generating commands');
  runPlopCommand('sync-index', 'Synchronizing src/index.ts');
  runPlopCommand('docs', 'Generating documentation');

  console.log('');
  console.log('✅ Generation complete!');
  console.log('');
  console.log('Next steps:');
  console.log('  npm run validate    # Validate generated code');
  console.log('  npm run build       # Build TypeScript');
  console.log('');
} catch (error) {
  console.error('❌ Generation failed:', error.message);
  process.exit(1);
}
