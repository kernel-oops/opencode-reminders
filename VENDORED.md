# Port provenance and v2 gaps

This fork retains the history of [Dmitry Zelenkovsky's original plugin](https://github.com/zelenkovsky/opencode-reminders), based on maintained fork commit `1936f495e396c9bcb93a201adee3cd3bd271d650`. The v2 port was developed as a locally vendored plugin; its runtime files and focused tests are copied here. The older v1 suite and historical planning documents do not describe this port and have been removed from the current tree, not from Git history.

## API mapping

- V2 exports `{ id, setup(ctx) }`; setup registers JSON-schema tools through `ctx.tool.transform` and returns cleanup. Plugin options replace the v1 config hook.
- Session events track status and deletion. The v2 plugin context does not expose a status query. A prompt uses `delivery: "queue"`, including when no status has been observed.
- V2 has no per-prompt agent argument: the session agent is switched when necessary. Completion is checked using `session.wait` and the session context after the admitted message. This differs from v1's per-message agent and reply matching and depends on the host API's behaviour.
- V2 has no server-side toast API. Notification options from v1 are ignored.
- Local same-host leases, mutation locks, persistent reminders and generation fencing remain. These do not provide exactly-once delivery or distributed-filesystem coordination. A cancellation cannot retract an already admitted prompt; stale recovery guards may require manual cleanup.
- Monitor execution keeps the creating agent and ordinary session/model/permission resolution. It is not a cheaper-model mechanism; an unverified completion suspends the monitor. Recurring actions count failed turns and pause at the configured threshold; usage-limit failures are excluded.

## Verification and deployment

Focused Bun tests cover the port with fake hosts. Historical v2 smoke testing of the vendored copy reported successful plugin and four-tool registration on a stock v2.0.3 server without provider calls; it does not establish compatibility with other builds, live providers or this particular release tree. Run the tests and validate registration on the target v2 build before deployment. This repository does not itself deploy or publish a package.
