import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import logger, {
  configureLogger,
  setMockLogger,
  getLogLevelConfig,
  type LogLevel,
} from '../../src/lib/logger';

describe('Logger', () => {
  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];

    const mockLogger = {
      debug: (msg: string) => logOutput.push(`[DEBUG] ${msg}`),
      info: (msg: string) => logOutput.push(`[INFO] ${msg}`),
      log: (msg: string) => logOutput.push(`[LOG] ${msg}`),
      success: (msg: string) => logOutput.push(`[SUCCESS] ${msg}`),
      warn: (msg: string) => errorOutput.push(`[WARN] ${msg}`),
      error: (msg: string) => errorOutput.push(`[ERROR] ${msg}`),
    };

    setMockLogger(mockLogger);
  });

  afterEach(() => {
    setMockLogger(null);
    configureLogger({ level: 'INFO' });
  });

  it('should log info messages', () => {
    logger.info('Test message');
    expect(logOutput).toContain('[INFO] Test message');
  });

  it('should log error messages', () => {
    logger.error('Error message');
    expect(errorOutput).toContain('[ERROR] Error message');
  });

  it('should log success messages', () => {
    logger.success('Success message');
    expect(logOutput).toContain('[SUCCESS] Success message');
  });

  it('should log warn messages', () => {
    logger.warn('Warning message');
    expect(errorOutput).toContain('[WARN] Warning message');
  });

  it('should log debug messages when DEBUG level is set', () => {
    configureLogger({ level: 'DEBUG' });
    logger.debug('Debug message');
    expect(logOutput).toContain('[DEBUG] Debug message');
  });

  it('should respect log level configuration', () => {
    configureLogger({ level: 'WARN' });
    logger.info('Info message');
    logger.warn('Warn message');

    expect(logOutput.some((m) => m.includes('Info message'))).toBe(false);
    expect(errorOutput.some((m) => m.includes('Warn message'))).toBe(true);
  });

  it('should return current log level', () => {
    configureLogger({ level: 'DEBUG' });
    expect(getLogLevelConfig()).toBe('DEBUG');

    configureLogger({ level: 'ERROR' });
    expect(getLogLevelConfig()).toBe('ERROR');
  });

  it('should support log as alias for info', () => {
    logger.log('Log message');
    expect(logOutput).toContain('[LOG] Log message');
  });

  it('should handle SILENT level', () => {
    configureLogger({ level: 'SILENT' });
    logger.error('Silent error');
    logger.info('Silent info');

    expect(logOutput.length).toBe(0);
    expect(errorOutput.length).toBe(0);
  });

  it('should accept multiple arguments', () => {
    const mockLogger2 = {
      debug: (msg: string, ..._args: unknown[]) => logOutput.push(msg),
      info: (msg: string, ..._args: unknown[]) => logOutput.push(msg),
      log: (msg: string, ..._args: unknown[]) => logOutput.push(msg),
      success: (msg: string, ..._args: unknown[]) => logOutput.push(msg),
      warn: (msg: string, ..._args: unknown[]) => errorOutput.push(msg),
      error: (msg: string, ..._args: unknown[]) => errorOutput.push(msg),
    };

    setMockLogger(mockLogger2);

    logger.info('Message', 'extra', 'args');
    expect(logOutput).toContain('Message');
  });
});
