import type { LogLevel } from '../models/Status';

export type SdkLogLevel = Exclude<LogLevel, 'none'>;

export interface SdkLogEntry {
  level: SdkLogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: Date;
}

export type LogHandler = (entry: SdkLogEntry) => void;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

class Logger {
  private level: LogLevel = 'warn';
  private readonly prefix = '[Bota SDK]';
  private handler: LogHandler | null = null;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setHandler(handler: LogHandler | null): void {
    this.handler = handler;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    this.write(
      'error',
      message,
      error
        ? { ...context, error: error.message, stack: error.stack }
        : context
    );
  }

  tag(tag: string): TaggedLogger {
    return new TaggedLogger(this, tag);
  }

  private write(
    level: SdkLogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;
    if (this.handler) {
      this.handler({ level, message, context, timestamp: new Date() });
      return;
    }
    const output = this.format(level, message, context);
    console[level](output);
  }

  private format(
    level: SdkLogLevel,
    message: string,
    context?: Record<string, unknown>
  ): string {
    const contextValue = context ? ` ${JSON.stringify(context)}` : '';
    return `${new Date().toISOString()} ${this.prefix} [${level.toUpperCase()}] ${message}${contextValue}`;
  }
}

class TaggedLogger {
  constructor(
    private readonly parent: Logger,
    private readonly tagValue: string
  ) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.parent.debug(`[${this.tagValue}] ${message}`, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.parent.info(`[${this.tagValue}] ${message}`, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.parent.warn(`[${this.tagValue}] ${message}`, context);
  }

  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    this.parent.error(`[${this.tagValue}] ${message}`, error, context);
  }
}

export const logger = new Logger();

export type { TaggedLogger };
