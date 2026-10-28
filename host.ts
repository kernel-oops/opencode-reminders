// The narrow slice of the OpenCode v2 Promise plugin context this plugin depends on.
// Keeping it explicit lets tests inject a fake host and keeps the plugin free of
// runtime imports from `@opencode/plugin` (its `define` helper is an identity function).

export type SessionStatus = "idle" | "busy" | "retry"

export type SessionMessage = {
  id: string
  type: string
  time?: { created?: unknown; completed?: unknown }
  error?: unknown
  text?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  content?: ReadonlyArray<unknown>
  finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"
  interruption?: "steer"
  outcome?: "succeeded" | "failed" | "interrupted"
}

export type PromptRequest = {
  sessionID: string
  text: string
  delivery?: "steer" | "queue"
  metadata?: Record<string, unknown>
}

export type ReminderHost = {
  readonly directory: string
  readonly projectID: string
  /** Status tracked from live events; undefined when no execution event has been observed. */
  status(sessionID: string): SessionStatus | undefined
  session: {
    get(input: { sessionID: string }): Promise<{ id: string; agent?: string } | undefined>
    switchAgent(input: { sessionID: string; agent: string }): Promise<unknown>
    prompt(input: PromptRequest): Promise<{ id: string; sessionID?: string } | undefined>
    wait(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<ReadonlyArray<SessionMessage> | undefined>
  }
}

type EventLike = { type: string; data?: Record<string, unknown> }

export type PluginContextLike = {
  location: { directory: string; project: { id: string } }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<EventLike> }
  session: ReminderHost["session"]
}

export type EventTracker = {
  host: ReminderHost
  stop: () => void
  /** Resolves once the subscription loop has ended. */
  done: Promise<void>
}

const BUSY_EVENTS = new Set(["session.execution.started"])
const IDLE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
])

/**
 * Build the host from a v2 plugin context. Status is derived from execution events
 * because the plugin context exposes no status query; unknown sessions rely on the
 * server's durable queue admission instead of an advisory pre-check.
 */
export function createHost(
  ctx: PluginContextLike,
  onEvent?: (event: EventLike) => void | Promise<void>,
): EventTracker {
  const statuses = new Map<string, SessionStatus>()
  const controller = new AbortController()
  const done = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
        if (sessionID) {
          if (BUSY_EVENTS.has(event.type)) statuses.set(sessionID, "busy")
          else if (IDLE_EVENTS.has(event.type)) statuses.set(sessionID, "idle")
          else if (event.type === "session.status") {
            const status = (event.data as { status?: { type?: string } }).status?.type
            if (status === "idle" || status === "busy" || status === "retry") statuses.set(sessionID, status)
          } else if (event.type === "session.deleted") statuses.delete(sessionID)
        }
        if (onEvent) await onEvent(event)
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  return {
    host: {
      directory: ctx.location.directory,
      projectID: ctx.location.project.id,
      status: (sessionID) => statuses.get(sessionID),
      session: ctx.session,
    },
    stop: () => controller.abort(),
    done,
  }
}
