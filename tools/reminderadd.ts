import type { ReminderHost } from "../host"
import type { Reminder, State, PluginConfig } from "../types"
import { scheduleTimer } from "../scheduler"
import DESCRIPTION from "./reminderadd.txt"
import { logger } from "../logger"
import type { ToolInfo } from "./tool"

export type ReminderAddInput = {
  execution?: "action" | "monitor"
  interval_seconds: number
  type: "one-time" | "recurring"
  action_prompt: string
  description: string
}

export function createReminderAddTool(
  host: ReminderHost,
  state: State,
  getConfig: () => PluginConfig,
): ToolInfo<ReminderAddInput> {
  return {
    name: "reminderadd",
    description: DESCRIPTION,
    input: {
      type: "object",
      properties: {
        execution: {
          type: "string",
          enum: ["action", "monitor"],
          description:
            "Default action preserves normal execution. Opt into monitor only for an authorised bounded routine check: original agent default model/session/permissions; no cheaper-model guarantee; no automatic follow-on work. Never classify arbitrary scheduled actions as monitors.",
        },
        interval_seconds: { type: "number", minimum: 30, description: "Time interval in seconds (minimum 30)" },
        type: { type: "string", enum: ["one-time", "recurring"], description: "Whether this reminder runs once or repeatedly" },
        action_prompt: { type: "string", description: "Fully resolved action with absolute paths and specific identifiers" },
        description: { type: "string", description: "Human-readable description for identification" },
      },
      required: ["interval_seconds", "type", "action_prompt", "description"],
      additionalProperties: false,
    },

    async execute(args, context) {
      const config = getConfig()
      if (typeof args.interval_seconds !== "number" || args.interval_seconds < config.min_interval_seconds) {
        return { content: `interval_seconds must be at least ${config.min_interval_seconds}` }
      }
      if (args.execution === "monitor" && !context.agent) {
        return { content: "Cannot create a monitor without a known originating agent. Use ordinary action execution." }
      }
      const duplicate = Array.from(state.reminders.values()).find((r) =>
        r.sessionID === context.sessionID && r.userDescription === args.description
        && r.originalPrompt === args.action_prompt && r.type === args.type
        && r.interval === args.interval_seconds * 1000
        && (r.execution ?? "action") === (args.execution ?? "action")
        && r.agent === context.agent,
      )
      if (args.execution === "monitor" && duplicate) {
        return { content: `Reminder already ${duplicate.status}: ${duplicate.userDescription} (${duplicate.id}). Do not start duplicate work. Paused reminders require fresh user authorisation or a verified changed blocking condition; remove and recreate explicitly.` }
      }
      const maxReminders = config.max_reminders_per_project
      const reminders = Array.from(state.reminders.values()).filter((r) => r.sessionID === context.sessionID)
      if (reminders.length >= maxReminders) {
        return { content: `Can't set more reminders, too many reminders already active (${reminders.length}/${maxReminders}). Current reminders:\n${reminders.map((r) => `- ${r.userDescription}`).join("\n")}` }
      }

      const reminder: Reminder = {
        id: crypto.randomUUID(),
        sessionID: context.sessionID,
        projectID: host.projectID,
        type: args.type,
        interval: args.interval_seconds * 1000,
        originalPrompt: args.action_prompt,
        userDescription: args.description,
        ...(context.agent ? { agent: context.agent } : {}),
        ...(args.execution ? { execution: args.execution } : {}),
        time: {
          created: Date.now(),
          nextExecution: Date.now() + args.interval_seconds * 1000,
        },
        status: "active",
      }

      state.reminders.set(reminder.id, reminder)
      if (!(await scheduleTimer(reminder, host, state, config))) {
        return { content: "Reminder scheduler reloaded while setting the reminder. Check active reminders before retrying." }
      }

      logger.info(`[RemindersPlugin] Created ${args.type} reminder ${reminder.id}: ${args.description}`)

      return {
        content: `Reminder set: ${args.description} (${args.type === "one-time" ? "in" : "every"} ${args.interval_seconds} seconds)${args.execution === "monitor" ? "; bounded monitor: original agent/model resolution and full session retained; no cheaper-model guarantee" : ""}`,
        metadata: {
          title: `${args.type === "one-time" ? "⏰ One-time" : "🔄 Recurring"} reminder set`,
          reminderID: reminder.id,
          description: args.description,
          type: args.type,
          intervalSeconds: args.interval_seconds,
          nextExecutionIn: args.interval_seconds,
        },
      }
    },
  }
}
