/**
 * Centralized logger for the CLI
 * Provides consistent logging across the application
 */

/**
 * Log levels with numeric priority (higher = less verbose)
 */
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

/**
 * Log level type - derived from LOG_LEVELS object keys
 */
export type LogLevel = keyof typeof LOG_LEVELS;

interface LoggerConfig {
  level: LogLevel;
  useColor: boolean;
}

type LogFunction = (message: string, ...args: unknown[]) => void;

export interface LoggerInterface {
  debug: LogFunction;
  info: LogFunction;
  log: LogFunction;
  success: LogFunction;
  warn: LogFunction;
  error: LogFunction;
}

let config: LoggerConfig = {
  level: (process.env.LOG_LEVEL as LogLevel) || 'INFO',
  useColor: true,
};

/**
 * Get log level from environment or config
 */
function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel;
  }
  return config.level;
}

/**
 * Check if message should be logged
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()];
}

/**
 * Format log message
 */
function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}`;
}

/**
 * Default logger implementation
 */
class DefaultLogger implements LoggerInterface {
  debug(message: string, ...args: unknown[]): void {
    process.stderr.write(formatMessage('DEBUG', message) + '\n');
    if (args.length > 0) {
      console.debug(...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    process.stdout.write(message + '\n');
    if (args.length > 0) {
      console.info(...args);
    }
  }

  log(message: string, ...args: unknown[]): void {
    this.info(message, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    const formattedMessage = `✅ ${message}`;
    process.stdout.write(formattedMessage + '\n');
    if (args.length > 0) {
      console.info(...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    const formattedMessage = `⚠️  ${message}`;
    process.stderr.write(formattedMessage + '\n');
    if (args.length > 0) {
      console.warn(...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    const formattedMessage = `❌ ${message}`;
    process.stderr.write(formattedMessage + '\n');
    if (args.length > 0) {
      console.error(...args);
    }
  }
}

/**
 * Logger wrapper - manages implementation and enforces log level filtering
 */
class Logger {
  private impl: LoggerInterface = new DefaultLogger();

  setImplementation(impl: LoggerInterface): void {
    this.impl = impl;
  }

  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('DEBUG')) {
      this.impl.debug(message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) {
      this.impl.info(message, ...args);
    }
  }

  log(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) {
      this.impl.log(message, ...args);
    }
  }

  success(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) {
      this.impl.success(message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('WARN')) {
      this.impl.warn(message, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (shouldLog('ERROR')) {
      this.impl.error(message, ...args);
    }
  }
}

/**
 * Main logger instance
 */
const logger = new Logger();

/**
 * Configure logger
 */
export function configureLogger(newConfig: Partial<LoggerConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Set mock logger for testing
 */
export function setMockLogger(mock: LoggerInterface | null): void {
  if (mock) {
    logger.setImplementation(mock);
  } else {
    logger.setImplementation(new DefaultLogger());
  }
}

/**
 * Get current log level
 */
export function getLogLevelConfig(): LogLevel {
  return getLogLevel();
}

/**
 * Export logger instance
 */
export default logger;
