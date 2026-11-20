# Remote Agents

Bot HQ owns chat, routines and the Library. Each Agent owns its Hermes gateway,
Hermes home, Chrome profile and X display. The [Hermes v0.23.1 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1) is the version verified here.

## Register an Agent

1. Create a bot or open an existing bot. Open conversation details, then **Engine → Agent connection**.
2. Enter the Agent's API origin, such as `http://agent:8642`, and the Agent's `API_SERVER_KEY`. The Agent's API server needs to be enabled and reachable from Bot HQ.
3. Enter the websockify URL, such as `ws://agent:6080/websockify`, and the VNC password. Websockify relays to the Agent's VNC server on display `:99`. The relay uses classic VNC password authentication. Chrome runs on that display. Enter its DevTools port and use **Check Chrome** to verify access from Bot HQ.
4. Save. The key and password are write-only in the UI. Blank secret fields retain credentials for the same URL. Changing a URL requires re-entering its secret. Clearing a URL clears its secret.
5. Open **MCP settings** in the registration form. Place the returned `hq` entry under `mcp_servers` in the Agent's Hermes config. The entry contains a per-bot bearer token. `MCP_BASE_URL` must be reachable **from the Agent**, such as the Bot HQ Tailscale address on port 8787. Keep the token private.

Bot HQ needs access to each Agent's API, websockify and DevTools ports. The
Agent needs the reverse connection to Bot HQ's MCP port for tasks, file
delivery, routines and bot-to-bot messages. The Agent-to-HQ Tailscale grant
is a separate Owner-approved network change. Use `APP_URL` for the browser
origin and `HQ_HOST` for the Bot HQ bind address.

Bot HQ stores registration credentials in its SQLite database, which has
owner-only file permissions. Keep the database and backups private. The
VNC relay uses the password on the server. Watch mode filters mouse, keyboard,
clipboard and screen resize input. **Take control** enables input and **Hand
back** tells the Agent to inspect the screen again on its next turn.

## Owner secure input

In **Engine → Agent connection**, enter the owner-secret port (default 8655)
and the per-Agent `OWNER_SECRET_TOKEN` from the Agent's vault. The registered
Hermes URL must use the Agent's Tailscale IPv4 address. Bot HQ reaches the vault
service over HTTP inside Tailscale. Grant only `tag:bot-hq` access to that Agent's
owner-secret port. The token is write-only in the UI. Leaving it blank keeps
the saved token for the same address and port. Changes to the Agent connection
invalidate pending shares. Use the Owner's HTTPS browser origin as `APP_URL`.

When a task needs the Owner's own data, the Agent calls
`hq.request_secure_input` during a Bot HQ turn with `kind`, the exact HTTPS
origin as `site`, `label`, `reason`, and `one_time`. The tool returns a
`pending` receipt. Bot HQ displays a **Secure input** card in the Owner's chat
after confirming the receipt against the current Hermes run.
The Owner can share or decline it. The Agent should wait for the next-turn
notice with the same request ID and `ready` plus an opaque `ref`, or
`declined`. For logins, use `quantself_website_account` `fill` with
`item_id` set to that reference. For other kinds, use `fill_secret` with the
reference. Both require the same site origin.

Logins persist in the Agent's **Owner-shared** vault folder. Verification
codes are one-time. Phone numbers are one-time unless remembered, and private
text follows the request's `one_time` setting. The Agent vault expires
one-time values after use or ten minutes. Open **Engine → Shared with this
Agent** to see shared item metadata or revoke an item.

The browser submits values to the authenticated, same-origin
`POST /api/secure-input/:request_id`. Bot HQ forwards them to
`POST /v1/owner-secrets` using the Agent token and retains only request
metadata and resolution. Values stay out of Bot HQ's logs, SQLite, chat,
and Agent notifications. If the result is unconfirmed, retry with the same
values and sharing settings. Bot HQ reuses the request ID so the Agent can
return the existing reference. Revoke a stored value under **Shared with this
Agent** if you no longer want the Agent to use it. Use the form for secrets
and keep them out of chat.

The Agent's visible Chromium session must isolate filled values from Hermes
browser and screen tools before real Owner secrets are used. A status-only
fill result leaves the filled field readable through shared browser controls.

## Benchmark the screen

From the Bot HQ checkout, install dependencies with `npm ci`. Set
`OWNER_SESSION_COOKIE` to the full Owner cookie header value
(`grokbot_session=<value>`). Use HTTPS when benchmarking a remote HQ:

```sh
node scripts/screen-bench.mjs --hq-url https://hq.example.com --bot-id "$BOT_ID" --seconds 10
```

If the Agent's websockify endpoint is reachable directly, set
`AGENT_WEBSOCKIFY_URL` to the full WebSocket URL, including any token in the
query string. Set `VNC_PASSWORD` in the environment and run:

```sh
node scripts/screen-bench.mjs --seconds 10
```

Export credentials in the shell environment before running either command.
`--seconds` defaults to 10. The script prints one JSON object:

- `firstFrameMs` measures the time from connection start until the initial full
  framebuffer update arrives.
- `updatesPerSecond` counts complete incremental framebuffer updates per second.
- `bytesPerSecond` counts incoming binary RFB payload bytes per second during
  incremental sampling.
- `medianRects` is the median rectangle count per incremental update, or `null`
  when no incremental updates arrive.

Add `--control` to either command to measure input latency. After the first
frame, the benchmark moves the remote pointer between two corners without
clicking. `inputLatencyMs` is the median time from sending input to receiving a
complete update with a rectangle covering the destination. The run ends after
20 samples or when `--seconds` expires, and reports `null` if no sample
completes. The rate metrics use the elapsed sampling time in control mode.

The benchmark measures RFB delivery before browser decoding and rendering. It
advertises CopyRect, Tight, Raw and LastRect, with Tight quality 6 and
compression 2 in watch mode or 1 in control mode. The first frame must arrive
within 15 seconds. Use a quiet desktop for control measurements because other
updates covering the destination can also count toward input latency.

For before-and-after measurements, use the same endpoint, sample length and
desktop activity on both runs.

## Paths and compatibility

- `HQ_DATA_DIR` defaults to `data` in the app directory. Override the database
  or Library independently with `DB_PATH` or `HQ_LIBRARY_DIR`. The `save_file`
  MCP tool writes to the Bot HQ Library.
- `HQ_INSTALL_DIR` controls where the archive installer unpacks the app.
  `scripts/add-hq-to-hermes.py` accepts `--config` and `--entry` for a local
  YAML edit. It defaults to `$HERMES_HOME/config.yaml` or the user's Hermes
  home.
- Set the legacy opt-in `HQ_LOCAL_ENGINES=1` only if using Bot HQ's local
  Hermes launcher. `HERMES_BIN`, `HERMES_HOME_PRIMARY`, `ENGINES_DIR`,
  `HERMES_URL` and `HERMES_KEY` configure it. Existing bot IDs and
  transcripts persist. Register each Agent's new screen in the app.
- Composio is disabled, including its Google sign-in path.
  Set `XAI_API_KEY` to enable voice and X research.

## Event routines

Provision an enabled routine on the target Bot with `schedule = 'event:<name>'`
and a prompt describing what the Agent should do. Use one routine per event
name on each Bot. To create one, ask the target Agent to create a routine with
that event schedule and prompt. The URL uses the schedule suffix, which can differ from the
routine's display name. For example, `event:gmail_push` receives deliveries at
`POST /hooks/<botId>/gmail_push`. URL-encode the suffix as one path segment.

Send JSON over HTTPS with `Authorization: Bearer <token>` and
`Content-Type: application/json`.
On the HQ host, derive the token as the hex HMAC-SHA256 of `hook:<botId>` keyed
by `SESSION_SECRET`. Give the service only its Bot's hook token.

```sh
# Use a private terminal with SESSION_SECRET already in the environment.
node -e 'const { createHmac } = require("node:crypto");
const secret = process.env.SESSION_SECRET;
if (!secret || !process.argv[1]) process.exit(1);
console.log(createHmac("sha256", secret).update("hook:" + process.argv[1]).digest("hex"));' "$BOT_ID"
```

```json
{
  "event_id": "gmail:history:12345",
  "summary": "New inbox activity",
  "refs": { "messageId": "12345" }
}
```

Use stable, source-prefixed IDs and reuse the ID when retrying. `event_id` and
`summary` are nonempty strings. `refs` is a JSON object, for example
`{"messageId":"12345"}` or `{"uidvalidity":345,"uid":90}`. The body limit is 16 KiB.

| Status | Meaning |
| --- | --- |
| 202 | Event accepted, `{"status":"accepted"}` |
| 200 | ID already accepted for this Bot, `{"status":"duplicate"}` |
| 400 | Invalid JSON or fields |
| 401 | Missing or invalid Bot bearer |
| 404 | No enabled event routine available over HTTP for this Bot and schedule suffix |
| 409 | Bot or routine is unavailable, or the pending batch is full. Retry with the same ID. |
| 413 | Request body exceeds 16 KiB |

In-process services can call `enqueueEvent(botId, routineName, { event_id, summary, refs })`
with the same schedule suffix and fields. It returns `{ status }`. The possible
statuses are `accepted`, `duplicate`, `not_found`, `unavailable`, `invalid`, and
`too_large`. An event added to an existing batch also returns `accepted`. The
private Personal Assistant accepts enabled event routines through this
in-process path. Each event turn uses its own conversation and has no Owner
chat tool context.

HQ stores accepted IDs in SQLite per Bot across all its routines. The first
event opens a 100 ms collection window. Events for the same routine continue
to join that batch while it waits in the Bot's queue. At the start of the turn,
HQ sends the routine prompt followed by the batch's summaries and references.
Events arriving during the turn form the next batch. A batch can hold up to 64
events or 64 KiB of serialized event data. HQ commits the payload and ID before
acknowledging and recovers unclaimed batches on restart. Pausing, archiving or
resetting a Bot invalidates its pending batches. Disabling or deleting a routine
also invalidates its batch. Accepted IDs remain recorded in SQLite.
HQ claims each batch once when the turn starts. A crash after that point can
interrupt the turn.

## Draft-only gateway

**Draft only** sends a single message to a separately configured Hermes process.
It uses the approved role identity and the current message. Draft runs have no
chat history, memory, tool schemas, or connector credentials. Bot HQ saves a
reply after successful completion and uses the ordinary transcript and Stop
controls. The regular Send button and Enter use the normal gateway.

Start one draft gateway per enabled Bot under a dedicated service account.
Give it read access to an unmodified pinned Hermes checkout and a standalone
role identity file. Keep the service account away from normal Agent homes,
connector credentials, screens, and client files. Keep its listener on
loopback or an explicitly approved private route reachable only by Bot HQ.
Permit outbound access only to its chosen inference and authentication endpoints.
The ordinary Agent gateway can keep running throughout.

Use the Python environment with the pinned Hermes API dependencies. Export
`BOT_HQ_DRAFT_GATEWAY_KEY` with a unique secret of at least 32 characters.
For Codex, enroll a dedicated Hermes credential separately. Its file and
directory must be private, owned by the draft service account, and writable
for refresh. Start the gateway with:

```sh
/path/to/hermes-venv/bin/python -I scripts/draft-hermes.py \
  --hermes-source /path/to/pinned/hermes \
  --persona /path/to/approved/SOUL.md \
  --provider openai-codex --model MODEL --port 18764 \
  --codex-auth /path/to/private/draft-auth/auth.json
```

An inference-only OpenAI key also works with `--provider openai` and
`OPENAI_API_KEY`. A compatible HTTPS endpoint can be set with `--base-url`.
For private routing, specify the exact bind address with `--host`.

Set `HQ_DRAFT_GATEWAYS` in the Bot HQ service environment as a JSON object
keyed by Bot ID, then restart Bot HQ to pick it up:

```text
{"BOT_ID":{"url":"http://127.0.0.1:18764","key":"DEDICATED_GATEWAY_KEY"}}
```

Use the isolated endpoint and its key. Bot HQ refuses configured ordinary
gateway addresses and credentials. A draft gateway error appears in the
transcript and ends the draft without falling back to regular chat. To
disable drafts, remove the matching registration, restart Bot HQ, and
stop the isolated gateway.

Verify the tool boundary with the pinned Hermes Python environment and a
scripted provider on loopback:

```sh
/path/to/hermes-venv/bin/python -I tests/draft-hermes.py \
  --hermes-source /path/to/pinned/hermes --provider openai
/path/to/hermes-venv/bin/python -I tests/draft-hermes.py \
  --hermes-source /path/to/pinned/hermes --provider openai-codex
npm run build
node tests/draft-only.mjs
```

Set `HQ_TEST_CHROMIUM` to a Chromium executable to include the composer
test at mobile width.

## Verify with an isolated Hermes gateway

Use an unmodified [v0.23.1 checkout at `3b421578588243f920886e6fe79a6faa87ea026e`](https://github.com/NousResearch/hermes-agent/commit/3b421578588243f920886e6fe79a6faa87ea026e)
with API-server dependencies available. Give the test gateway its own
`HERMES_HOME` and `HERMES_GATEWAY_LOCK_DIR`. Use the test home as the marker
directory. The test model returns deterministic text, tool calls and a
guardian escalation, with inference confined to localhost.

In the test Hermes home, set `config.yaml` to:

```yaml
model:
  default: hq-test
  provider: custom
  base_url: http://127.0.0.1:18761/v1
  context_length: 256000
terminal:
  backend: local
  cwd: /tmp
platform_toolsets:
  api_server: [terminal]
approvals:
  mode: smart
  unattended_mode: deny
```

Set the test home's `.env` to:

```dotenv
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=18762
API_SERVER_KEY=hq-loopback-test
OPENAI_API_KEY=hq-local-provider-key
```

Run each process in its own terminal, using the same absolute marker directory:

```sh
HQ_TEST_MARKER_DIR=/path/to/test-home node tests/hermes-provider.mjs
HERMES_HOME=/path/to/test-home HERMES_GATEWAY_LOCK_DIR=/path/to/test-home/locks hermes gateway run --no-supervise
DEV_LOGIN=1 PORT=18763 APP_URL=http://127.0.0.1:18763 SESSION_SECRET=isolated-test-secret \
  HQ_DATA_DIR=/path/to/test-hq-data node server/dist/index.js
HQ_TEST_MARKER_DIR=/path/to/test-home node tests/remote-hermes.mjs
```

The remote integration checks incremental text, chat continuity, Stop, approvals,
credential isolation and MCP. It also delays an approval acknowledgement,
truncates a successful run receipt, and queues work ahead of Fresh chat and
Delete. To verify Stop, the test waits for an actual
terminal command to write its start marker, invokes Bot HQ's interrupt route,
checks the same run's Hermes status for `cancelled`, then waits beyond the
command's original duration and checks that its completion marker is absent.

Install with `npm ci` and build with `npm run build` to test the release.
With only the test model and Hermes gateway running, use:

```sh
HQ_TEST_MARKER_DIR=/path/to/test-home node tests/pause.mjs
```

The Pause test starts Bot HQ on port 18764 with a temporary database. It
checks three separately registered bots, cancels a live command, verifies
queued work stays discarded after Resume, and restarts Bot HQ to check
persistence. Run it separately from the other integration test because
both use the same Hermes marker files. After installing Chromium with
`npx playwright install chromium`, add `HQ_TEST_BROWSER=1` to check the
production UI, including deferred saves, reload and draft preservation.

With the original `/v1/responses` transport, disconnection only reached Hermes
after the tested terminal command had finished. Remote turns use
`POST /v1/runs` and its SSE stream. Bot HQ sends `POST /v1/runs/{id}/stop`
and waits for Hermes's terminal event before showing **Stopped**.
A transport failure is reported as an error.

With `smart` and a guardian escalation, `/v1/responses` attempted to send the
prompt through the API platform's unsupported outbound messaging path. The
Runs stream emits `approval.request` with the prompt identity while the run
waits. Bot HQ shows the returned command, reason, and offered choices.
**Allow for this chat** grants permission for the Hermes conversation.
It and **Always allow** also resolve pending prompts in the same run when the
events share a `pattern_key`, offer that choice, and require no additional
approval rules. Prompts without a key are handled individually. Each decision
goes back to Hermes with its prompt identity and generation.
Unattended turns deny prompts that require a human decision and post a
notice. The guardian can still independently approve commands under
`smart`. See the [Hermes Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server#runs-api-streaming-friendly-alternative).

## Jobs inbox monitoring

Set `HQ_JOBS_MONITOR_BOT_ID` to Sam's exact Bot HQ record ID. Enable one
routine named `Jobs inbox monitoring` after deploying the matching Jobs mail
plugin on Sam. The routine calls `quantself_jobs_mail` with `{"monitor":true}`
every five minutes. It reuses the existing per-Agent Bot HQ connection.

Bot HQ stores the mailbox position with each notification and resumes from
that position after restart. A completed scan while the inbox is quiet saves
the check time without posting a message. A scan failure posts one alert.
If Sam is busy, the scheduler skips that tick and posts an alert once the
last confirmed check is more than 12 minutes old. Pause the routine to stop
polling. The next check after resuming picks up from the saved position.
