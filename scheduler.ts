import type { ReminderHost } from "./host"
import type { Reminder, State, PluginConfig } from "./types"
import { saveReminder, deleteReminder, loadReminder } from "./storage"
import { acquireExecutionLease, acquireMutationLock } from "./leases"
import { logger } from "./logger"
import { reminderPrompt } from "./execution"

type ScheduledExecution = {
  generation: string
  token: string
  controller?: AbortController
  timer?: NodeJS.Timeout
  state: State
}

type ProjectRuntime = {
  generation: string
  executions: Map<string, ScheduledExecution>
  persistence: Map<string, Promise<unknown>>
  fences: Map<string, ReminderFence>
}

type ReminderFence = {
  version: number
  reconciliations: number
  deletions: number
  tombstone: boolean
}

type ScheduleOptions = {
  persist?: boolean
  skipOverdue?: boolean
  retryAttempt?: number
  minimumDelayMs?: number
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const IN_FLIGHT_REASON = "Execution may have been admitted; inspect the session before removing and recreating this reminder."
const RECONCILIATION_DELAY_MS = 250
const MAX_RECONCILIATION_DELAY_MS = 30_000
const MAX_RECONCILIATION_ATTEMPT = 1 + Math.ceil(
  Math.log2(MAX_RECONCILIATION_DELAY_MS / RECONCILIATION_DELAY_MS),
)
const runtimesKey = Symbol.for("opencode-reminders.scheduler-runtimes")
const runtimes: Map<string, ProjectRuntime> =
  (globalThis as any)[runtimesKey] ?? ((globalThis as any)[runtimesKey] = new Map())

function projectKey(host: ReminderHost): string {
  return `${host.directory}\0${host.projectID}`
}

function getRuntime(host: ReminderHost): ProjectRuntime {
  const key = projectKey(host)
  let runtime = runtimes.get(key)
  if (!runtime) {
    runtime = {
      generation: crypto.randomUUID(),
      executions: new Map(),
      persistence: new Map(),
      fences: new Map(),
    }
    runtimes.set(key, runtime)
  }
  runtime.fences ??= new Map()
  for (const fence of runtime.fences.values()) fence.deletions ??= 0
  return runtime
}

function stateGeneration(state: State, host: ReminderHost): string {
  if (!state.generation) state.generation = getRuntime(host).generation
  return state.generation
}

function isCurrentGeneration(state: State, host: ReminderHost): boolean {
  return stateGeneration(state, host) === getRuntime(host).generation
}

function isCurrentExecution(id: string, host: ReminderHost, state: State, token: string): boolean {
  const runtime = getRuntime(host)
  const execution = runtime.executions.get(id)
  return (
    stateGeneration(state, host) === runtime.generation
    && execution?.generation === runtime.generation
    && execution.token === token
  )
}

function stopLocalExecution(id: string, runtime: ProjectRuntime): ScheduledExecution | undefined {
  const execution = runtime.executions.get(id)
  if (execution?.timer) clearTimeout(execution.timer)
  execution?.controller?.abort()
  execution?.state.timers.delete(id)
  runtime.executions.delete(id)
  return execution
}

export function beginSchedulerGeneration(host: ReminderHost): string {
  const runtime = getRuntime(host)
  for (const id of Array.from(runtime.executions.keys())) stopLocalExecution(id, runtime)
  for (const [id, fence] of runtime.fences) retireFence(id, runtime, fence)
  runtime.generation = crypto.randomUUID()
  return runtime.generation
}

export function isSchedulerGenerationCurrent(host: ReminderHost, generation: string): boolean {
  return getRuntime(host).generation === generation
}

export async function waitForSchedulerMutations(host: ReminderHost, generation: string): Promise<boolean> {
  const runtime = getRuntime(host)
  while (runtime.generation === generation) {
    const pending = Array.from(runtime.persistence.values())
    if (pending.length === 0) return true
    await Promise.all(pending.map((operation) => operation.catch(() => {})))
  }
  return false
}

async function withMutationLock<T>(id: string, host: ReminderHost, action: () => Promise<T>): Promise<T> {
  const runtime = getRuntime(host)
  const operationID = `${id}\0${crypto.randomUUID()}`
  const operation = (async () => {
    const lock = await acquireMutationLock(id, host)
    try {
      return await action()
    } finally {
      await lock.release()
    }
  })()
  runtime.persistence.set(operationID, operation)
  try {
    return await operation
  } finally {
    if (runtime.persistence.get(operationID) === operation) runtime.persistence.delete(operationID)
  }
}

function clearStateReminder(id: string, state: State): void {
  const timer = state.timers.get(id)
  if (timer) clearTimeout(timer)
  state.timers.delete(id)
  state.reminders.delete(id)
}

function beginReconciliation(id: string, runtime: ProjectRuntime): { fence: ReminderFence; version: number } {
  let fence = runtime.fences.get(id)
  if (!fence) {
    fence = { version: 0, reconciliations: 0, deletions: 0, tombstone: false }
    runtime.fences.set(id, fence)
  }
  fence.reconciliations++
  return { fence, version: fence.version }
}

function reconciliationIsCurrent(
  id: string,
  runtime: ProjectRuntime,
  fence: ReminderFence,
  version: number,
): boolean {
  return runtime.fences.get(id) === fence && fence.version === version && !fence.tombstone
}

function finishReconciliation(id: string, runtime: ProjectRuntime, fence: ReminderFence): void {
  fence.reconciliations--
  retireFence(id, runtime, fence)
}

function invalidateReminder(
  id: string,
  runtime: ProjectRuntime,
): { fence: ReminderFence; version: number } {
  let fence = runtime.fences.get(id)
  if (!fence) {
    fence = { version: 0, reconciliations: 0, deletions: 0, tombstone: false }
    runtime.fences.set(id, fence)
  }
  fence.version++
  fence.deletions++
  fence.tombstone = true
  return { fence, version: fence.version }
}

function finishInvalidation(id: string, runtime: ProjectRuntime, fence: ReminderFence): void {
  fence.deletions--
  retireFence(id, runtime, fence)
}

function retireFence(id: string, runtime: ProjectRuntime, fence: ReminderFence): void {
  if (
    runtime.fences.get(id) === fence
    && fence.reconciliations === 0
    && fence.deletions === 0
    && !runtime.executions.has(id)
  ) {
    runtime.fences.delete(id)
  }
}

async function deleteReminderLocked(id: string, host: ReminderHost, state: State): Promise<void> {
  const runtime = getRuntime(host)
  const { fence, version } = invalidateReminder(id, runtime)
  const execution = stopLocalExecution(id, runtime)
  clearStateReminder(id, state)
  if (execution && execution.state !== state) clearStateReminder(id, execution.state)
  try {
    await deleteReminder(id, host)
  } catch (error) {
    if (runtime.fences.get(id) === fence && fence.version === version) fence.tombstone = false
    throw error
  } finally {
    finishInvalidation(id, runtime, fence)
  }
}

export async function deleteStoredReminder(id: string, host: ReminderHost, state: State): Promise<void> {
  if (!isCurrentGeneration(state, host)) return
  await withMutationLock(id, host, async () => {
    if (isCurrentGeneration(state, host)) await deleteReminderLocked(id, host, state)
  })
}

export async function scheduleTimer(
  reminder: Reminder,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): Promise<boolean> {
  const runtime = getRuntime(host)
  const generation = stateGeneration(state, host)
  if (generation !== runtime.generation) {
    clearStateReminder(reminder.id, state)
    return false
  }

  if (reminder.status !== "active") return false
  stopLocalExecution(reminder.id, runtime)
  const token = crypto.randomUUID()
  const execution: ScheduledExecution = { generation, token, state }
  runtime.executions.set(reminder.id, execution)

  if (options.persist !== false) {
    const snapshot = structuredClone(reminder)
    try {
      await withMutationLock(reminder.id, host, async () => {
        if (isCurrentExecution(reminder.id, host, state, token)) await saveReminder(snapshot, host)
      })
    } catch (error) {
      if (isCurrentExecution(reminder.id, host, state, token)) {
        stopLocalExecution(reminder.id, runtime)
        clearStateReminder(reminder.id, state)
      }
      throw error
    }
    if (!isCurrentExecution(reminder.id, host, state, token)) {
      clearStateReminder(reminder.id, state)
      return false
    }
  }

  const now = Date.now()
  const delay = Math.max(options.minimumDelayMs ?? 0, reminder.time.nextExecution - now, 0)
  const skipOverdue = options.skipOverdue === true && reminder.time.nextExecution < now
  const retryAttempt = reminder.time.nextExecution < now ? options.retryAttempt ?? 0 : 0
  const timer = setTimeout(async () => {
    if (state.timers.get(reminder.id) === timer) state.timers.delete(reminder.id)
    if (!isCurrentExecution(reminder.id, host, state, token)) return

    if (Date.now() < reminder.time.nextExecution) {
      await scheduleTimer(reminder, host, state, config, { ...options, persist: false })
      return
    }
    const controller = new AbortController()
    execution.timer = undefined
    execution.controller = controller
    try {
      await executeReminder(reminder, host, state, config, skipOverdue, retryAttempt, token, controller.signal)
    } catch (error) {
      logger.error(`Unhandled reminder timer failure ${reminder.id}:`, error)
      if (isCurrentExecution(reminder.id, host, state, token)) {
        scheduleReconciliation(reminder.id, host, state, config, { skipOverdue, retryAttempt })
      }
    }
  }, Math.min(delay, MAX_TIMER_DELAY_MS))
  timer.unref()
  execution.timer = timer
  state.timers.set(reminder.id, timer)
  return true
}

function scheduleReconciliation(
  id: string,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): void {
  if (!isCurrentGeneration(state, host)) return
  const existing = state.timers.get(id)
  if (existing) clearTimeout(existing)
  const generation = stateGeneration(state, host)
  const retryAttempt = Math.min((options.retryAttempt ?? 0) + 1, MAX_RECONCILIATION_ATTEMPT)
  const delay = Math.min(
    RECONCILIATION_DELAY_MS * (2 ** (retryAttempt - 1)),
    MAX_RECONCILIATION_DELAY_MS,
  )
  const timer = setTimeout(async () => {
    if (state.timers.get(id) === timer) state.timers.delete(id)
    const execution = getRuntime(host).executions.get(id)
    if (execution?.timer === timer) execution.timer = undefined
    if (!isSchedulerGenerationCurrent(host, generation)) return
    await reconcileReminder(id, host, state, config, {
      skipOverdue: options.skipOverdue,
      retryAttempt,
      minimumDelayMs: options.minimumDelayMs,
    })
  }, delay)
  timer.unref()
  state.timers.set(id, timer)
  const execution = getRuntime(host).executions.get(id)
  if (execution?.generation === generation) execution.timer = timer
}

export async function reconcileReminder(
  id: string,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): Promise<void> {
  if (!isCurrentGeneration(state, host)) return
  const runtime = getRuntime(host)
  const { fence, version } = beginReconciliation(id, runtime)
  try {
    await loadReminder(id, host)
    if (
      !isCurrentGeneration(state, host)
      || !reconciliationIsCurrent(id, runtime, fence, version)
    ) return

    await withMutationLock(id, host, async () => {
      if (
        !isCurrentGeneration(state, host)
        || !reconciliationIsCurrent(id, runtime, fence, version)
      ) return

      // Re-read under the mutation lock so a cancellation in another process cannot
      // be followed by restoration from the optimistic snapshot above.
      const stored = await loadReminder(id, host)
      if (
        !isCurrentGeneration(state, host)
        || !reconciliationIsCurrent(id, runtime, fence, version)
      ) return
      if (!stored || stored.status !== "active") {
        clearStateReminder(id, state)
        if (stored?.status === "paused") state.reminders.set(id, stored)
        return
      }
      state.reminders.set(id, stored)
      await scheduleTimer(stored, host, state, config, {
        persist: false,
        skipOverdue: options.skipOverdue,
        retryAttempt: options.retryAttempt,
        minimumDelayMs: options.minimumDelayMs,
      })
    })
  } catch (error) {
    logger.error(`Failed to reconcile reminder ${id}:`, error)
    if (reconciliationIsCurrent(id, runtime, fence, version)) {
      scheduleReconciliation(id, host, state, config, options)
    }
  } finally {
    finishReconciliation(id, runtime, fence)
  }
}

export async function cleanupReminderSnapshot(
  snapshot: Reminder,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
): Promise<boolean> {
  if (!isCurrentGeneration(state, host)) return false
  try {
    let cleaned = false
    await withMutationLock(snapshot.id, host, async () => {
      if (!isCurrentGeneration(state, host)) return
      const current = await loadReminder(snapshot.id, host)
      if (!current || current.time.nextExecution !== snapshot.time.nextExecution) return
      await deleteReminderLocked(snapshot.id, host, state)
      cleaned = true
    })
    if (!cleaned) await reconcileReminder(snapshot.id, host, state, config)
    return cleaned
  } catch (error) {
    logger.error(`Failed conditional cleanup for reminder ${snapshot.id}:`, error)
    await reconcileReminder(snapshot.id, host, state, config)
    return false
  }
}

async function skipMissedRecurring(
  reminder: Reminder,
  occurrence: number,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
  skipOverdue: boolean,
  retryAttempt: number,
): Promise<boolean> {
  if (!skipOverdue || reminder.type !== "recurring") return false
  let advanced = false
  await withMutationLock(reminder.id, host, async () => {
    const current = await loadReminder(reminder.id, host)
    if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
    const missed = Math.ceil(Math.abs(Date.now() - occurrence) / current.interval)
    current.time.nextExecution = occurrence + missed * current.interval
    await saveReminder(current, host)
    if (isCurrentGeneration(state, host)) {
      state.reminders.set(current.id, current)
      await scheduleTimer(current, host, state, config, { persist: false })
    }
    advanced = true
  })
  if (!advanced) {
    await reconcileReminder(reminder.id, host, state, config, { skipOverdue, retryAttempt })
  }
  return true
}

async function monitorIsIdle(reminder: Reminder, host: ReminderHost): Promise<boolean> {
  const session = await host.session.get({ sessionID: reminder.sessionID })
  if (!session || session.id !== reminder.sessionID) {
    throw new Error("Cannot verify monitor session")
  }
  const status = host.status(reminder.sessionID)
  if (status === undefined || status === "idle") return true
  if (status === "busy" || status === "retry") return false
  throw new Error("Unknown monitor session status")
}

export class ReminderPromptError extends Error {
  constructor(message: string, readonly kind: "aborted" | "failed" | "unmatched") {
    super(message)
    this.name = kind === "aborted" ? "MessageAbortedError" : "ReminderPromptError"
  }
}

function errorIsAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const tag = (error as { _tag?: unknown; type?: unknown; name?: unknown })
  return [tag._tag, tag.type, tag.name].some((value) => typeof value === "string" && /abort|interrupt/i.test(value))
}

function assistantErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error
  if (typeof error !== "object" || error === null) return undefined
  const record = error as { message?: unknown; data?: { message?: unknown }; type?: unknown; _tag?: unknown }
  for (const value of [record.message, record.data?.message, record.type, record._tag]) {
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/**
 * Submit the reminder prompt and wait for the agent loop to settle. The server
 * assigns the durable message ID; completion is verified against the session
 * context so another turn's assistant is never credited as this reminder's.
 */
async function runPrompt(
  reminder: Reminder,
  host: ReminderHost,
  signal: AbortSignal | undefined,
): Promise<void> {
  const body = reminderPrompt(reminder)
  const admitted = await host.session.prompt({
    sessionID: reminder.sessionID,
    text: body.text,
    delivery: "queue",
    metadata: { source: "opencode-reminders", reminderID: reminder.id, execution: reminder.execution ?? "action" },
  })
  if (!admitted || typeof admitted.id !== "string") throw new ReminderPromptError("Prompt was not admitted", "failed")
  if (admitted.sessionID !== undefined && admitted.sessionID !== reminder.sessionID) {
    throw new ReminderPromptError("Prompt admitted to a different session", "unmatched")
  }
  await raceAbort(host.session.wait({ sessionID: reminder.sessionID }), signal)
  const messages = (await host.session.context({ sessionID: reminder.sessionID })) ?? []
  const index = messages.findIndex((message) => message.id === admitted.id)
  const unique = messages.filter((message) => message.id === admitted.id).length === 1
  const tail = messages.slice(index + 1)
  const idle = tail.at(-1)
  const assistants = tail.slice(0, -1)
  if (index < 0 || !unique || messages[index]?.type !== "user" || idle?.type !== "idle" || idle.outcome !== "succeeded" || assistants.length === 0 || assistants.some((message) => message.type !== "assistant" || !message.time?.completed)) {
    throw new ReminderPromptError("Reminder completion is ambiguous or not successful; inspect the session", "unmatched")
  }
  for (const assistant of assistants) {
    if (assistant.error !== undefined || assistant.finish === "error" || assistant.interruption !== undefined) {
      const detail = assistantErrorText(assistant.error)
      throw new ReminderPromptError(detail ? `Reminder turn failed: ${detail}` : "Reminder turn failed", errorIsAbort(assistant.error) ? "aborted" : "failed")
    }
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new ReminderPromptError("Reminder execution aborted", "aborted"))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ReminderPromptError("Reminder execution aborted", "aborted"))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function deferBusyMonitor(
  reminder: Reminder, occurrence: number, host: ReminderHost, state: State, config: PluginConfig,
): Promise<void> {
  await withMutationLock(reminder.id, host, async () => {
    if (!isCurrentGeneration(state, host)) return
    const current = await loadReminder(reminder.id, host)
    if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
    // A status-only deferral is not an execution. No catch-up burst or completion timestamp.
    current.time.nextExecution = Date.now() + Math.max(current.interval, 30_000)
    await saveReminder(current, host)
    state.reminders.set(current.id, current)
    await scheduleTimer(current, host, state, config, { persist: false })
  })
}

export async function executeReminder(
  reminder: Reminder,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
  skipOverdue = false,
  retryAttempt = 0,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getRuntime(host)
  if (!token) {
    if (!isCurrentGeneration(state, host)) return
    stopLocalExecution(reminder.id, runtime)
    token = crypto.randomUUID()
    const controller = new AbortController()
    signal = controller.signal
    runtime.executions.set(reminder.id, {
      generation: stateGeneration(state, host),
      token,
      controller,
      state,
    })
  }

  const occurrence = reminder.time.nextExecution
  const acquisition = await acquireExecutionLease(reminder.id, occurrence, host)
  if (acquisition.status !== "acquired") {
    if (acquisition.status === "error") {
      logger.error(`Could not acquire reminder lease ${reminder.id}:`, acquisition.error)
    }
    if (isCurrentExecution(reminder.id, host, state, token)) {
      scheduleReconciliation(reminder.id, host, state, config, { skipOverdue, retryAttempt })
    }
    return
  }

  try {
    try {
      const stored = await loadReminder(reminder.id, host)
      if (!isCurrentExecution(reminder.id, host, state, token)) return
      if (!stored || stored.status !== "active" || stored.time.nextExecution !== occurrence) {
        await reconcileReminder(reminder.id, host, state, config, { skipOverdue, retryAttempt })
        return
      }
      reminder = stored
      if (await skipMissedRecurring(
        stored,
        occurrence,
        host,
        state,
        config,
        skipOverdue,
        retryAttempt,
      )) return
    } catch (error) {
      logger.error(`Pre-prompt validation failed for reminder ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, host, state, config, { skipOverdue, retryAttempt })
      return
    }

    try {
      const monitor = reminder.execution === "monitor"
      reminderPrompt(reminder)
      if (monitor && !(await monitorIsIdle(reminder, host))) {
        if (isCurrentExecution(reminder.id, host, state, token)) {
          await deferBusyMonitor(reminder, occurrence, host, state, config)
        }
        return
      }
      if (!isCurrentExecution(reminder.id, host, state, token)) return
      if (monitor) {
        const current = await loadReminder(reminder.id, host)
        if (!isCurrentExecution(reminder.id, host, state, token)) return
        if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) {
          await reconcileReminder(reminder.id, host, state, config, { retryAttempt })
          return
        }
      }
      const body = reminderPrompt(reminder)
      if (body.agent !== undefined) {
        const session = await host.session.get({ sessionID: reminder.sessionID })
        if (!session || session.id !== reminder.sessionID || session.agent !== body.agent) {
          throw new ReminderPromptError("Session agent does not match the reminder; refusing to switch it", "unmatched")
        }
      }
      if (!isCurrentExecution(reminder.id, host, state, token)) return
      // Persist uncertainty before admission so a reload does not replay this occurrence.
      const armed = await withMutationLock(reminder.id, host, async () => {
        if (!isCurrentExecution(reminder.id, host, state, token)) return false
        const current = await loadReminder(reminder.id, host)
        if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return false
        current.status = "paused"
        current.pauseReason = IN_FLIGHT_REASON
        await saveReminder(current, host)
        state.reminders.set(current.id, current)
        return true
      })
      if (!armed || !isCurrentExecution(reminder.id, host, state, token)) return
      await runPrompt(reminder, host, signal)
    } catch (error: any) {
      if (!isCurrentExecution(reminder.id, host, state, token)) return
      logger.error(`Reminder ${reminder.id} prompt failed:`, error)
      // Unknown admission or completion must never be retried automatically.
      await withMutationLock(reminder.id, host, async () => {
        if (!isCurrentExecution(reminder.id, host, state, token)) return
        const current = await loadReminder(reminder.id, host)
        if (!current || current.time.nextExecution !== occurrence) return
        if (current.status === "active") {
          current.status = "paused"
          current.pauseReason = "Reminder execution failed before admission; inspect and remove or recreate it."
          await saveReminder(current, host)
        }
        if (current.status === "paused") state.reminders.set(current.id, current)
      })
      return
    }

    // Only a confirmed execution owned by this generation may clear the durable guard.
    try {
      const completed = await withMutationLock<Reminder | null>(reminder.id, host, async () => {
        const current = await loadReminder(reminder.id, host)
        if (!isCurrentExecution(reminder.id, host, state, token) || !current || current.status !== "paused" || current.pauseReason !== IN_FLIGHT_REASON || current.time.nextExecution !== occurrence) return null
        current.status = "active"
        delete current.pauseReason
        current.time.lastExecution = Date.now()
        reminder.time.lastExecution = current.time.lastExecution
        // A successful turn clears the failure streak.
        if (current.consecutiveFailures !== undefined) {
          if (current.consecutiveFailures > 0) logger.info(`Reminder ${current.id} succeeded; failure count reset`)
          delete current.consecutiveFailures
        }
        if (current.type === "recurring") {
          current.time.nextExecution = Date.now() + current.interval
          await saveReminder(current, host)
          if (isCurrentExecution(reminder.id, host, state, token)) {
            state.reminders.set(current.id, current)
            await scheduleTimer(current, host, state, config, { persist: false })
          }
        } else {
          await deleteReminderLocked(current.id, host, state)
        }
        return current
      })
      if (!completed) await reconcileReminder(reminder.id, host, state, config, { retryAttempt })
    } catch (error) {
      logger.error(`Post-prompt transition failed for reminder ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, host, state, config, { retryAttempt })
    }
  } finally {
    try {
      await acquisition.lease.release()
    } catch (error) {
      logger.error(`Failed to release reminder lease ${reminder.id}:`, error)
      if (isCurrentGeneration(state, host)) {
        scheduleReconciliation(reminder.id, host, state, config, { skipOverdue, retryAttempt })
      }
    }
  }
}

export async function cancelReminder(
  id: string,
  host: ReminderHost,
  state: State,
  config: PluginConfig,
): Promise<boolean> {
  const runtime = getRuntime(host)
  const { fence, version } = invalidateReminder(id, runtime)
  const execution = stopLocalExecution(id, runtime)
  const rollbackState = execution?.state ?? state
  clearStateReminder(id, state)
  if (execution && execution.state !== state) clearStateReminder(id, execution.state)
  try {
    await withMutationLock(id, host, async () => {
      await deleteReminder(id, host)
      const replacement = stopLocalExecution(id, runtime)
      clearStateReminder(id, state)
      if (replacement && replacement.state !== state) clearStateReminder(id, replacement.state)
    })
    finishInvalidation(id, runtime, fence)
    logger.info(`Reminder ${id} cancelled`)
    return true
  } catch (error) {
    const ownsFence = runtime.fences.get(id) === fence && fence.version === version
    if (ownsFence) fence.tombstone = false
    finishInvalidation(id, runtime, fence)
    logger.error(`Failed to cancel reminder ${id}:`, error)
    if (ownsFence) {
      try {
        await reconcileReminder(id, host, rollbackState, config, {
          minimumDelayMs: RECONCILIATION_DELAY_MS,
        })
      } catch (rollbackError) {
        logger.error(`Failed to restore reminder ${id} after cancellation failure:`, rollbackError)
      }
    }
    throw error
  }
}

/** Durably suspend without aborting the caller's currently running prompt. */
export async function pauseReminder(
  id: string,
  sessionID: string,
  reason: string,
  host: ReminderHost,
  state: State,
): Promise<boolean> {
  if (!isCurrentGeneration(state, host)) return false
  // Only IDs already owned by this session may become filesystem paths.
  if (state.reminders.get(id)?.sessionID !== sessionID) return false
  return withMutationLock(id, host, async () => {
    if (!isCurrentGeneration(state, host)) return false
    const current = await loadReminder(id, host)
    if (!current || current.sessionID !== sessionID || current.status === "cancelled") return false
    if (current.status !== "paused" || current.pauseReason === IN_FLIGHT_REASON) {
      current.status = "paused"
      current.pauseReason = reason === IN_FLIGHT_REASON ? `Requested pause: ${reason}` : reason
      await saveReminder(current, host)
    }
    const timer = state.timers.get(id)
    if (timer) clearTimeout(timer)
    state.timers.delete(id)
    const execution = getRuntime(host).executions.get(id)
    if (execution?.timer) clearTimeout(execution.timer)
    state.reminders.set(id, current)
    return true
  })
}
