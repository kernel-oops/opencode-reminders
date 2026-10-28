import path from "path"
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { ReminderHost } from "./host"
import type { Reminder } from "./types"
import { logger } from "./logger"

export async function getStorageDir(host: Pick<ReminderHost, "directory" | "projectID">): Promise<string> {
  const root = path.join(host.directory, ".opencode", "reminders")
  const dir = path.join(root, host.projectID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(root, ".gitignore"), "*")
  return dir
}

export async function saveReminder(reminder: Reminder, host: ReminderHost): Promise<void> {
  const dir = await getStorageDir(host)
  const filePath = path.join(dir, `${reminder.id}.json`)
  const temporaryPath = path.join(dir, `.${reminder.id}.${crypto.randomUUID()}.tmp`)
  let handle

  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(JSON.stringify(reminder, null, 2))
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
  } finally {
    await handle?.close()
    await rm(temporaryPath, { force: true })
  }
}

export async function loadReminder(id: string, host: ReminderHost): Promise<Reminder | null> {
  const dir = await getStorageDir(host)
  const filePath = path.join(dir, `${id}.json`)

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Reminder
  } catch (error: any) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export async function deleteReminder(id: string, host: ReminderHost): Promise<void> {
  const dir = await getStorageDir(host)
  await rm(path.join(dir, `${id}.json`), { force: true })
}

export async function listReminders(host: ReminderHost): Promise<Reminder[]> {
  const dir = await getStorageDir(host)
  const reminders: Reminder[] = []

  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const file = path.join(dir, name)
    try {
      reminders.push(JSON.parse(await readFile(file, "utf8")))
    } catch (error) {
      logger.error(`Failed to load reminder from ${file}:`, error)
    }
  }

  return reminders
}
