import type { LogLevel } from './config.ts';

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(event: string, data?: Readonly<Record<string, unknown>>): void;
  info(event: string, data?: Readonly<Record<string, unknown>>): void;
  warn(event: string, data?: Readonly<Record<string, unknown>>): void;
  error(event: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /(token|cookie|authorization|prompt|answer|body|secret|password)/i;

function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]),
    );
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const write = (
    level: LogLevel,
    event: string,
    data: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.level]) {
      return;
    }
    const record: LogRecord = {
      time: now().toISOString(),
      level,
      event,
      ...redact(data) as Record<string, unknown>,
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}

