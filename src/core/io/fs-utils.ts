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

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const normalizePath = (p: string): string => p.replaceAll('\\', '/');

// Win32 extended-length prefix emitted by realpathSync.native
// (GetFinalPathNameByHandleW), anchored at the start of a path. The optional
// `UNC\` group distinguishes the two forms the strip below must handle:
//   \\?\C:\dir            (drive)   -> C:\dir
//   \\?\UNC\server\share  (network) -> \\server\share
// (String.raw can't express these — a raw literal may not end in a backslash.)
const WIN32_EXTENDED_PREFIX_RE = /^\\\\\?\\(UNC\\)?/;

/**
 * Strip the Win32 `\\?\` extended-length path prefix so paths from different
 * realpath implementations (native vs libuv) compare equal. No-op off Windows
 * and on paths without the prefix.
 */
function stripWin32ExtendedPathPrefix(p: string): string {
  if (process.platform !== 'win32') {
    return p;
  }
  // For the UNC form, the prefix collapses back to the `\\` network root.
  return p.replace(WIN32_EXTENDED_PREFIX_RE, (_full, uncMarker) => (uncMarker ? '\\\\' : ''));
}

/**
 * Returns the canonical, fully-resolved path for a directory.
 *
 * Uses `realpathSync.native` (the OS realpath) rather than the JS implementation
 * because on Windows only the native call expands 8.3 short components
 * (e.g. "RUNNER~1" → "runneradmin") and normalizes casing to the
 * filesystem-authoritative long form. That long form is what `git` reports
 * (`rev-parse --show-toplevel`, `worktree list`), so recorded project roots and
 * git-derived lookup roots canonicalize to the same key. The JS `realpathSync`
 * leaves short names untouched, which silently breaks state matching on runners
 * whose temp dir contains an 8.3 component. Falls back to path.resolve() if the
 * path doesn't exist yet.
 *
 * The Win32 extended-length prefix that the native call emits is stripped on
 * both branches so the canonical key is prefix-free (and so a legacy recorded
 * root that already carries a `\\?\` prefix normalizes identically whether or
 * not realpathSync resolves it).
 */
export function canonicalizePath(p: string): string {
  try {
    return stripWin32ExtendedPathPrefix(realpathSync.native(p));
  } catch {
    return stripWin32ExtendedPathPrefix(resolve(p));
  }
}

/**
 * Derive an equality key for a path: its canonical form, lowercased on Windows
 * (a case-insensitive filesystem). Use only to compare paths for equality — the
 * Windows result is case-folded and not suitable for display or filesystem use;
 * call `canonicalizePath` when you need the real path.
 */
export function pathComparisonKey(p: string): string {
  const canonical = canonicalizePath(p);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * POSIX-style path of `file` relative to `base` (defaults to cwd).
 * Canonicalizes both legs so in-`base` symlinks resolving outside are rejected.
 * Returns null on traversal or absolute paths.
 */
export function toRelativePosixPath(file: string, base: string = process.cwd()): string | null {
  const canonicalFile = canonicalizePath(file);
  const canonicalBase = canonicalizePath(base);
  const rel = normalizePath(relative(canonicalBase, canonicalFile));
  if (isAbsolute(rel) || rel.split('/').includes('..')) return null;
  return rel;
}

/** True when `path` is `ancestor` itself or nested under it. Both args must already be canonicalized. */
export function isAncestorOrSelf(ancestor: string, path: string): boolean {
  const rel = relative(ancestor, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
