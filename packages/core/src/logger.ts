/**
 * Structured logger for distflow
 * Provides leveled, contextual logging with JSON output
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, any>;
  [key: string]: any;
}

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  context?: Record<string, any>;
  transport?: LogTransport;
  prettyPrint?: boolean;
}

export interface LogTransport {
  write(entry: LogEntry): void;
}

/**
 * Console transport with optional pretty printing
 */
class ConsoleTransport implements LogTransport {
  private prettyPrint: boolean;

  constructor(prettyPrint: boolean = false) {
    this.prettyPrint = prettyPrint;
  }

  write(entry: LogEntry): void {
    if (this.prettyPrint) {
      this.prettyWrite(entry);
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  private prettyWrite(entry: LogEntry): void {
    const levelColors: Record<string, string> = {
      DEBUG: '\x1b[36m', // Cyan
      INFO: '\x1b[32m',  // Green
      WARN: '\x1b[33m',  // Yellow
      ERROR: '\x1b[31m'  // Red
    };

    const reset = '\x1b[0m';
    const dim = '\x1b[2m';
    const color = levelColors[entry.level] || '';

    const time = dim + entry.timestamp + reset;
    const level = color + entry.level.padEnd(5) + reset;
    const name = entry.name ? dim + `[${entry.name}]` + reset : '';

    let output = `${time} ${level} ${name} ${entry.message}`;

    // Add context if present
    if (entry.context && Object.keys(entry.context).length > 0) {
      output += dim + ' ' + JSON.stringify(entry.context) + reset;
    }

    // Add extra fields (excluding standard ones)
    const standardFields = ['timestamp', 'level', 'message', 'context', 'name'];
    const extraFields: Record<string, any> = {};

    for (const [key, value] of Object.entries(entry)) {
      if (!standardFields.includes(key)) {
        extraFields[key] = value;
      }
    }

    if (Object.keys(extraFields).length > 0) {
      output += dim + ' ' + JSON.stringify(extraFields) + reset;
    }

    console.log(output);
  }
}

/**
 * Logger instance
 */
export class Logger {
  private level: LogLevel;
  private name?: string;
  private context: Record<string, any>;
  private transport: LogTransport;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.name = options.name;
    this.context = options.context ?? {};
    this.transport = options.transport ?? new ConsoleTransport(options.prettyPrint ?? true);
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, any>): Logger {
    return new Logger({
      level: this.level,
      name: this.name,
      context: { ...this.context, ...context },
      transport: this.transport,
      prettyPrint: false // Transport is already configured
    });
  }

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Add persistent context
   */
  addContext(context: Record<string, any>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Log at DEBUG level
   */
  debug(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  /**
   * Log at INFO level
   */
  info(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  /**
   * Log at WARN level
   */
  warn(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  /**
   * Log at ERROR level
   */
  error(message: string, error?: Error | Record<string, any>): void {
    const meta = error instanceof Error
      ? {
          error: error.message,
          stack: error.stack,
          name: error.name
        }
      : error;
    this.log(LogLevel.ERROR, message, meta);
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    if (level < this.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
      ...(this.name && { name: this.name }),
      ...(Object.keys(this.context).length > 0 && { context: this.context }),
      ...meta
    };

    this.transport.write(entry);
  }
}

/**
 * Global logger instance
 */
let globalLogger: Logger | null = null;

/**
 * Configure the global logger
 */
export function configureLogger(options: LoggerOptions): Logger {
  globalLogger = new Logger(options);
  return globalLogger;
}

/**
 * Get or create the global logger
 */
export function getLogger(name?: string): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({
      prettyPrint: process.env.NODE_ENV !== 'production',
      level: process.env.LOG_LEVEL
        ? LogLevel[process.env.LOG_LEVEL.toUpperCase() as keyof typeof LogLevel]
        : LogLevel.INFO
    });
  }

  if (name) {
    return globalLogger.child({ component: name });
  }

  return globalLogger;
}

/**
 * Create a custom transport
 */
export function createTransport(writeFn: (entry: LogEntry) => void): LogTransport {
  return { write: writeFn };
}
