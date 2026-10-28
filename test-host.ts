import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ReminderHost, SessionMessage, SessionStatus } from "./host"
import type { Reminder, State } from "./types"

export type FakeHost = ReminderHost & {
  statuses: Map<string, SessionStatus>
  prompts: any[]
  agents: Map<string, string>
  /** Messages returned by session.context; defaults to a matched assistant reply for the last prompt. */
  contextFor?: (sessionID: string) => ReadonlyArray<SessionMessage>
}

let counter = 0
export const nextMessageID = () => `msg_${(++counter).toString(16).padStart(12, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`

export function matchedContext(host: FakeHost, sessionID: string): SessionMessage[] {
  const last = [...host.prompts].reverse().find((p) => p.sessionID === sessionID)
  if (!last?.id) return []
  return [
    { id: last.id, type: "user" },
    { id: nextMessageID(), type: "assistant", time: { created: Date.now(), completed: Date.now() } },
  ]
}

export async function createFakeHost(directory?: string): Promise<FakeHost> {
  const dir = directory ?? (await mkdtemp(path.join(tmpdir(), "opencode-reminders-")))
  const projectID = crypto.randomUUID()
  await mkdir(path.join(dir, ".opencode", "reminders", projectID), { recursive: true })
  const host: FakeHost = {
    directory: dir,
    projectID,
    statuses: new Map(),
    prompts: [],
    agents: new Map(),
    status: (sessionID) => host.statuses.get(sessionID),
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: host.agents.get(sessionID) ?? "build" }),
      switchAgent: async ({ sessionID, agent }) => {
        host.agents.set(sessionID, agent)
      },
      prompt: async (request) => {
        const id = nextMessageID()
        host.prompts.push({ ...request, id })
        return { id, sessionID: request.sessionID }
      },
      wait: async () => {},
      context: async ({ sessionID }) => (host.contextFor ? host.contextFor(sessionID) : matchedContext(host, sessionID)),
    },
  }
  return host
}

export function createState(projectID: string): State {
  return { reminders: new Map(), timers: new Map(), projectID }
}

export function createReminder(projectID: string, type: Reminder["type"]): Reminder {
  return {
    id: crypto.randomUUID(),
    sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    projectID,
    type,
    interval: 30,
    originalPrompt: "test prompt",
    userDescription: "test reminder",
    time: { created: Date.now(), nextExecution: Date.now() },
    status: "active",
  }
}
