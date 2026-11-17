"""Owner-only Google consent. Write Bot HQ's Gmail credentials to a new private file."""

import argparse
from base64 import urlsafe_b64encode
from hashlib import sha256
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import webbrowser


SCOPES = {
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
}
MAILBOX_SCOPE = {"https://mail.google.com/"}
TOKEN_URL = "https://oauth2.googleapis.com/token"
PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress"


class RefuseRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("Google returned an unexpected redirect.")


def safe_value(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._~@+/-]{1,2048}", value):
        raise ValueError("Invalid Google credential format.")
    return value


def read_google(request):
    with build_opener(RefuseRedirect()).open(request, timeout=12) as response:
        data = response.read(32_769)
    if len(data) > 32_768:
        raise ValueError("Google returned an oversized authorization response.")
    return json.loads(data)


def receive_code(client_id, mailbox, verifier, scopes=SCOPES):
    state = secrets.token_urlsafe(32)
    challenge = urlsafe_b64encode(sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            try:
                uri = urlsplit(self.path)
                fields = parse_qs(uri.query, max_num_fields=16)
            except ValueError:
                self.send_error(400, "Unexpected callback.")
                return
            supplied = fields.get("state", [])
            if uri.path != "/callback" or len(supplied) != 1 or not hmac.compare_digest(supplied[0], state):
                self.send_error(400, "Unexpected callback.")
                return
            codes = fields.get("code", [])
            if len(codes) == 1 and codes[0] and "error" not in fields:
                result["code"] = codes[0]
                text = b"Consent received. Check the Terminal for verification."
            else:
                result["denied"] = True
                text = b"Google consent was declined."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(text)

    with HTTPServer(("127.0.0.1", 0), Callback) as listener:
        listener.timeout = 0.5
        redirect = f"http://127.0.0.1:{listener.server_port}/callback"
        parameters = urlencode({
            "client_id": client_id, "redirect_uri": redirect, "response_type": "code",
            "scope": " ".join(sorted(scopes)), "access_type": "offline", "prompt": "consent",
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "login_hint": mailbox,
        })
        if not webbrowser.open("https://accounts.google.com/o/oauth2/v2/auth?" + parameters):
            raise ValueError("The browser could not be opened.")
        deadline = time.monotonic() + 300
        while not result and time.monotonic() < deadline:
            listener.handle_request()
    if "code" not in result:
        raise ValueError("Google consent was declined or timed out.")
    return result["code"], redirect


def authorize(client_file, mailbox, output, *, mailbox_actions=False):
    parent = output.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("Choose a private directory you own for the output.")
    if output.exists() or output.is_symlink():
        raise ValueError("Choose a new credential output file.")
    mailbox = safe_value(mailbox)
    if not re.fullmatch(r"[^@]+@[^@]+", mailbox):
        raise ValueError("Enter the Owner’s exact Google mailbox address.")
    client = json.loads(client_file.read_text())["installed"]
    client_id, client_secret = safe_value(client["client_id"]), safe_value(client["client_secret"])
    verifier = secrets.token_urlsafe(48)
    scopes = MAILBOX_SCOPE if mailbox_actions else SCOPES
    code, redirect = receive_code(client_id, mailbox, verifier, scopes)
    token = read_google(Request(TOKEN_URL, data=urlencode({
        "client_id": client_id, "client_secret": client_secret, "code": code,
        "code_verifier": verifier, "redirect_uri": redirect, "grant_type": "authorization_code",
    }).encode()))
    if str(token.get("token_type", "")).casefold() != "bearer" or set(token.get("scope", "").split()) != scopes:
        raise ValueError("Google did not grant the approved Gmail scopes.")
    access, refresh = safe_value(token["access_token"]), safe_value(token["refresh_token"])
    profile = read_google(Request(PROFILE_URL, headers={"Authorization": "Bearer " + access}))
    if profile.get("emailAddress", "").casefold() != mailbox.casefold():
        raise ValueError("Google returned a different mailbox.")
    material = {
        "HQ_TYLER_GMAIL_MAILBOX": mailbox, "HQ_TYLER_GMAIL_CLIENT_ID": client_id,
        "HQ_TYLER_GMAIL_CLIENT_SECRET": client_secret, "HQ_TYLER_GMAIL_REFRESH_TOKEN": refresh,
    }
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as private:
        for name, value in material.items():
            private.write(f"{name}={value}\n")
    print("Google mailbox and OAuth scopes verified. Credential file saved privately.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_file", type=Path, help="Google Desktop OAuth client JSON")
    parser.add_argument("mailbox", help="Owner's exact Google mailbox address")
    parser.add_argument("output", type=Path, help="New file in a private directory")
    parser.add_argument("--mailbox-actions", action="store_true", help="Request the approved Gmail scope for permanent deletion.")
    args = parser.parse_args()
    try:
        authorize(args.client_file, args.mailbox, args.output, mailbox_actions=args.mailbox_actions)
    except ValueError:
        raise SystemExit("Consent verification refused. Check the client type, mailbox, scopes and output location.") from None
    except (KeyError, TypeError, OSError):
        raise SystemExit("Consent verification could not finish. No secret values displayed.") from None


if __name__ == "__main__":
    main()
