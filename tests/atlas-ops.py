"""Local checks for Atlas artifacts. Pass the unmodified sandbox atlas.nft path."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    sys.exit(f'Usage: {sys.argv[0]} <unmodified Atlas sandbox atlas.nft>')
source = Path(sys.argv[1])
bridge, guest = 'vmbr3199', '10.254.99.2'
original = source.read_text()
render = [sys.executable, str(root / 'scripts/render-atlas-firewall.py')]


def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, **kwargs)


rendered = subprocess.check_output([*render, str(source), bridge, guest], text=True)
assert source.read_text() == original
dropped = f'        oifname "{bridge}" counter drop'
replies = f'ip daddr {guest} ct state {{ established, related }} counter accept'
catch_all = 'iifname "vmbr0" oifname != "vmbr0" counter drop'
assert rendered.index(replies) < rendered.index(dropped) < rendered.index(catch_all)
assert rendered.count('hook forward') == original.count('hook forward')
assert f'iifname "{bridge}" ip daddr @non_public_ipv4 counter drop' in rendered
assert f'iifname "{bridge}" ip daddr @home_wan_ipv4 counter drop' in rendered
assert f'iifname "{bridge}" oifname "vmbr0" ip saddr {guest} masquerade' in rendered
assert set(original.splitlines()) <= set(rendered.splitlines())
assert run([*render, str(source), 'vmbr0', guest]).returncode != 0
assert run([*render, str(source), bridge, '8.8.8.8']).returncode != 0
print('Atlas render preserves the sandbox table, limits egress and places narrow replies before the shared drop.')

with tempfile.TemporaryDirectory(prefix='bot-hq-ops-test-') as directory:
    scratch = Path(directory)
    drift = scratch / 'drift.nft'
    drift.write_text(original.replace(catch_all, 'counter accept'))
    changed = run([*render, str(drift), bridge, guest])
    assert changed.returncode != 0 and not changed.stdout

    release = scratch / 'releases'
    release.mkdir()
    old = release / 'old'
    old.mkdir()
    current = scratch / 'current'
    current.symlink_to(old)
    calls = scratch / 'calls'
    shell = scratch / 'fixture.bash'
    shell.write_text(r'''
cd() {
    [[ $* == /var/lib/bot-hq ]] || return 2
    builtin cd "$ATLAS_TEST_ROOT"
}
sudo() {
    [[ $1 == -H && $2 == -u && $3 == bot-hq ]] || return 2
    shift 3
    if [[ $1 == /usr/bin/env ]]; then
        printf 'stage\n' >> "$ATLAS_TEST_LOG"
        return "$ATLAS_TEST_STAGE_STATUS"
    fi
    command "$@"
}
mv() {
    [[ $1 == -Tf && $2 == current.next && $3 == current ]] || return 2
    "$ATLAS_TEST_PYTHON" -c 'import os; os.replace("current.next", "current")'
}
systemctl() { printf 'systemctl %s\n' "$*" >> "$ATLAS_TEST_LOG"; }
curl() { printf 'healthy\n'; }
''')
    git_dir = release / 'candidate'
    subprocess.run(['git', 'init', '-q', git_dir], check=True)
    subprocess.run(['git', '-C', git_dir, '-c', 'user.name=Bot HQ test', '-c', 'user.email=test@example.test',
                    'commit', '-q', '--allow-empty', '-m', 'Candidate'], check=True)
    sha = subprocess.check_output(['git', '-C', git_dir, 'rev-parse', 'HEAD'], text=True).strip()
    candidate = release / sha
    git_dir.rename(candidate)
    settings = {
        **os.environ,
        'BASH_ENV': str(shell), 'ATLAS_TEST_ROOT': str(scratch),
        'ATLAS_TEST_LOG': str(calls), 'ATLAS_TEST_PYTHON': sys.executable,
    }
    activate = ['bash', str(root / 'scripts/activate-atlas-release.sh'), sha]

    def verify_failed_activation(status):
        calls.write_text('')
        result = run(activate, env={**settings, 'ATLAS_TEST_STAGE_STATUS': status})
        assert result.returncode != 0, result.stdout
        assert current.readlink() == old
        assert calls.read_text() == 'stage\n'

    verify_failed_activation('1')  # npm/build failed
    verify_failed_activation('0')  # staging claimed success but artifacts missing
    for artifact in ['server/dist/index.js', 'web/dist/index.html']:
        output = candidate / artifact
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text('test build\n')
    calls.write_text('')
    success = run(activate, env={**settings, 'ATLAS_TEST_STAGE_STATUS': '0'})
    assert success.returncode == 0, success.stderr
    assert current.readlink() == candidate and 'systemctl restart bot-hq.service' in calls.read_text()
    assert 'healthy' in success.stdout
    print('Activation preserved the symlink and service on staging and verification failures, then switched a valid release.')
