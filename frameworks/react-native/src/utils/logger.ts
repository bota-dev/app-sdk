import type { LogLevel } from '../models/Status';

export type SdkLogLevel = Exclude<LogLevel, 'none'>;

export interface SdkLogEntry {
  level: SdkLogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: Date;
}

export type LogHandler = (entry: SdkLogEntry) => void;
