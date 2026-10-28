import type { Reminder } from "./types"

// Preserve action-mode model resolution, agent and permissions. Do not migrate old records.
export function reminderPrompt(reminder: Reminder) {
  if (reminder.execution === "monitor" && !reminder.agent) {
    throw new Error("Monitor has no originating agent; refusing implicit agent selection")
  }
  const monitor = reminder.execution === "monitor"
  return {
    ...(reminder.agent === undefined ? {} : { agent: reminder.agent }),
    text: monitor
      ? [
          `[Scheduled bounded monitor ${reminder.id}]`,
          "Use only the concrete check below. Retain the originating agent's authority; do not delegate to another agent.",
          "Reuse known evidence and ownership. Do not rediscover history, spawn duplicate workers, redeploy, or start follow-on changes.",
          "If nothing relevant changed, reply only: No change. Do not repeat summaries or approval requests.",
          `If blocked on authorisation, call reminderpause with reminder_id=${reminder.id} and a concrete reason BEFORE reporting the blocker once. Do not request the same approval again.`,
          "Also pause if this check needs wider investigation or action beyond routine monitoring. Report the required next decision, without doing that work.",
          "No automatic resumption: wait for user authorisation or independently verified change in the blocking condition.",
          "Check:",
          reminder.originalPrompt,
        ].join("\n")
      : reminder.originalPrompt,
  }
}
