import { logger } from "./logger"
import type { State, PluginConfig } from "./types"
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, ReminderSchema } from "./types"
import { createHost, type PluginContextLike, type ReminderHost } from "./host"
import { getStorageDir, listReminders } from "./storage"
import {
  beginSchedulerGeneration,
  isSchedulerGenerationCurrent,
  waitForSchedulerMutations,
  scheduleTimer,
  cancelReminder,
  cleanupReminderSnapshot,
} from "./scheduler"
import { createReminderAddTool } from "./tools/reminderadd"
import { createReminderListTool } from "./tools/reminderlist"
import { createReminderPauseTool } from "./tools/reminderpause"
import { createReminderRemoveTool } from "./tools/reminderremove"
import type { ToolInfo } from "./tools/tool"

type ToolEditor = { add(tool: ToolInfo): void }
type PluginContext = PluginContextLike & {
  options?: Record<string, unknown>
  tool: { transform(callback: (editor: ToolEditor) => void): Promise<unknown> }
}

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  max_reminders_per_project: 50,
  min_interval_seconds: 30,
  max_consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
}

function readConfig(options: Record<string, unknown> | undefined): PluginConfig {
  const config = { ...DEFAULT_CONFIG }
  if (!options) return config
  if (typeof options.enabled === "boolean") config.enabled = options.enabled
  if (typeof options.max_reminders_per_project === "number" && options.max_reminders_per_project > 0) {
    config.max_reminders_per_project = Math.floor(options.max_reminders_per_project)
  }
  if (typeof options.min_interval_seconds === "number" && options.min_interval_seconds >= 30) {
    config.min_interval_seconds = Math.floor(options.min_interval_seconds)
  }
  if (typeof options.max_consecutive_failures === "number" && options.max_consecutive_failures >= 1) {
    config.max_consecutive_failures = Math.floor(options.max_consecutive_failures)
  }
  return config
}

function isSafeRestoredReminder(reminder: { id: string; time: { nextExecution: number; created: number } }): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reminder.id)
    && Number.isSafeInteger(reminder.time.created)
    && Number.isSafeInteger(reminder.time.nextExecution)
}

/** Restore persisted reminders for the host's project. Exported for tests. */
export async function restoreReminders(host: ReminderHost, state: State, config: PluginConfig, generation: string) {
  const gracePeriod = 60 * 60 * 1000
  const now = Date.now()
  const counts = { restored: 0, expired: 0, invalid: 0 }

  if (!(await waitForSchedulerMutations(host, generation))) return false
  const storedReminders = await listReminders(host)
  if (!isSchedulerGenerationCurrent(host, generation)) return false

  for (const snapshot of storedReminders) {
    if (!isSchedulerGenerationCurrent(host, generation)) return false
    const parsed = ReminderSchema.safeParse(snapshot)
    // Persisted filenames are derived from IDs. Only generated UUID snapshots with safe
    // timestamps may be re-opened or cleaned; malformed files are left for manual repair.
    if (!parsed.success || !isSafeRestoredReminder(parsed.data)) {
      logger.error(`[RemindersPlugin] Invalid restored reminder left untouched`)
      counts.invalid++
      continue
    }
    const reminder = parsed.data
    try {
      if (reminder.status === "paused") {
        // Includes reminders paused automatically after repeated failed turns; they keep
        // their reason and failure count and never resume on their own.
        state.reminders.set(reminder.id, reminder)
        continue
      }
      if (reminder.status !== "active") continue
      if (reminder.time.nextExecution + gracePeriod < now) {
        if (await cleanupReminderSnapshot(reminder, host, state, config)) {
          logger.info(`[RemindersPlugin] Reminder ${reminder.id} expired, removing`)
          counts.expired++
        }
        if (!isSchedulerGenerationCurrent(host, generation)) return false
        continue
      }

      // An active reminder keeps its consecutive failure count across restarts, so a
      // reload between failed turns cannot reset the pause threshold.
      state.reminders.set(reminder.id, reminder)
      const scheduled = await scheduleTimer(reminder, host, state, config, { persist: false, skipOverdue: true })
      if (!isSchedulerGenerationCurrent(host, generation)) return false

      if (scheduled && state.timers.has(reminder.id)) {
        counts.restored++
        logger.info(`[RemindersPlugin] Restored and validated reminder ${reminder.id}`)
      } else {
        await cleanupReminderSnapshot(reminder, host, state, config)
        state.reminders.delete(reminder.id)
        counts.invalid++
        logger.error(`[RemindersPlugin] Timer restoration failed for ${reminder.id}, cancelled reminder`)
      }
    } catch (error) {
      logger.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      await cleanupReminderSnapshot(reminder, host, state, config)
      counts.invalid++
    }
  }

  logger.info(
    `[RemindersPlugin] Timer persistence validation completed: ${storedReminders.length} total, ${counts.restored} restored, ${counts.expired} expired, ${counts.invalid} invalid`,
  )
  return true
}

export function createTools(host: ReminderHost, state: State, getConfig: () => PluginConfig): ToolInfo[] {
  return [
    createReminderPauseTool(host, state),
    createReminderAddTool(host, state, getConfig),
    createReminderListTool(state),
    createReminderRemoveTool(host, state, getConfig),
  ]
}

const RemindersPlugin = {
  id: "opencode-reminders",
  async setup(ctx: PluginContext) {
    const config = readConfig(ctx.options)
    const state: State = { reminders: new Map(), timers: new Map(), projectID: ctx.location.project.id }
    const tracker = createHost(ctx, async (event) => {
      if (event.type !== "session.deleted") return
      const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
      if (!sessionID) return
      logger.info(`[RemindersPlugin] Session ${sessionID} deleted, cleaning up reminders`)
      let cancelled = 0
      for (const reminder of Array.from(state.reminders.values()).filter((r) => r.sessionID === sessionID)) {
        if (await cancelReminder(reminder.id, host, state, config)) cancelled++
      }
      logger.info(`[RemindersPlugin] Cancelled ${cancelled} reminders for session ${sessionID}`)
    })
    const host = tracker.host
    const generation = beginSchedulerGeneration(host)
    state.generation = generation
    logger.info(`[RemindersPlugin] Initialising for project ${host.projectID}`)

    const cleanup = async () => {
      tracker.stop()
      // A replacement generation clears timers and aborts active executions from this instance.
      if (isSchedulerGenerationCurrent(host, generation)) beginSchedulerGeneration(host)
      await tracker.done.catch(() => {})
    }

    if (!config.enabled) {
      logger.info("[RemindersPlugin] Disabled by plugin options")
      return cleanup
    }

    await getStorageDir(host)
    if (!(await restoreReminders(host, state, config, generation))) return cleanup

    const tools = createTools(host, state, () => config)
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)
    })
    return cleanup
  },
}

export default RemindersPlugin
