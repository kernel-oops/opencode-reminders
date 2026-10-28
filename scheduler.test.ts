import { afterEach, expect, spyOn, test } from "bun:test"
import { rm } from "node:fs/promises"
import { executeReminder, pauseReminder, beginSchedulerGeneration, reconcileReminder, scheduleTimer } from "./scheduler"
import { saveReminder, loadReminder } from "./storage"
import { restoreReminders, createTools } from "./index"
import { ReminderSchema, type PluginConfig, type Reminder, type State } from "./types"
import { createFakeHost, createReminder, createState, matchedContext, nextMessageID, type FakeHost } from "./test-host"

const config: PluginConfig = { enabled: true, max_reminders_per_project: 50, min_interval_seconds: 30 }

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createFixture(type: Reminder["type"]) {
  const host = await createFakeHost()
  directories.push(host.directory)
  const state = createState(host.projectID)
  const reminder = createReminder(host.projectID, type)
  host.agents.set(reminder.sessionID, "build")
  state.reminders.set(reminder.id, reminder)
  return { host, state, reminder }
}

test("scheduler refuses a mismatched captured agent without switching or prompting", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.agent = "agent-a"
  let switches = 0
  host.session.switchAgent = async () => { switches++ }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(switches).toBe(0)
  expect(host.prompts).toHaveLength(0)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
})

test("scheduler does not switch the agent when it already matches", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.agent = "build"
  host.agents.set(reminder.sessionID, "build")
  let switched = 0
  host.session.switchAgent = async () => { switched++ }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(switched).toBe(0)
  expect(host.prompts).toHaveLength(1)
})

test("scheduler omits agent switching for legacy reminders", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  let switched = 0
  host.session.switchAgent = async () => { switched++ }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(switched).toBe(0)
  expect(host.prompts[0]).toMatchObject({ text: "test prompt" })
  expect("agents" in host.prompts[0]).toBe(false)
})

test("reminder schema accepts legacy records without an agent and rejects malformed ones", async () => {
  const { reminder } = await createFixture("one-time")
  expect(ReminderSchema.parse(reminder).agent).toBeUndefined()
  expect(ReminderSchema.safeParse({ ...reminder, status: "weird" }).success).toBe(false)
  expect(ReminderSchema.safeParse({ ...reminder, time: { created: "x", nextExecution: 1 } }).success).toBe(false)
})

for (const agent of ["build", "agent-b", "agent-a", "agent-c"]) {
  test(`monitor uses action model resolution without changing originating ${agent} authority`, async () => {
    const { host, state, reminder } = await createFixture("one-time")
    reminder.agent = agent
    host.agents.set(reminder.sessionID, agent)
    reminder.execution = "monitor"
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    const request = host.prompts[0]
    expect(request.sessionID).toBe(reminder.sessionID)
    expect(host.agents.get(reminder.sessionID)).toBe(agent)
    expect("model" in request).toBe(false)
    expect("variant" in request).toBe(false)
    expect(Object.keys(request).sort()).toEqual(["delivery", "id", "metadata", "sessionID", "text"])
    expect(request.delivery).toBe("queue")
    expect(await loadReminder(reminder.id, host)).toBeNull()
    expect(request.text).toContain("No change.")
    expect(request.text).toContain(`reminder_id=${reminder.id}`)
  })
}

// A pause from inside the prompt must survive the post-prompt recurring transition.
test("blocked monitor pauses durably during execution and never re-prompts", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.agent = "build"
  reminder.execution = "monitor"
  let calls = 0
  const prompt = host.session.prompt
  host.session.prompt = async (request) => {
    calls++
    expect(await pauseReminder(reminder.id, reminder.sessionID, "Needs approval", host, state)).toBe(true)
    return prompt(request)
  }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
  expect(state.reminders.get(reminder.id)?.pauseReason).toBe("Needs approval")
  expect(state.timers.size).toBe(0)
  await executeReminder(reminder, host, state, config)
  expect(calls).toBe(1)
  expect(await pauseReminder(reminder.id, reminder.sessionID, "Repeated approval", host, state)).toBe(true)
  expect((await loadReminder(reminder.id, host))?.pauseReason).toBe("Needs approval")
})

test("pause is session-scoped, unknown IDs cannot become paths", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  await saveReminder(reminder, host)
  expect(await pauseReminder(reminder.id, "other-session", "No", host, state)).toBe(false)
  expect(await pauseReminder("../../escape", reminder.sessionID, "No", host, state)).toBe(false)
  expect((await loadReminder(reminder.id, host))?.status).toBe("active")
})

test("paused snapshots restore after grace period without timers and can be listed/removed", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.status = "paused"
  reminder.pauseReason = "User approval"
  reminder.time.nextExecution = Date.now() - 86_400_000
  await saveReminder(reminder, host)
  const generation = beginSchedulerGeneration(host)
  const restored: State = { ...createState(host.projectID), generation }
  expect(await restoreReminders(host, restored, config, generation)).toBe(true)
  const tools = Object.fromEntries(createTools(host, restored, () => config).map((tool) => [tool.name, tool]))
  const context = { sessionID: reminder.sessionID, agent: "build" }
  const listing = await tools.reminderlist.execute({}, context)
  expect(listing.content).toContain("paused: User approval")
  expect(listing.content).toContain(reminder.id)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
  await tools.reminderremove.execute({ description_pattern: reminder.userDescription }, context)
  expect(await loadReminder(reminder.id, host)).toBeNull()
  beginSchedulerGeneration(host)
})

test("restore cleans expired active reminders and reschedules live ones", async () => {
  const { host, reminder } = await createFixture("recurring")
  reminder.time.nextExecution = Date.now() - 86_400_000
  await saveReminder(reminder, host)
  const live = createReminder(host.projectID, "one-time")
  live.time.nextExecution = Date.now() + 60_000
  await saveReminder(live, host)
  const generation = beginSchedulerGeneration(host)
  const restored: State = { ...createState(host.projectID), generation }
  expect(await restoreReminders(host, restored, config, generation)).toBe(true)
  expect(await loadReminder(reminder.id, host)).toBeNull()
  expect(restored.reminders.has(live.id)).toBe(true)
  expect(restored.timers.has(live.id)).toBe(true)
  beginSchedulerGeneration(host)
})

test("pause clears scheduled timer and stale reconciliation cannot resurrect it", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.time.nextExecution = Date.now() + 30_000
  await scheduleTimer(reminder, host, state, config)
  expect(state.timers.size).toBe(1)
  expect(await pauseReminder(reminder.id, reminder.sessionID, "Blocked", host, state)).toBe(true)
  await reconcileReminder(reminder.id, host, state, config)
  expect(state.timers.size).toBe(0)
  expect(state.reminders.get(reminder.id)?.status).toBe("paused")
  expect(await scheduleTimer(state.reminders.get(reminder.id)!, host, state, config)).toBe(false)
})

test("monitor with missing authority never calls the model", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.execution = "monitor"
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(host.prompts).toHaveLength(0)
})

test("persisted routing wins over stale timer snapshot", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.agent = "agent-a"
  await saveReminder({ ...reminder, agent: "build", execution: "monitor" }, host)
  await executeReminder(reminder, host, state, config)
  expect(host.agents.get(reminder.sessionID)).toBe("build")
  expect(host.prompts[0].text).toContain("[Scheduled bounded monitor")
})

for (const failure of ["throw", "wait-throw", "assistant-error"]) {
  test(`monitor ${failure} pauses rather than creating a paid retry loop`, async () => {
    const { host, state, reminder } = await createFixture("recurring")
    reminder.agent = "build"
    reminder.execution = "monitor"
    let calls = 0
    const prompt = host.session.prompt
    host.session.prompt = async (request) => {
      calls++
      if (failure === "throw") throw new Error("Model unavailable")
      return prompt(request)
    }
    if (failure === "wait-throw") host.session.wait = async () => { throw new Error("Unavailable") }
    if (failure === "assistant-error") {
      host.contextFor = (sessionID) => {
        const messages = matchedContext(host, sessionID)
        messages[1]!.error = { _tag: "ProviderError" }
        return messages
      }
    }
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
    expect(state.timers.size).toBe(0)
    await executeReminder(reminder, host, state, config)
    expect(calls).toBe(1)
  })
}

test("same occurrence lease prevents overlapping monitor prompts", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.agent = "build"
  reminder.execution = "monitor"
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  let calls = 0
  const prompt = host.session.prompt
  host.session.prompt = async (request) => { calls++; entered(); await gate; return prompt(request) }
  await saveReminder(reminder, host)
  const first = executeReminder(reminder, host, state, config)
  await started
  await executeReminder(reminder, host, state, config)
  release()
  await first
  expect(calls).toBe(1)
  await pauseReminder(reminder.id, reminder.sessionID, "Test complete", host, state)
  beginSchedulerGeneration(host)
})

for (const status of ["busy", "retry"] as const) {
  test(`monitor defers ${status} without submitting a prompt or recording completion`, async () => {
    const { host, state, reminder } = await createFixture("recurring")
    reminder.agent = "build"
    reminder.execution = "monitor"
    const occurrence = reminder.time.nextExecution
    host.statuses.set(reminder.sessionID, status)
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    const stored = await loadReminder(reminder.id, host)
    expect(host.prompts).toHaveLength(0)
    expect(stored?.status).toBe("active")
    expect(stored?.time.lastExecution).toBeUndefined()
    expect(stored!.time.nextExecution).toBeGreaterThan(occurrence)
    expect(state.timers.size).toBe(1)
    beginSchedulerGeneration(host)
  })
}

test("monitor with no observed status relies on durable queue admission", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.agent = "build"
  reminder.execution = "monitor"
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(host.prompts).toHaveLength(1)
  expect(host.prompts[0].delivery).toBe("queue")
  expect((await loadReminder(reminder.id, host))?.time.lastExecution).toBeDefined()
  beginSchedulerGeneration(host)
})

for (const failure of ["get-throw", "get-mismatch", "get-missing"]) {
  test(`monitor session verification ${failure} fails closed without a model call`, async () => {
    const { host, state, reminder } = await createFixture("recurring")
    reminder.agent = "build"
    reminder.execution = "monitor"
    host.session.get = async ({ sessionID }) => {
      if (failure === "get-throw") throw new Error("Not found")
      if (failure === "get-missing") return undefined
      return { id: `${sessionID}-other` }
    }
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    expect(host.prompts).toHaveLength(0)
    expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
    expect((await loadReminder(reminder.id, host))?.time.lastExecution).toBeUndefined()
    expect(state.timers.size).toBe(0)
  })
}

for (const mismatch of ["missing-user", "session", "role", "incomplete", "empty-context"]) {
  test(`monitor completion with ${mismatch} mismatch pauses without advancing the occurrence`, async () => {
    const { host, state, reminder } = await createFixture("recurring")
    reminder.agent = "build"
    reminder.execution = "monitor"
    const occurrence = reminder.time.nextExecution
    host.statuses.set(reminder.sessionID, "idle")
    host.contextFor = (sessionID) => {
      if (mismatch === "empty-context") return []
      const messages = matchedContext(host, sessionID)
      if (mismatch === "missing-user") messages[0]!.id = nextMessageID()
      if (mismatch === "role") messages[1]!.type = "synthetic"
      if (mismatch === "incomplete") messages[1]!.time = { created: Date.now() }
      return messages
    }
    if (mismatch === "session") {
      const prompt = host.session.prompt
      host.session.prompt = async (request) => ({ ...(await prompt(request))!, sessionID: "ses_other" })
    }
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    const stored = await loadReminder(reminder.id, host)
    expect(stored?.status).toBe("paused")
    expect(stored?.time.lastExecution).toBeUndefined()
    expect(stored?.time.nextExecution).toBe(occurrence)
    expect(state.timers.size).toBe(0)
  })
}

test("ordinary action does not inspect busy status", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.agent = "build"
  host.statuses.set(reminder.sessionID, "busy")
  host.status = () => { throw new Error("Must not inspect action status") }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(host.prompts[0]).toMatchObject({ sessionID: reminder.sessionID, text: reminder.originalPrompt, delivery: "queue" })
  expect(await loadReminder(reminder.id, host)).toBeNull()
})

test("pause during session verification prevents admission", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.agent = "build"
  reminder.execution = "monitor"
  const get = host.session.get
  host.session.get = async (input) => {
    await pauseReminder(reminder.id, reminder.sessionID, "Approval required", host, state)
    return get(input)
  }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(host.prompts).toHaveLength(0)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
})

test("a successful turn resets the consecutive failure count", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  reminder.consecutiveFailures = 4
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  const stored = await loadReminder(reminder.id, host)
  expect(stored?.status).toBe("active")
  expect(stored?.consecutiveFailures).toBeUndefined()
  expect(stored?.time.lastExecution).toBeNumber()
  beginSchedulerGeneration(host)
})

test("reminder schema keeps consecutive failures compatible with older snapshots", () => {
  const reminder = createReminder("project", "recurring")
  expect(ReminderSchema.safeParse(reminder).success).toBe(true)
  expect(ReminderSchema.parse({ ...reminder, consecutiveFailures: 2 }).consecutiveFailures).toBe(2)
  expect("consecutiveFailures" in ReminderSchema.parse({ ...reminder, consecutiveFailures: 0 })).toBe(false)
  expect(ReminderSchema.safeParse({ ...reminder, consecutiveFailures: -1 }).success).toBe(false)
  expect(ReminderSchema.safeParse({ ...reminder, consecutiveFailures: 1.5 }).success).toBe(false)
  expect(ReminderSchema.safeParse({ ...reminder, consecutiveFailures: "2" }).success).toBe(false)
})

test("restore keeps failure counts on active reminders and leaves failure-paused ones paused", async () => {
  const { host, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  reminder.consecutiveFailures = 2
  reminder.time.nextExecution = Date.now() + 60_000
  await saveReminder(reminder, host)
  const paused = createReminder(host.projectID, "recurring")
  paused.status = "paused"
  paused.consecutiveFailures = 5
  paused.pauseReason = "Paused automatically after 5 consecutive failed turns (last: Reminder turn failed)."
  paused.time.nextExecution = Date.now() - 86_400_000
  await saveReminder(paused, host)
  const generation = beginSchedulerGeneration(host)
  const restored: State = { ...createState(host.projectID), generation }
  expect(await restoreReminders(host, restored, config, generation)).toBe(true)
  expect(restored.reminders.get(reminder.id)?.consecutiveFailures).toBe(2)
  expect(restored.timers.has(reminder.id)).toBe(true)
  expect(restored.reminders.get(paused.id)?.status).toBe("paused")
  expect(restored.reminders.get(paused.id)?.consecutiveFailures).toBe(5)
  expect(restored.timers.has(paused.id)).toBe(false)
  expect((await loadReminder(paused.id, host))?.status).toBe("paused")
  beginSchedulerGeneration(host)
})


test("a long timer is clamped and re-armed when it fires before its due time", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.time.nextExecution = Date.now() + 30 * 24 * 60 * 60_000
  await scheduleTimer(reminder, host, state, config)
  const timer = state.timers.get(reminder.id)! as any
  expect(timer._idleTimeout).toBe(2_147_483_647)
  clearTimeout(timer)
  await timer._onTimeout()
  expect(host.prompts).toHaveLength(0)
  expect(state.timers.get(reminder.id)).toBeDefined()
  expect((await loadReminder(reminder.id, host))?.status).toBe("active")
  beginSchedulerGeneration(host)
})

test("a clamped timer executes only once the due time has arrived", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.time.nextExecution = Date.now() + 30 * 24 * 60 * 60_000
  await scheduleTimer(reminder, host, state, config)
  const timer = state.timers.get(reminder.id)! as any
  clearTimeout(timer)
  const clock = spyOn(Date, "now").mockReturnValue(reminder.time.nextExecution)
  try {
    await timer._onTimeout()
    expect(host.prompts).toHaveLength(1)
    expect(await loadReminder(reminder.id, host)).toBeNull()
  } finally {
    clock.mockRestore()
    beginSchedulerGeneration(host)
  }
})

test("a failed one-time action remains paused for inspection", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  host.session.prompt = async () => { throw new Error("Admission uncertain") }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
  expect(state.timers.size).toBe(0)
})

for (const mode of ["later-failure", "intervening-user", "later-incomplete"] as const) {
  test(`full turn ${mode} pauses without crediting completion`, async () => {
    const { host, state, reminder } = await createFixture("recurring")
    host.contextFor = (sessionID) => {
      const messages = matchedContext(host, sessionID)
      if (mode === "intervening-user") messages.push({ id: nextMessageID(), type: "user" })
      messages.push({ id: nextMessageID(), type: "assistant", time: mode === "later-incomplete" ? {} : { completed: Date.now() }, ...(mode === "later-failure" ? { error: { message: "failed" } } : {}) })
      return messages
    }
    await saveReminder(reminder, host)
    await executeReminder(reminder, host, state, config)
    const saved = await loadReminder(reminder.id, host)
    expect(saved?.status).toBe("paused")
    expect(saved?.time.lastExecution).toBeUndefined()
    expect(state.timers.size).toBe(0)
  })
}

test("reload after admission leaves the occurrence paused rather than replaying it", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  let entered!: () => void
  let release!: () => void
  const enteredWait = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  host.session.wait = async () => { entered(); await wait }
  await saveReminder(reminder, host)
  const running = executeReminder(reminder, host, state, config)
  await enteredWait
  expect(host.prompts).toHaveLength(1)
  const generation = beginSchedulerGeneration(host)
  const replacement: State = { ...createState(host.projectID), generation }
  expect(await restoreReminders(host, replacement, config, generation)).toBe(true)
  expect(replacement.reminders.get(reminder.id)?.status).toBe("paused")
  expect(replacement.timers.size).toBe(0)
  await executeReminder((await loadReminder(reminder.id, host))!, host, replacement, config)
  expect(host.prompts).toHaveLength(1)
  release()
  await running
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
  beginSchedulerGeneration(host)
})

test("a busy session with a different agent is never switched or prompted", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.agent = "agent-a"
  host.statuses.set(reminder.sessionID, "busy")
  let switches = 0
  host.session.switchAgent = async () => { switches++ }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(switches).toBe(0)
  expect(host.prompts).toHaveLength(0)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
})
