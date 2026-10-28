export type Reminder = {
  id: string
  sessionID: string
  projectID: string
  type: "one-time" | "recurring"
  interval: number
  originalPrompt: string
  userDescription: string
  agent?: string
  execution?: "action" | "monitor"
  pauseReason?: string
  /**
   * Consecutive failed turns of a recurring action reminder. Absent (or 0) after a
   * successful turn; older snapshots without the field read as 0.
   */
  consecutiveFailures?: number
  time: {
    created: number
    nextExecution: number
    lastExecution?: number
  }
  status: "active" | "paused" | "cancelled"
}

export type State = {
  reminders: Map<string, Reminder>
  timers: Map<string, NodeJS.Timeout>
  projectID: string
  generation?: string
}

export type PluginConfig = {
  enabled: boolean
  max_reminders_per_project: number
  min_interval_seconds: number
  /** Consecutive failed turns before a recurring action reminder is paused (default 5). */
  max_consecutive_failures?: number
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5

export function maxConsecutiveFailures(config: PluginConfig): number {
  const value = config.max_consecutive_failures
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_MAX_CONSECUTIVE_FAILURES
}

type ParseResult = { success: true; data: Reminder } | { success: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isString = (value: unknown): value is string => typeof value === "string"
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const optionalString = (value: unknown) => value === undefined || isString(value)
const optionalCount = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  isString(value) && (options as readonly string[]).includes(value)

// Hand-written validation replaces Zod so the plugin has no runtime dependencies.
export const ReminderSchema = {
  safeParse(value: unknown): ParseResult {
    if (!isRecord(value)) return { success: false, error: "reminder must be an object" }
    const time = value.time
    if (
      !isString(value.id) ||
      !isString(value.sessionID) ||
      !isString(value.projectID) ||
      !oneOf(value.type, ["one-time", "recurring"]) ||
      !isNumber(value.interval) ||
      !isString(value.originalPrompt) ||
      !isString(value.userDescription) ||
      !optionalString(value.agent) ||
      !(value.execution === undefined || oneOf(value.execution, ["action", "monitor"])) ||
      !optionalString(value.pauseReason) ||
      !optionalCount(value.consecutiveFailures) ||
      !oneOf(value.status, ["active", "paused", "cancelled"]) ||
      !isRecord(time) ||
      !isNumber(time.created) ||
      !isNumber(time.nextExecution) ||
      !(time.lastExecution === undefined || isNumber(time.lastExecution))
    )
      return { success: false, error: "reminder has an invalid shape" }
    const data: Reminder = {
      id: value.id,
      sessionID: value.sessionID,
      projectID: value.projectID,
      type: value.type,
      interval: value.interval,
      originalPrompt: value.originalPrompt,
      userDescription: value.userDescription,
      ...(value.agent === undefined ? {} : { agent: value.agent }),
      ...(value.execution === undefined ? {} : { execution: value.execution }),
      ...(value.pauseReason === undefined ? {} : { pauseReason: value.pauseReason }),
      ...(value.consecutiveFailures === undefined || value.consecutiveFailures === 0
        ? {}
        : { consecutiveFailures: value.consecutiveFailures as number }),
      time: {
        created: time.created,
        nextExecution: time.nextExecution,
        ...(time.lastExecution === undefined ? {} : { lastExecution: time.lastExecution }),
      },
      status: value.status,
    }
    return { success: true, data }
  },
  parse(value: unknown): Reminder {
    const result = ReminderSchema.safeParse(value)
    if (!result.success) throw new Error(result.error)
    return result.data
  },
}
