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

const WRITE_INTERVAL_MS = 1000;

export class RequestScheduler {
  // Compiled-CLI tests cannot inject a mocked clock.
  private readonly writeIntervalMs =
    process.env.__SQ_CLI_TEST_FAST_WRITES === '1' ? 100 : WRITE_INTERVAL_MS;
  private writes: Promise<unknown> = Promise.resolve();
  private resumeAt = 0;
  private nextWriteAt = 0;

  run<T>(write: boolean, request: () => Promise<T>): Promise<T> {
    const execute = async () => {
      await this.wait(write);
      try {
        return await request();
      } finally {
        if (write) {
          this.nextWriteAt = Date.now() + this.writeIntervalMs;
        }
      }
    };
    if (!write) {
      return execute();
    }
    const result = this.writes.then(execute);
    // A rejected write must not prevent the next queued request from running.
    this.writes = result.catch(() => undefined);
    return result;
  }

  coolDown(delayMs: number): void {
    this.resumeAt = Math.max(this.resumeAt, Date.now() + delayMs);
  }

  private async wait(write: boolean): Promise<void> {
    // Another request may extend the cooldown while this one is waiting.
    const delayMs = Math.max(this.resumeAt, write ? this.nextWriteAt : 0) - Date.now();
    if (delayMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return this.wait(write);
  }
}

export function cooldownMessage(platform: string, delayMs: number): string {
  const seconds = Math.ceil(delayMs / 1000);
  return `${platform} rate limit reached. Pausing shared requests for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}
