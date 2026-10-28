import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/log")
const LOG_FILE = join(LOG_DIR, "reminders.log")

try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch (error) {}

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  ERROR = 2,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.ERROR]: "ERROR",
}

function getCurrentLevel(): LogLevel {
  switch (process.env.REMINDERS_LOG_LEVEL?.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG
    case "error":
      return LogLevel.ERROR
    default:
      return LogLevel.INFO
  }
}

function writeLog(level: LogLevel, message: string, args: any[]): void {
  if (level < getCurrentLevel()) return
  const formattedArgs =
    args.length > 0 ? ` ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}` : ""
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${LOG_LEVEL_NAMES[level]}] ${message}${formattedArgs}\n`, "utf-8")
  } catch (error) {}
}

export const logger = {
  debug: (message: string, ...args: any[]): void => writeLog(LogLevel.DEBUG, message, args),
  info: (message: string, ...args: any[]): void => writeLog(LogLevel.INFO, message, args),
  error: (message: string, ...args: any[]): void => writeLog(LogLevel.ERROR, message, args),
}
