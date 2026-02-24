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
 * Build standalone binaries with Bun
 * Works cross-platform: macOS, Linux, Windows
 */

import { execSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
const DIST_DIR = join(PROJECT_ROOT, 'dist', 'binaries');

// Detect platform and architecture
function getPlatformInfo() {
  const osType = platform();
  const arch = process.arch;

  const platformMap = {
    darwin: { name: 'macOS', suffix: `macos-${arch === 'arm64' ? 'arm64' : 'x64'}` },
    linux: { name: 'Linux', suffix: `linux-${arch === 'x64' ? 'x64' : 'arm64'}` },
    win32: { name: 'Windows', suffix: `windows-${arch === 'x64' ? 'x64' : 'arm64'}` }
  };

  return platformMap[osType] || { name: 'Unknown', suffix: 'unknown' };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  try {
    console.log('🔨 Building standalone binaries with Bun...\n');

    // Create dist directory
    mkdirSync(DIST_DIR, { recursive: true });

    // Get platform info
    const { name, suffix } = getPlatformInfo();

    const binaryName = `sonarqube-cli-${suffix}`;
    const outputPath = join(DIST_DIR, binaryName);

    console.log(`Building for ${name} (${process.arch})...`);

    // Run bun build
    execSync(`bun build src/index.ts --compile --outfile ${outputPath}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });

    // Get file size
    const stats = statSync(outputPath);
    const sizeStr = formatBytes(stats.size);

    console.log(`✅ Binary built: ${binaryName}`);
    console.log('');
    console.log('📦 File size:');
    console.log(`   ${sizeStr}`);
    console.log('');
    console.log('ℹ️  Note: Bun can only compile for the current platform');
    console.log('🎯 To build for other platforms:');
    console.log('   - Run on each target platform (macOS, Linux, Windows)');
    console.log('   - Or use Docker for cross-platform builds');
    console.log('');
  } catch (error) {
    console.error('❌ Build failed:', (error).message);
    process.exit(1);
  }
}

main();
