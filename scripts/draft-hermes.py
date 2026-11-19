#!/usr/bin/env -S python3 -I
"""Run the pinned Hermes Runs API with a fresh, text-only draft process."""

import argparse
import asyncio
from functools import wraps
from ipaddress import ip_address, ip_network
import json
import os
from pathlib import Path
import stat
import signal
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


HERMES_REVISION = "3b421578588243f920886e6fe79a6faa87ea026e"
TOOL_DENIED = "Tools are disabled on the draft gateway"
DRAFT_FIELDS = {"input", "instructions", "model"}
DRAFT_ROUTES = {
    ("GET", "/health"),
    ("GET", "/v1/models"),
    ("POST", "/v1/runs"),
    ("GET", "/v1/runs/{run_id}"),
    ("GET", "/v1/runs/{run_id}/events"),
    ("POST", "/v1/runs/{run_id}/stop"),
}


def forbid_tool_calls(*_args, **_kwargs):
    raise RuntimeError(TOOL_DENIED)


def checked_transport(original):
    @wraps(original)
    def build_kwargs(*args, **kwargs):
        request = original(*args, **kwargs)
        if request.get("tools") or request.get("tool_choice") not in (None, "none"):
            forbid_tool_calls()
        return request

    return build_kwargs


async def serve(args, key):
    if args.codex_auth:
        from hermes_cli import auth
        # Keep refresh-token rotation durable in the dedicated store using Hermes's own locks.
        auth._auth_file_path = lambda: args.codex_auth

    from aiohttp import web
    from agent.transports.chat_completions import ChatCompletionsTransport
    from agent.transports.codex import ResponsesApiTransport
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    import agent.turn_tool_round
    from agent.turn_tool_validation import ToolValidationVerdict, _partial_exit
    import model_tools
    import run_agent

    if args.provider == "openai":
        from gateway import run as gateway_run

        def resolve_draft_api_runtime():
            # This worker has one configured API route. The stock resolver may
            # infer a Codex OAuth route from a model also offered by Codex.
            return gateway_run._runtime_agent_kwargs({
                "provider": "custom",
                "requested_provider": "custom",
                "base_url": args.base_url or "https://api.openai.com/v1",
                "api_key": os.environ["OPENAI_API_KEY"],
                "api_mode": "chat_completions",
            })

        gateway_run._resolve_runtime_agent_kwargs = resolve_draft_api_runtime

    class DraftAgent(run_agent.AIAgent):
        def __init__(self, **options):
            allowed_modes = {"codex_responses"} if args.provider == "openai-codex" else {
                "chat_completions", "codex_responses"
            }
            if options.get("api_mode") not in allowed_modes or options.get("command"):
                raise RuntimeError("Unsupported draft provider transport")
            super().__init__(**{
                **options,
                "enabled_toolsets": [],
                "skip_context_files": True,
                "load_soul_identity": True,
                "skip_memory": True,
                "memory_manager": None,
                "skip_background_review": True,
                "checkpoints_enabled": False,
                "fallback_model": None,
            })
            if self.api_mode not in allowed_modes or self.tools or self.valid_tool_names:
                raise RuntimeError("Draft agent failed its text-only startup check")
            self._skip_mcp_refresh = True

        _execute_tool_calls = forbid_tool_calls

    def deny_tool_response(agent, _message, _finish, *, messages, conversation_history, api_call_count, **_):
        result = _partial_exit(agent, messages, conversation_history, api_call_count, TOOL_DENIED)
        return ToolValidationVerdict(action="return", result=result, mixed_invalid_batch=False)

    # These hooks affect only this dedicated Python process. Block late schema assembly,
    # outgoing tool-bearing payloads, and unsolicited function calls at separate boundaries.
    run_agent.AIAgent = DraftAgent
    model_tools.get_tool_definitions = lambda *_args, **_kwargs: []
    model_tools.handle_function_call = forbid_tool_calls
    agent.turn_tool_round.validate_tool_calls = deny_tool_response
    ChatCompletionsTransport.build_kwargs = checked_transport(ChatCompletionsTransport.build_kwargs)
    ResponsesApiTransport.build_kwargs = checked_transport(ResponsesApiTransport.build_kwargs)

    class DraftAdapter(APIServerAdapter):
        def _http_route_table(self):
            return [row for row in super()._http_route_table() if row[:2] in DRAFT_ROUTES]

        async def _normalize_room_dispatch(self, request, body):
            if (
                not isinstance(body, dict)
                or not isinstance(body.get("input"), str)
                or not isinstance(body.get("instructions", ""), str)
                or body.get("model", "hermes-agent") != "hermes-agent"
                or body.keys() - DRAFT_FIELDS
            ):
                return None, web.json_response({"error": "Invalid draft run"}, status=400)
            return await super()._normalize_room_dispatch(request, body)

        def _parse_session_key_header(self, _request):
            # The Runs API assigns a new session per admitted request. A caller's
            # live bot session header must never load or bind transcript history.
            return None, None

        def _create_agent(self, **options):
            # The virtual model alias always resolves to the dedicated backend.
            return super()._create_agent(**{
                **options,
                "route": None,
                "requested_model": None,
                "requested_provider": None,
                "session_model": None,
                "confirmed_runtime_lock": True,
            })

    adapter = DraftAdapter(PlatformConfig(enabled=True, extra={
        "host": args.host, "port": args.port, "key": key,
    }))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    if not await adapter.connect():
        raise RuntimeError("Could not start the isolated draft gateway")
    try:
        await stop.wait()
    finally:
        await adapter.disconnect()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--persona", type=Path, required=True, help="Approved SOUL.md")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider", choices=["openai-codex", "openai"], required=True)
    parser.add_argument("--base-url", help="Explicit OpenAI-compatible model endpoint")
    parser.add_argument("--codex-auth", type=Path, help="Dedicated Hermes auth.json for openai-codex")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("Start Python with -I")
    try:
        host = ip_address(args.host)
    except ValueError:
        parser.error("--host must be a specific loopback, private, or Tailscale IP address")
    if host.is_unspecified or host.is_multicast or not (
        host.is_loopback or host.is_private or host in ip_network("100.64.0.0/10")
    ):
        parser.error("--host must be a specific loopback, private, or Tailscale IP address")
    if not 1 <= args.port <= 65535 or not args.model.strip():
        parser.error("Provide a valid port and nonempty model name")
    key = os.environ.get("BOT_HQ_DRAFT_GATEWAY_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if len(key) < 32:
        parser.error("BOT_HQ_DRAFT_GATEWAY_KEY must be a dedicated strong key")
    if args.provider == "openai-codex":
        if not args.codex_auth or args.base_url:
            parser.error("openai-codex requires --codex-auth and uses the Codex endpoint")
    elif args.codex_auth or not openai_key:
        parser.error("openai requires OPENAI_API_KEY")
    if args.base_url:
        endpoint = urlsplit(args.base_url)
        if not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            parser.error("Invalid --base-url")
        if endpoint.scheme != "https" and not (
            endpoint.scheme == "http" and endpoint.hostname in {"127.0.0.1", "::1", "localhost"}
        ):
            parser.error("--base-url requires HTTPS or loopback HTTP")

    # A minimal environment prevents ambient connector credentials, proxies, runtime
    # overrides, user caches, and login state from following the worker.
    os.environ.clear()
    os.environ.update({"PATH": os.defpath, "LANG": "C.UTF-8"})
    sys.dont_write_bytecode = True
    source = args.hermes_source.resolve(strict=True)
    git = ["git", "-c", f"safe.directory={source}", "-C", str(source)]
    revision = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    clean = subprocess.run([*git, "diff", "--quiet", "--no-ext-diff", "HEAD", "--"], check=False)
    untracked = subprocess.check_output([*git, "ls-files", "--others"])
    if revision != HERMES_REVISION or clean.returncode != 0 or untracked:
        parser.error(f"Hermes must be an unmodified checkout at {HERMES_REVISION}")
    persona = args.persona.read_text(encoding="utf-8").strip()
    if not persona:
        parser.error("--persona must contain an approved role identity")
    if args.codex_auth:
        args.codex_auth = args.codex_auth.absolute()
        auth_stat = args.codex_auth.lstat()
        dir_stat = args.codex_auth.parent.lstat()
        if (
            not stat.S_ISREG(auth_stat.st_mode) or not stat.S_ISDIR(dir_stat.st_mode)
            or auth_stat.st_nlink != 1
            or auth_stat.st_uid != os.geteuid() or dir_stat.st_uid != os.geteuid()
            or auth_stat.st_mode & 0o077 or dir_stat.st_mode & 0o077
        ):
            parser.error("--codex-auth requires a dedicated private file and directory owned by this user")

    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="bot-hq-draft-hermes-") as scratch:
        home = Path(scratch)
        hermes_home = home / ".hermes"
        hermes_home.mkdir()
        workspace = home / "workspace"
        workspace.mkdir()
        os.chdir(workspace)
        os.environ.update({
            "HOME": str(home),
            "HERMES_HOME": str(hermes_home),
            "CODEX_HOME": str(home / ".codex"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "TMPDIR": str(home),
        })
        if args.provider == "openai":
            os.environ["OPENAI_API_KEY"] = openai_key
        (hermes_home / "SOUL.md").write_text(persona + "\n", encoding="utf-8")
        model = {"default": args.model, "provider": args.provider, "context_length": 128000}
        if args.base_url:
            model.update({"provider": "custom", "base_url": args.base_url, "key_env": "OPENAI_API_KEY"})
        config = {
            "model": model,
            "platform_toolsets": {"api_server": []},
            "mcp_servers": {},
            "plugins": {"enabled": []},
            "memory": {"memory_enabled": False, "user_profile_enabled": False},
            "auxiliary": {"title_generation": {"enabled": False}},
            "agent": {"max_turns": 4},
        }
        (hermes_home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        sys.path.insert(0, str(source))
        asyncio.run(serve(args, key))


if __name__ == "__main__":
    main()
