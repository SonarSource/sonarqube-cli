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
 * File-only logger — writes all levels to ~/.sonar/sonarqube-cli/logs/sonarqube-cli.log
 * No stdout/stderr output; terminal output is handled by src/ui/
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { LOG_DIR, LOG_FILE } from './config-constants.js';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

type LogFunction = (message: string, ...args: unknown[]) => void;

export interface LoggerInterface {
  debug: LogFunction;
  info: LogFunction;
  log: LogFunction;
  success: LogFunction;
  warn: LogFunction;
  error: LogFunction;
}

interface LoggerConfig {
  level: LogLevel;
}

let config: LoggerConfig = {
  level: (process.env.LOG_LEVEL as LogLevel) || 'INFO',
};


let logDirCreated = false;

function ensureLogDir(): void {
  if (!logDirCreated) {
    mkdirSync(LOG_DIR, { recursive: true });
    logDirCreated = true;
  }
}

function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  if (envLevel && envLevel in LOG_LEVELS) return envLevel;
  return config.level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()];
}

function serializeArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

function writeToFile(level: LogLevel, message: string, args: unknown[]): void {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const extra = serializeArgs(args);
    appendFileSync(LOG_FILE, `[${timestamp}] [${level}] ${message}${extra}\n`, 'utf-8');
  } catch {
    // Silently ignore — file logging must not crash the CLI
  }
}

class DefaultLogger implements LoggerInterface {
  debug(message: string, ...args: unknown[]): void { writeToFile('DEBUG', message, args); }
  info(message: string, ...args: unknown[]): void  { writeToFile('INFO',  message, args); }
  log(message: string, ...args: unknown[]): void   { writeToFile('INFO',  message, args); }
  success(message: string, ...args: unknown[]): void { writeToFile('INFO', message, args); }
  warn(message: string, ...args: unknown[]): void  { writeToFile('WARN',  message, args); }
  error(message: string, ...args: unknown[]): void { writeToFile('ERROR', message, args); }
}

class Logger {
  private impl: LoggerInterface = new DefaultLogger();

  setImplementation(impl: LoggerInterface): void { this.impl = impl; }

  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('DEBUG')) this.impl.debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) this.impl.info(message, ...args);
  }
  log(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) this.impl.log(message, ...args);
  }
  success(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) this.impl.success(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('WARN')) this.impl.warn(message, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('ERROR')) this.impl.error(message, ...args);
  }
}

const logger = new Logger();

export function configureLogger(newConfig: Partial<LoggerConfig>): void {
  config = { ...config, ...newConfig };
}

export function setMockLogger(mock: LoggerInterface | null): void {
  logger.setImplementation(mock ?? new DefaultLogger());
}

export function getLogLevelConfig(): LogLevel {
  return getLogLevel();
}

export default logger;
