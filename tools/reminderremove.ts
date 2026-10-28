import type { ReminderHost } from "../host"
import type { PluginConfig, State } from "../types"
import { cancelReminder } from "../scheduler"
import DESCRIPTION from "./reminderremove.txt"
import { logger } from "../logger"
import type { ToolInfo } from "./tool"

export function createReminderRemoveTool(
  host: ReminderHost,
  state: State,
  getConfig: () => PluginConfig,
): ToolInfo<{ description_pattern: string }> {
  return {
    name: "reminderremove",
    description: DESCRIPTION,
    input: {
      type: "object",
      properties: {
        description_pattern: {
          type: "string",
          description: "What the user wants to stop (will match against reminder descriptions)",
        },
      },
      required: ["description_pattern"],
      additionalProperties: false,
    },

    async execute(args, context) {
      const reminders = Array.from(state.reminders.values()).filter(
        (r) => r.sessionID === context.sessionID && r.status !== "cancelled",
      )

      const pattern = String(args.description_pattern ?? "").toLowerCase()
      const matches = reminders.filter(
        (r) => r.userDescription.toLowerCase().includes(pattern) || r.originalPrompt.toLowerCase().includes(pattern),
      )

      if (matches.length === 0) {
        const activeList = reminders.map((r) => `- ${r.userDescription}`).join("\n") || "None"
        return { content: `No matching reminder found for "${args.description_pattern}". Active reminders:\n${activeList}` }
      }

      const cancelledReminders = []
      for (const reminder of matches) {
        if (await cancelReminder(reminder.id, host, state, getConfig())) {
          cancelledReminders.push(reminder)
          logger.info(`[RemindersPlugin] Cancelled reminder ${reminder.id} via user request`)
        }
      }

      if (cancelledReminders.length === 0) {
        return { content: "Reminder scheduler reloaded while cancelling. Check active reminders before retrying." }
      }
      const metadata = {
        title: `🗑️ ${cancelledReminders.length} reminder${cancelledReminders.length === 1 ? "" : "s"} cancelled`,
        count: cancelledReminders.length,
        cancelled: cancelledReminders.map((r) => ({ id: r.id, description: r.userDescription })),
      }
      if (cancelledReminders.length === 1) {
        return { content: `Reminder cancelled: ${cancelledReminders[0].userDescription}`, metadata }
      }
      const cancelledList = cancelledReminders.map((r) => `- ${r.userDescription}`).join("\n")
      return { content: `${cancelledReminders.length} reminders cancelled:\n${cancelledList}`, metadata }
    },
  }
}
