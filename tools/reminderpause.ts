import type { ReminderHost } from "../host"
import type { State } from "../types"
import { pauseReminder } from "../scheduler"
import type { ToolInfo } from "./tool"

export function createReminderPauseTool(host: ReminderHost, state: State): ToolInfo<{ reminder_id: string; reason: string }> {
  return {
    name: "reminderpause",
    description:
      "Suspend an exact reminder in this session when blocked on authorisation or needing wider work. Call BEFORE reporting the blocker once. Persisted across reloads; never resumes automatically. After user authorisation or a verified changed blocking condition, explicitly remove and recreate it. Does not grant permission or cancel an already running action.",
    input: {
      type: "object",
      properties: {
        reminder_id: { type: "string", description: "Exact reminder ID from the monitor prompt or reminderlist" },
        reason: { type: "string", minLength: 1, description: "Concrete blocking condition; report it once, not on every tick" },
      },
      required: ["reminder_id", "reason"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const reason = String(args.reason ?? "")
      if (!reason) return { content: "Reminder not suspended: a concrete reason is required." }
      const paused = await pauseReminder(String(args.reminder_id), context.sessionID, reason, host, state)
      return {
        content: paused
          ? `Reminder suspended: ${args.reminder_id}. No more scheduled checks; report the blocker once.`
          : "Reminder not suspended: not found in this session or scheduler reloaded. Check reminderlist before retrying.",
      }
    },
  }
}
