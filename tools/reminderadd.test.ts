import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { cancelReminder, pauseReminder } from "../scheduler"
import { createReminderAddTool } from "./reminderadd"
import type { PluginConfig } from "../types"
import { createFakeHost, createState } from "../test-host"

const config: PluginConfig = { enabled: true, max_reminders_per_project: 50, min_interval_seconds: 30 }

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("reminderadd captures the invoking agent", async () => {
  const host = await createFakeHost()
  directories.push(host.directory)
  const state = createState(host.projectID)
  const reminderadd = createReminderAddTool(host, state, () => config)

  const result = await reminderadd.execute(
    { interval_seconds: 30, type: "one-time", action_prompt: "test action", description: "test reminder" },
    { agent: "agent-a", sessionID: crypto.randomUUID() },
  )

  const reminder = Array.from(state.reminders.values())[0]
  if (!reminder) throw new Error("Expected reminderadd to create a reminder")
  expect(reminder.agent).toBe("agent-a")
  expect(result.metadata).toMatchObject({ title: "⏰ One-time reminder set", reminderID: reminder.id, description: "test reminder", type: "one-time" })
  expect(JSON.parse(await Bun.file(path.join(host.directory, ".opencode", "reminders", host.projectID, `${reminder.id}.json`)).text()))
    .toMatchObject({ agent: "agent-a" })
  await cancelReminder(reminder.id, host, state, config)
})

test("reminderadd enforces the minimum interval", async () => {
  const host = await createFakeHost()
  directories.push(host.directory)
  const state = createState(host.projectID)
  const reminderadd = createReminderAddTool(host, state, () => config)
  const result = await reminderadd.execute(
    { interval_seconds: 5, type: "one-time", action_prompt: "test action", description: "too fast" },
    { agent: "build", sessionID: crypto.randomUUID() },
  )
  expect(result.content).toContain("at least 30")
  expect(state.reminders.size).toBe(0)
})

test("explicit monitor mode persists, rejects duplicate/paused work and unknown authority", async () => {
  const host = await createFakeHost()
  directories.push(host.directory)
  const state = createState(host.projectID)
  const add = createReminderAddTool(host, state, () => config)
  const context = { agent: "build", sessionID: crypto.randomUUID() }
  const args = {
    interval_seconds: 30, type: "recurring" as const, execution: "monitor" as const,
    action_prompt: "Read /tmp/status once", description: "Status check",
  }
  expect((await add.execute(args, { ...context, agent: "" })).content).toContain("without a known originating agent")
  expect(state.reminders.size).toBe(0)
  expect((await add.execute(args, context)).content).toContain("no cheaper-model guarantee")
  const reminder = Array.from(state.reminders.values())[0]!
  expect(reminder.execution).toBe("monitor")
  expect(reminder.agent).toBe("build")
  expect((await add.execute(args, context)).content).toContain("already active")
  await pauseReminder(reminder.id, context.sessionID, "Approval required", host, state)
  expect((await add.execute(args, context)).content).toContain("already paused")
  expect(state.reminders.size).toBe(1)
  expect(state.timers.size).toBe(0)
  await cancelReminder(reminder.id, host, state, config)
})
