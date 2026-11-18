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
- Composio is disabled, including its Google sign-in path and app-triggered
  routines. Owner one-time sign-in, scheduled routines and xAI voice remain.
  Set `XAI_API_KEY` to enable voice and X research.

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
waits. Bot HQ shows the returned command and reason with **Allow once** and
**Don't allow**. The same prompt identity and generation go back to Hermes.
Unattended turns deny prompts that require a human decision and post a
notice. The guardian can still independently approve commands under
`smart`. See the [Hermes Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server#runs-api-streaming-friendly-alternative).
