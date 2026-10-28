import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { executeReminder, isUsageLimitError, pauseReminder, beginSchedulerGeneration, reconcileReminder, scheduleTimer } from "./scheduler"
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
  state.reminders.set(reminder.id, reminder)
  return { host, state, reminder }
}

test("scheduler forwards a captured reminder agent by switching the session agent", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  reminder.agent = "agent-a"
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(host.agents.get(reminder.sessionID)).toBe("agent-a")
  expect(host.prompts).toHaveLength(1)
  expect(host.prompts[0]).toMatchObject({ sessionID: reminder.sessionID, text: "test prompt", delivery: "queue" })
  expect(await loadReminder(reminder.id, host)).toBeNull()
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

test("aborted action turns reschedule recurring reminders and drop one-time ones", async () => {
  for (const type of ["recurring", "one-time"] as const) {
    const { host, state, reminder } = await createFixture(type)
    reminder.agent = "build"
    host.contextFor = (sessionID) => {
      const messages = matchedContext(host, sessionID)
      messages[1]!.error = { _tag: "Session.InterruptedError" }
      return messages
    }
    await saveReminder(reminder, host)
    const occurrence = reminder.time.nextExecution
    await executeReminder(reminder, host, state, config)
    const stored = await loadReminder(reminder.id, host)
    if (type === "recurring") {
      expect(stored?.status).toBe("active")
      expect(stored!.time.nextExecution).toBeGreaterThan(occurrence)
      expect(stored?.time.lastExecution).toBeUndefined()
      beginSchedulerGeneration(host)
    } else {
      expect(stored).toBeNull()
    }
  }
})

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

function failTurns(host: FakeHost, message = "Claude Code exited without a result (code 1)") {
  host.contextFor = (sessionID) => {
    const messages = matchedContext(host, sessionID)
    messages[1]!.error = { type: "provider.unknown", message }
    return messages
  }
}

test("a failed recurring action turn reschedules to its next interval and counts the failure", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 45 * 60_000
  failTurns(host)
  await saveReminder(reminder, host)
  const before = Date.now()
  await executeReminder(reminder, host, state, config)
  const stored = await loadReminder(reminder.id, host)
  expect(stored?.status).toBe("active")
  expect(stored?.consecutiveFailures).toBe(1)
  expect(stored!.time.nextExecution).toBeGreaterThanOrEqual(before + reminder.interval)
  expect(stored?.time.lastExecution).toBeUndefined()
  expect(state.timers.has(reminder.id)).toBe(true)
  expect(state.reminders.get(reminder.id)?.consecutiveFailures).toBe(1)
  beginSchedulerGeneration(host)
})

test("thrown prompt failures also reschedule recurring actions", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  host.session.prompt = async () => { throw new Error("Server unavailable") }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  const stored = await loadReminder(reminder.id, host)
  expect(stored?.status).toBe("active")
  expect(stored?.consecutiveFailures).toBe(1)
  beginSchedulerGeneration(host)
})

test("recurring action pauses after the configured number of consecutive failures", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  const limited: PluginConfig = { ...config, max_consecutive_failures: 3 }
  failTurns(host)
  await saveReminder(reminder, host)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = (await loadReminder(reminder.id, host))!
    await executeReminder(current, host, state, limited)
  }
  const stored = await loadReminder(reminder.id, host)
  expect(host.prompts).toHaveLength(3)
  expect(stored?.status).toBe("paused")
  expect(stored?.consecutiveFailures).toBe(3)
  expect(stored?.pauseReason).toContain("3 consecutive failed turns")
  expect(stored?.pauseReason).toContain("exited without a result")
  expect(state.timers.has(reminder.id)).toBe(false)
  expect(state.reminders.get(reminder.id)?.status).toBe("paused")
  // A paused reminder never runs again.
  await executeReminder(stored!, host, state, limited)
  expect(host.prompts).toHaveLength(3)
  const tools = Object.fromEntries(createTools(host, state, () => limited).map((tool) => [tool.name, tool]))
  const listing = await tools.reminderlist.execute({}, { sessionID: reminder.sessionID, agent: "build" })
  expect(listing.content).toContain("Paused automatically after 3 consecutive failed turns")
})

test("the default failure limit is five", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  failTurns(host)
  await saveReminder(reminder, host)
  for (let attempt = 1; attempt <= 4; attempt++) {
    await executeReminder((await loadReminder(reminder.id, host))!, host, state, config)
  }
  expect((await loadReminder(reminder.id, host))?.status).toBe("active")
  await executeReminder((await loadReminder(reminder.id, host))!, host, state, config)
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

test("interrupted turns neither count nor reset the failure streak", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  reminder.consecutiveFailures = 2
  host.contextFor = (sessionID) => {
    const messages = matchedContext(host, sessionID)
    messages[1]!.error = { _tag: "Session.InterruptedError" }
    return messages
  }
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  const stored = await loadReminder(reminder.id, host)
  expect(stored?.status).toBe("active")
  expect(stored?.consecutiveFailures).toBe(2)
  beginSchedulerGeneration(host)
})

test("a failed one-time action is still dropped", async () => {
  const { host, state, reminder } = await createFixture("one-time")
  failTurns(host)
  await saveReminder(reminder, host)
  await executeReminder(reminder, host, state, config)
  expect(await loadReminder(reminder.id, host)).toBeNull()
  expect(state.reminders.has(reminder.id)).toBe(false)
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

test("usage-limit failures reschedule without counting towards the pause", async () => {
  const { host, state, reminder } = await createFixture("recurring")
  reminder.interval = 60_000
  reminder.consecutiveFailures = 2
  const limited: PluginConfig = { ...config, max_consecutive_failures: 3 }
  for (const message of [
    "Claude Code: You've hit your session limit · resets 3:10am (UTC)",
    "Claude Code: usage limit reached (session limit) - Claude is not started again until it resets 3:10am",
  ]) {
    failTurns(host, message)
    await saveReminder(reminder, host)
    const before = Date.now()
    await executeReminder((await loadReminder(reminder.id, host))!, host, state, limited)
    const stored = await loadReminder(reminder.id, host)
    expect(stored?.status).toBe("active")
    expect(stored?.consecutiveFailures).toBe(2)
    expect(stored!.time.nextExecution).toBeGreaterThanOrEqual(before + reminder.interval)
  }
  // An ordinary failure still counts, and here reaches the limit.
  failTurns(host)
  await executeReminder((await loadReminder(reminder.id, host))!, host, state, limited)
  expect((await loadReminder(reminder.id, host))?.status).toBe("paused")
})

test("usage-limit errors are told apart from other failures", () => {
  expect(isUsageLimitError(new Error("Reminder turn failed: Claude Code: You've hit your weekly limit · resets Oct 5, 3am"))).toBe(true)
  expect(isUsageLimitError(new Error("Reminder turn failed: Usage limit reached"))).toBe(true)
  expect(isUsageLimitError(new Error("Reminder turn failed: Claude Code: Prompt is too long"))).toBe(false)
  expect(isUsageLimitError(new Error("You've hit your monthly spend limit."))).toBe(false)
  expect(isUsageLimitError(new Error("Server unavailable"))).toBe(false)
  expect(isUsageLimitError(undefined)).toBe(false)
})
