/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Virtual npm repo used by bunfig.toml `[install].registry`. bun compile does
 * not honor that setting (it hardcodes registry.npmjs.org), so cross-compile
 * fetches the `@oven/bun-*` tarball from here and passes `executablePath`.
 */
export const REPOX_NPM_REGISTRY = 'https://repox.jfrog.io/artifactory/api/npm/npm';

const COMPILE_TARGET_NPM_PACKAGES: Record<string, string> = {
  'bun-linux-x64': 'bun-linux-x64',
  'bun-linux-arm64': 'bun-linux-aarch64',
  'bun-linux-aarch64': 'bun-linux-aarch64',
  'bun-darwin-arm64': 'bun-darwin-aarch64',
  'bun-darwin-aarch64': 'bun-darwin-aarch64',
  'bun-windows-x64': 'bun-windows-x64',
};

export function npmPackageForCompileTarget(target: string): string | undefined {
  return COMPILE_TARGET_NPM_PACKAGES[target];
}

const UNIX_EXECUTABLE_MODE = 0o755;

function hostCompileOs(): 'darwin' | 'windows' | 'linux' {
  if (process.platform === 'darwin') {
    return 'darwin';
  }
  if (process.platform === 'win32') {
    return 'windows';
  }
  return 'linux';
}

function hostCompileArch(): 'arm64' | 'x64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

export function compileTargetMatchesHost(target: string): boolean {
  const os = hostCompileOs();
  const arch = hostCompileArch();
  return target === `bun-${os}-${arch}` || (arch === 'arm64' && target === `bun-${os}-aarch64`);
}

export function compileTargetTarballUrl(
  registryUrl: string,
  npmPackage: string,
  version: string,
): string {
  const base = registryUrl.replace(/\/$/, '');
  return `${base}/@oven/${npmPackage}/-/${npmPackage}-${version}.tgz`;
}

export async function downloadCompileTargetExecutable(options: {
  target: string;
  bunVersion: string;
  registryUrl: string;
  token: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ executablePath: string; cleanup: () => void }> {
  const npmPackage = npmPackageForCompileTarget(options.target);
  if (!npmPackage) {
    throw new Error(`No npm package mapping for compile target '${options.target}'`);
  }

  const url = compileTargetTarballUrl(options.registryUrl, npmPackage, options.bunVersion);
  const extractDir = mkdtempSync(join(tmpdir(), 'bun-compile-target-'));
  const cleanup = (): void => {
    rmSync(extractDir, { recursive: true, force: true });
  };

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download @oven/${npmPackage}@${options.bunVersion} from Repox: HTTP ${response.status}`,
      );
    }

    const tarballPath = join(extractDir, 'bun.tgz');
    await Bun.write(tarballPath, response);

    // GNU tar treats `C:` as a remote host; keep the archive name relative.
    const extracted = Bun.spawnSync(['tar', '-xzf', 'bun.tgz'], {
      cwd: extractDir,
      stderr: 'pipe',
    });
    if (extracted.exitCode !== 0) {
      const detail = extracted.stderr.toString().trim();
      const message = `Failed to extract @oven/${npmPackage}@${options.bunVersion} tarball`;
      throw new Error(detail ? `${message}: ${detail}` : message);
    }

    const unixBin = join(extractDir, 'package', 'bin', 'bun');
    const windowsBin = join(extractDir, 'package', 'bin', 'bun.exe');
    let executablePath: string | undefined;
    if (existsSync(unixBin)) {
      executablePath = unixBin;
    } else if (existsSync(windowsBin)) {
      executablePath = windowsBin;
    }
    if (!executablePath) {
      throw new Error(
        `Extracted @oven/${npmPackage}@${options.bunVersion} tarball is missing package/bin/bun`,
      );
    }
    if (executablePath === unixBin) {
      chmodSync(executablePath, UNIX_EXECUTABLE_MODE);
    }

    return { executablePath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
