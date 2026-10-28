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

interface IsTtyStream {
  isTTY?: boolean;
}

export function stubIsTTY(value: boolean, ...streams: IsTtyStream[]): () => void {
  const restores = streams.map((stream) => stubStreamIsTTY(stream, value));
  return () => runAll(restores);
}

function stubStreamIsTTY(stream: IsTtyStream, value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, writable: true, value });
  return () => {
    if (original) {
      Object.defineProperty(stream, 'isTTY', original);
    } else {
      Reflect.deleteProperty(stream, 'isTTY');
    }
  };
}

function runAll(restores: (() => void)[]): void {
  for (const restore of restores) {
    restore();
  }
}
