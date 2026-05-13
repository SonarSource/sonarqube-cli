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

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const scriptPath = join(import.meta.dir, '../../../../user-scripts/install.sh');
const prereleaseScriptPath = join(
  import.meta.dir,
  '../../../../user-scripts/install-prerelease.sh',
);
const isWindows = process.platform === 'win32';

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function extract(path: string, fn: string): string {
  const proc = Bun.spawnSync(['sed', '-n', `/^${fn}()/,/^}/p`, path]);
  return new TextDecoder().decode(proc.stdout).trim();
}

function runDetectPlatform(opts: {
  os?: string;
  arch: string;
  lddOutput?: string;
  lddExitCode?: number;
  script?: string;
}): { stdout: string; stderr: string; exitCode: number } {
  const binDir = mkdtempSync(join(tmpdir(), 'sonar-platform-bin-'));
  const script = opts.script ?? scriptPath;

  try {
    writeExecutable(
      join(binDir, 'uname'),
      `#!/usr/bin/env bash
case "$1" in
  -s) echo "${opts.os ?? 'Linux'}" ;;
  -m) echo "${opts.arch}" ;;
  *) exit 1 ;;
esac
`,
    );
    writeExecutable(
      join(binDir, 'ldd'),
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  cat <<'EOF'
${opts.lddOutput ?? 'ldd (GNU libc) 2.39'}
EOF
  exit ${opts.lddExitCode ?? 0}
fi
exit 1
`,
    );

    const bashSnippet = `
set -euo pipefail
eval "$(sed -n '/^detect_os()/,/^}/p' "${script}")"
eval "$(sed -n '/^is_musl_linux()/,/^}/p' "${script}")"
eval "$(sed -n '/^detect_platform()/,/^}/p' "${script}")"
detect_platform
`;
    const proc = Bun.spawnSync(['bash', '-c', bashSnippet], {
      env: { PATH: `${binDir}:${process.env.PATH!}` },
    });
    return {
      stdout: new TextDecoder().decode(proc.stdout).trim(),
      stderr: new TextDecoder().decode(proc.stderr).trim(),
      exitCode: proc.exitCode,
    };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe.if(!isWindows)('install.sh platform detection', () => {
  const cases = [
    {
      name: 'detects glibc x86_64',
      arch: 'x86_64',
      lddOutput: 'ldd (GNU libc) 2.39',
      expected: 'linux-x86-64',
    },
    {
      name: 'detects musl x86_64',
      arch: 'x86_64',
      lddOutput: 'musl libc (x86_64)\nVersion 1.2.5',
      expected: 'linux-x86-64-musl',
    },
    {
      name: 'detects glibc arm64',
      arch: 'aarch64',
      lddOutput: 'ldd (GNU libc) 2.39',
      expected: 'linux-arm64',
    },
    {
      name: 'detects musl arm64',
      arch: 'arm64',
      lddOutput: 'musl libc (aarch64)\nVersion 1.2.5',
      expected: 'linux-arm64-musl',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = runDetectPlatform(testCase);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(testCase.expected);
    });
  }

  it('keeps macOS arm64 unchanged', () => {
    const result = runDetectPlatform({ os: 'Darwin', arch: 'arm64' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('macos-arm64');
  });

  it('detects musl even when ldd exits nonzero', () => {
    const result = runDetectPlatform({
      arch: 'x86_64',
      lddOutput: 'musl libc (x86_64)\nVersion 1.2.5',
      lddExitCode: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('linux-x86-64-musl');
  });

  it('fails on unsupported Linux architecture', () => {
    const result = runDetectPlatform({ arch: 'riscv64' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported Linux architecture: riscv64');
  });

  describe('sync check between install scripts', () => {
    it('install.sh and install-prerelease.sh define the same platform detection', () => {
      expect(extract(scriptPath, 'detect_os')).toBe(extract(prereleaseScriptPath, 'detect_os'));
      expect(extract(scriptPath, 'is_musl_linux')).toBe(
        extract(prereleaseScriptPath, 'is_musl_linux'),
      );
      expect(extract(scriptPath, 'detect_platform')).toBe(
        extract(prereleaseScriptPath, 'detect_platform'),
      );
    });
  });
});
