from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / "scripts/authorize-personal-gmail.py"
spec = importlib.util.spec_from_file_location("owner_consent", script)
consent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(consent)


class ConsentTest(unittest.TestCase):
    def test_writes_only_exact_grant_to_a_private_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            client_file = root / "client.json"
            client_file.write_text(json.dumps({"installed": {
                "client_id": "fixture-id", "client_secret": "fixture-secret",
            }}))
            output = root / "gmail.env"
            token = {"token_type": "Bearer", "scope": " ".join(consent.SCOPES),
                     "access_token": "fixture-access", "refresh_token": "fixture-refresh"}
            with patch.object(consent, "receive_code", return_value=("fixture-code", "http://127.0.0.1:1234/callback")), \
                    patch.object(consent, "read_google", side_effect=[token, {"emailAddress": "owner@example.net"}]), \
                    redirect_stdout(io.StringIO()) as report:
                consent.authorize(client_file, "owner@example.net", output)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            private = output.read_text()
            self.assertIn("HQ_PERSONAL_GMAIL_REFRESH_TOKEN=fixture-refresh", private)
            self.assertNotIn("fixture-access", private)
            self.assertNotIn("fixture-", report.getvalue())
            with self.assertRaises(ValueError):
                consent.authorize(client_file, "owner@example.net", output)

    def test_refuses_wrong_account_and_scope_without_saving(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            client_file = root / "client.json"
            client_file.write_text(json.dumps({"installed": {
                "client_id": "fixture-id", "client_secret": "fixture-secret",
            }}))
            output = root / "gmail.env"
            token = {"token_type": "Bearer", "scope": " ".join(consent.SCOPES),
                     "access_token": "fixture-access", "refresh_token": "fixture-refresh"}
            for responses in ([token, {"emailAddress": "other@example.net"}], [{**token, "scope": "wrong"}]):
                with self.subTest(responses=len(responses)), \
                        patch.object(consent, "receive_code", return_value=("fixture-code", "http://127.0.0.1:1234/callback")), \
                        patch.object(consent, "read_google", side_effect=responses), self.assertRaises(ValueError):
                    consent.authorize(client_file, "owner@example.net", output)
                self.assertFalse(output.exists())


    def test_full_mailbox_grant_requires_the_mailbox_action_option(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            client = root / "client.json"
            client.write_text(json.dumps({"installed": {
                "client_id": "fixture-id", "client_secret": "fixture-secret",
            }}))
            output = root / "gmail.env"
            token = {"token_type": "Bearer", "scope": "https://mail.google.com/",
                     "access_token": "fixture-access", "refresh_token": "fixture-refresh"}
            with patch.object(consent, "receive_code", return_value=("code", "http://127.0.0.1/callback")) as receive, \
                    patch.object(consent, "read_google", side_effect=[token, token, {"emailAddress": "owner@example.net"}]), \
                    redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    consent.authorize(client, "owner@example.net", output)
                self.assertFalse(output.exists())
                consent.authorize(client, "owner@example.net", output, mailbox_actions=True)
                self.assertEqual(receive.call_args.args[-1], {"https://mail.google.com/"})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
