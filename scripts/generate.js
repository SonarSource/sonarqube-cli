#!/usr/bin/env node

/**
 * Automated code generation from cli-spec.yaml
 * Generates: commands, index.ts registration, documentation
 * Works cross-platform: macOS, Linux, Windows
 */

import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

async function runPlopCommand(command, description) {
  try {
    console.log(`🔄 ${description}...`);
    execSync(`echo "y" | npx plop ${command}`, {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
  } catch (error) {
    console.error(`❌ Failed to ${description}:`, (error).message);
    throw error;
  }
}

async function main() {
  try {
    console.log('');
    console.log('🔄 Generating code from cli-spec.yaml...\n');

    // Generate commands
    await runPlopCommand('all-commands', 'Generating commands');

    // Sync index.ts
    await runPlopCommand('sync-index', 'Synchronizing src/index.ts');

    // Generate documentation
    await runPlopCommand('docs', 'Generating documentation');

    console.log('');
    console.log('✅ Generation complete!');
    console.log('');
    console.log('Next steps:');
    console.log('  npm run validate    # Validate generated code');
    console.log('  npm run build       # Build TypeScript');
    console.log('');
  } catch (error) {
    console.error('❌ Generation failed');
    process.exit(1);
  }
}

main();
