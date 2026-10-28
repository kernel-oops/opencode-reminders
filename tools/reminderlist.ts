import type { State } from "../types"
import DESCRIPTION from "./reminderlist.txt"
import type { ToolInfo } from "./tool"

export function createReminderListTool(state: State): ToolInfo<Record<string, never>> {
  return {
    name: "reminderlist",
    description: DESCRIPTION,
    input: { type: "object", properties: {}, additionalProperties: false },

    async execute(_args, context) {
      const reminders = Array.from(state.reminders.values()).filter(
        (r) => r.sessionID === context.sessionID && r.status !== "cancelled",
      )

      if (reminders.length === 0) {
        return { content: "No reminders in this session.", metadata: { title: "📋 No reminders", count: 0 } }
      }

      const output = reminders
        .map((r) => {
          const nextIn = Math.round((r.time.nextExecution - Date.now()) / 1000)
          const nextText = nextIn > 0 ? `in ${nextIn}s` : "overdue"
          const failures = r.consecutiveFailures ? `, ${r.consecutiveFailures} consecutive failed turn${r.consecutiveFailures === 1 ? "" : "s"}` : ""
          return `- ${r.userDescription} [${r.id}] (${r.execution ?? "action"}, ${r.type}, ${r.status === "paused" ? `paused: ${r.pauseReason ?? "unspecified"}` : `next execution ${nextText}`}${failures})`
        })
        .join("\n")

      return {
        content: `Reminders:\n${output}`,
        metadata: {
          title: `📋 ${reminders.length} reminder${reminders.length === 1 ? "" : "s"}`,
          count: reminders.length,
          reminders: reminders.map((r) => ({
            id: r.id,
            description: r.userDescription,
            type: r.type,
            status: r.status,
            execution: r.execution ?? "action",
            pauseReason: r.pauseReason,
            consecutiveFailures: r.consecutiveFailures ?? 0,
            nextExecutionIn: Math.round((r.time.nextExecution - Date.now()) / 1000),
          })),
        },
      }
    },
  }
}
