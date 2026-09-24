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

const ESCAPED_BYTES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
};

const BACKSLASH = '\\';
const OCTAL_ESCAPE = /^[0-7]{3}$/;
const OCTAL_DIGITS = 3;

/**
 * Undoes git's C-style path quoting, returning the input when it does not decode. Octal escapes are bytes, not
 * characters: decoded one at a time they turn `café.txt` into `cafÃ©.txt`.
 */
export function decodeGitPath(field: string): string {
  if (!isQuoted(field)) return field;
  const bytes = unescapeToBytes(field.slice(1, -1));
  if (bytes === null) return field;
  return decodeUtf8(bytes) ?? field;
}

function isQuoted(field: string): boolean {
  return field.length >= 2 && field.startsWith('"') && field.endsWith('"');
}

/** Null when an escape is not one git produces. */
function unescapeToBytes(body: string): number[] | null {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] !== BACKSLASH) {
      // Encoded as a run rather than per character, so a surrogate pair is never split into two lone halves.
      const literal = body.slice(cursor, nextBackslash(body, cursor));
      bytes.push(...encoder.encode(literal));
      cursor += literal.length;
      continue;
    }
    const escaped = readEscape(body, cursor + 1);
    if (escaped === null) return null;
    bytes.push(escaped.byte);
    cursor += BACKSLASH.length + escaped.width;
  }
  return bytes;
}

function nextBackslash(body: string, from: number): number {
  const found = body.indexOf(BACKSLASH, from);
  return found === -1 ? body.length : found;
}

function readEscape(body: string, index: number): { byte: number; width: number } | null {
  const escape = body[index];
  if (escape in ESCAPED_BYTES) return { byte: ESCAPED_BYTES[escape], width: 1 };
  const octal = body.slice(index, index + OCTAL_DIGITS);
  if (!OCTAL_ESCAPE.test(octal)) return null;
  return { byte: Number.parseInt(octal, 8), width: OCTAL_DIGITS };
}

function decodeUtf8(bytes: number[]): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
