#!/usr/bin/env node

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
