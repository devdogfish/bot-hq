<p align="center">
  <img src="assets/readme-banner.svg" alt="Bot HQ. Your team. Their own computers." width="100%">
</p>

<p align="center">
  Chat with remote Hermes Agents, watch their screens, and take over when needed.
</p>

<p align="center">
  <img alt="Node 22.12 or newer" src="https://img.shields.io/badge/node-%E2%89%A522.12-3c873a">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1c1c1c">
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-experimental-fd690f">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/chat-dark.png">
    <img src="assets/screenshots/chat-light.png" alt="A chat with a bot. The bot's steps are listed while it works, its screen is live in the side panel, and the Engine panel shows its model." width="100%">
  </picture>
</p>

## Run locally

Use Node.js 22.12 or newer and npm. Copy `.env.example` to `.env` and set a
random `SESSION_SECRET`. For loopback development, set `DEV_LOGIN=1`.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`, sign in and register each Agent under
**Engine → Agent connection**. The [registration guide](docs/remote-agents.md)
covers Hermes, VNC, Chrome DevTools, Agent-to-HQ MCP and integration tests.

For the built app, run `npm run build`, set `APP_URL` to the built app's
origin, and run `npm start`. With dev login disabled, run
`bash scripts/sign-in-link.sh you@example.com` on the Bot HQ host to generate a
one-time sign-in link. `scripts/pack.sh` builds an archive, and
`scripts/install-on-computer.sh` unpacks it into `HQ_INSTALL_DIR`.

The [Atlas runbook](docs/atlas-deploy.md) covers the dedicated VM, release,
tailnet grants and backup checks.

## How it works

```mermaid
flowchart LR
  Browser -->|chat and noVNC| HQ[Bot HQ]
  HQ -->|Runs API and SSE| Hermes[Agent Hermes gateway]
  HQ -->|websockify| Screen[Agent VNC display]
  Hermes -->|authenticated HQ MCP| HQ
```

Hermes owns the Agent's persona, memory and model sign-in. Bot HQ owns chat,
routines, tasks and the delivery Library. Configure `XAI_API_KEY` for voice
and X research. Composio stays disabled.

The [upstream architecture notes](docs/ARCHITECTURE.md) describe the earlier
shared-computer implementation.

## License

MIT. Continued from [Bot HQ](https://github.com/nickvasilescu/bot-hq).
