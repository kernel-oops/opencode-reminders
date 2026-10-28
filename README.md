# OpenCode Reminders for v2

Schedule one-time or recurring prompts in OpenCode sessions. This is a maintained v2 fork of [Dmitry Zelenkovsky's opencode-reminders](https://github.com/zelenkovsky/opencode-reminders); thank you to Dmitry for creating the original plugin. The original and this fork are MIT licensed.

**This branch is an OpenCode v2 port, not the v1 npm release.** It has not been published as v2; do not assume `bun install opencode-reminders` installs this version. It has no runtime dependencies. For an existing installation, make a reviewed local copy of this repository available to the server and register its entry point in the v2 configuration. For example, relative to the configuration directory:

```json
{
  "plugins": [
    { "package": "./plugins/opencode-reminders/index.ts", "options": {
      "max_reminders_per_project": 50,
      "min_interval_seconds": 30,
      "max_consecutive_failures": 5
    } }
  ]
}
```

Restart the server after installing or changing the plugin. Check the host's own v2 plugin configuration and loading rules before deployment; no automatic migration or deployment is provided here. Do not load this port on a v1 server.

## Use

Ask the assistant to schedule, list, pause or remove a reminder. The plugin registers `reminderadd`, `reminderlist`, `reminderpause` and `reminderremove`. Intervals are at least 30 seconds. Reminders are persisted per project under `.opencode/reminders/`; prompts are delivered to their original session. Paused reminders do not automatically resume.

`reminderadd` defaults to an **action**; `execution: "monitor"` is for an explicitly authorised, bounded routine check. Monitor mode retains the original session and captured agent, with ordinary model and permission resolution; it does not guarantee a cheaper model or authorise follow-on work. Monitors suspend when their execution cannot be verified. Recurring actions pause after the configured number of consecutive failures; provider usage-limit failures are not counted.

## Important limits

- Prompts use queued delivery rather than interrupting an active turn. Session busy status comes from observed events; it is not a status query.
- The v2 API has no per-prompt agent argument: the port may switch the session's agent before delivery. It matches completion using the session context after waiting. This is not identical to v1's message-level agent and reply matching.
- Server-side toast notifications are unavailable; legacy notification options are ignored.
- Leases coordinate processes on the same host using local filesystem operations, not distributed filesystems. Delivery is **at least once**, not exactly once: crashes can cause a retry after a prompt was accepted. Cancellation cannot retract a prompt already admitted. A stale recovery guard may require manual cleanup.
- Reminders are best-effort and depend on the server running. They are not guaranteed OS-level alarms.

See [VENDORED.md](VENDORED.md) for the v2 mapping, behavioural gaps and the provenance of this port. The focused tests are not a full replacement for the original v1 test suite or proof of compatibility with every v2 server build.

## Development

Run `bun test` with Bun. The tests use fake hosts and temporary storage; they do not exercise a live provider or deploy the plugin.
