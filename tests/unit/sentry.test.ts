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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as Sentry from '@sentry/bun';
import type { ErrorEvent, EventHint } from '@sentry/bun';
import { homedir } from 'node:os';
import * as userModule from '../../src/telemetry/user.js';
import { initSentry } from '../../src/lib/sentry.js';
import { getDefaultState } from '../../src/lib/state.js';

function makeErrorEvent(
  filenames: (string | undefined)[][],
  exceptionValues?: (string | undefined)[],
): ErrorEvent {
  return {
    exception: {
      values: filenames.map((frames, i) => ({
        value: exceptionValues?.[i],
        stacktrace: {
          frames: frames.map((filename) => ({ filename })),
        },
      })),
    },
    type: undefined,
  };
}

function makeEventWithBreadcrumbs(messages: (string | undefined)[]): ErrorEvent {
  return {
    type: undefined,
    breadcrumbs: messages.map((message) => ({ message })),
  };
}

function captureBeforeSend(): (event: ErrorEvent, hint: EventHint) => ErrorEvent {
  const initCall = initSpy.mock.calls[0];
  const options = initCall[0] as Sentry.BunOptions;
  return options.beforeSend as (event: ErrorEvent, hint: EventHint) => ErrorEvent;
}

let initSpy: ReturnType<typeof spyOn>;
let setUserSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  initSpy = spyOn(Sentry, 'init').mockImplementation(() => undefined);
  setUserSpy = spyOn(Sentry, 'setUser').mockImplementation(() => {});
  getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('test-machine-id');
});

afterEach(() => {
  initSpy.mockRestore();
  setUserSpy.mockRestore();
  getUserIdSpy.mockRestore();
  delete process.env['SONARSOURCE_DOGFOODING'];
});

describe('initSentry', () => {
  describe('when telemetry is disabled', () => {
    it('does not call Sentry.init', () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;

      initSentry(state);

      expect(initSpy).not.toHaveBeenCalled();
    });

    it('does not call Sentry.setUser', () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;

      initSentry(state);

      expect(setUserSpy).not.toHaveBeenCalled();
    });
  });

  describe('when telemetry is enabled', () => {
    it('calls Sentry.init', () => {
      initSentry(getDefaultState('1.0.0'));

      expect(initSpy).toHaveBeenCalledTimes(1);
    });

    it('passes sendDefaultPii: false', () => {
      initSentry(getDefaultState('1.0.0'));

      const options = initSpy.mock.calls[0][0] as Sentry.BunOptions;
      expect(options.sendDefaultPii).toBe(false);
    });

    it('sets environment to "production" when SONARSOURCE_DOGFOODING is not set', () => {
      delete process.env['SONARSOURCE_DOGFOODING'];

      initSentry(getDefaultState('1.0.0'));

      const options = initSpy.mock.calls[0][0] as Sentry.BunOptions;
      expect(options.environment).toBe('production');
    });

    it('sets environment to "dogfood" when SONARSOURCE_DOGFOODING=1', () => {
      process.env['SONARSOURCE_DOGFOODING'] = '1';

      initSentry(getDefaultState('1.0.0'));

      const options = initSpy.mock.calls[0][0] as Sentry.BunOptions;
      expect(options.environment).toBe('dogfood');
    });

    it('sets environment to "production" when SONARSOURCE_DOGFOODING is not "1"', () => {
      process.env['SONARSOURCE_DOGFOODING'] = '0';

      initSentry(getDefaultState('1.0.0'));

      const options = initSpy.mock.calls[0][0] as Sentry.BunOptions;
      expect(options.environment).toBe('production');
    });

    it('sets the user ID from getOrCreateUserId', () => {
      getUserIdSpy.mockReturnValue('my-machine-id');

      initSentry(getDefaultState('1.0.0'));

      expect(setUserSpy).toHaveBeenCalledWith({ id: 'my-machine-id' });
    });
  });
});

describe('scrubPii', () => {
  it('replaces the home directory with ~ in a frame filename', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    const event = makeErrorEvent([[`${homedir()}/project/src/index.ts`]]);
    const result = beforeSend(event, {});

    expect(result.exception!.values![0].stacktrace!.frames![0].filename).toBe(
      '~/project/src/index.ts',
    );
  });

  it('replaces multiple occurrences of the home directory in the same filename', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    const home = homedir();
    const event = makeErrorEvent([[`${home}/a/${home}/b.ts`]]);
    const result = beforeSend(event, {});

    expect(result.exception!.values![0].stacktrace!.frames![0].filename).toBe('~/a/~/b.ts');
  });

  it('scrubs all frames across multiple exceptions', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    const home = homedir();
    const event = makeErrorEvent([[`${home}/src/a.ts`, `${home}/src/b.ts`], [`${home}/src/c.ts`]]);
    const result = beforeSend(event, {});

    expect(result.exception!.values![0].stacktrace!.frames![0].filename).toBe('~/src/a.ts');
    expect(result.exception!.values![0].stacktrace!.frames![1].filename).toBe('~/src/b.ts');
    expect(result.exception!.values![1].stacktrace!.frames![0].filename).toBe('~/src/c.ts');
  });

  it('leaves filenames that do not contain the home directory unchanged', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    const event = makeErrorEvent([['/usr/local/lib/node_modules/foo/index.js']]);
    const result = beforeSend(event, {});

    expect(result.exception!.values![0].stacktrace!.frames![0].filename).toBe(
      '/usr/local/lib/node_modules/foo/index.js',
    );
  });

  it('handles frames with no filename without throwing', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    const event = makeErrorEvent([[undefined]]);

    expect(() => beforeSend(event, {})).not.toThrow();
  });

  it('handles events with no exceptions without throwing', () => {
    initSentry(getDefaultState('1.0.0'));
    const beforeSend = captureBeforeSend();

    expect(() => beforeSend({ type: undefined }, {})).not.toThrow();
  });

  describe('generic recursive scrubbing', () => {
    it('scrubs strings in arbitrary nested objects not part of the known event structure', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const home = homedir();
      const event: ErrorEvent = {
        type: undefined,
        extra: { cwd: `${home}/project`, note: 'no path here' },
      };
      const result = beforeSend(event, {});

      expect((result.extra as Record<string, string>).cwd).toBe('~/project');
      expect((result.extra as Record<string, string>).note).toBe('no path here');
    });

    it('scrubs strings inside arrays', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const home = homedir();
      const event: ErrorEvent = {
        type: undefined,
        extra: { paths: [`${home}/a`, `${home}/b`, 'unrelated'] },
      };
      const result = beforeSend(event, {});

      expect((result.extra as Record<string, string[]>).paths).toEqual(['~/a', '~/b', 'unrelated']);
    });

    it('scrubs a realistic production event across all string fields', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const home = homedir();
      const event: ErrorEvent = {
        type: undefined,
        exception: {
          values: [
            {
              value: `ENOENT: no such file or directory '${home}/.sonar/state.json'`,
              stacktrace: {
                frames: [{ filename: `${home}/project/src/lib/state-manager.ts` }],
              },
            },
          ],
        },
        breadcrumbs: [{ message: `loading config from ${home}/.sonar` }],
        extra: { configPath: `${home}/.sonar/state.json` },
      };
      const result = beforeSend(event, {});

      expect(result.exception!.values![0].value).toBe(
        "ENOENT: no such file or directory '~/.sonar/state.json'",
      );
      expect(result.exception!.values![0].stacktrace!.frames![0].filename).toBe(
        '~/project/src/lib/state-manager.ts',
      );
      expect(result.breadcrumbs![0].message).toBe('loading config from ~/.sonar');
      expect((result.extra as Record<string, string>).configPath).toBe('~/.sonar/state.json');
    });
  });

  describe('exception.value scrubbing', () => {
    it('replaces the home directory with ~ in the exception message', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const event = makeErrorEvent([[]], [`ENOENT: no such file or directory '${homedir()}/foo'`]);
      const result = beforeSend(event, {});

      expect(result.exception!.values![0].value).toBe("ENOENT: no such file or directory '~/foo'");
    });

    it('leaves exception messages without the home directory unchanged', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const event = makeErrorEvent([[]], ['something went wrong']);
      const result = beforeSend(event, {});

      expect(result.exception!.values![0].value).toBe('something went wrong');
    });

    it('handles exceptions with no value without throwing', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const event = makeErrorEvent([[]], [undefined]);

      expect(() => beforeSend(event, {})).not.toThrow();
    });
  });

  describe('breadcrumb scrubbing', () => {
    it('replaces the home directory with ~ in breadcrumb messages', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const event = makeEventWithBreadcrumbs([`read file ${homedir()}/config.json`]);
      const result = beforeSend(event, {});

      expect(result.breadcrumbs![0].message).toBe('read file ~/config.json');
    });

    it('scrubs all breadcrumbs in the event', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const home = homedir();
      const event = makeEventWithBreadcrumbs([`${home}/a`, `${home}/b`]);
      const result = beforeSend(event, {});

      expect(result.breadcrumbs![0].message).toBe('~/a');
      expect(result.breadcrumbs![1].message).toBe('~/b');
    });

    it('handles breadcrumbs with no message without throwing', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      const event = makeEventWithBreadcrumbs([undefined]);

      expect(() => beforeSend(event, {})).not.toThrow();
    });

    it('handles events with no breadcrumbs without throwing', () => {
      initSentry(getDefaultState('1.0.0'));
      const beforeSend = captureBeforeSend();

      expect(() => beforeSend({ type: undefined }, {})).not.toThrow();
    });
  });
});
