# Bot HQ on atlas

Use during the Owner-approved go-live session for [#354](https://github.com/devdogfish/quantself/issues/354).
Bot HQ runs in its own guest and listens on loopback. Tailscale Serve exposes
the Owner's HTTPS UI on TCP 443 and the Agents' MCP path on TCP 8787. There
is no public ingress.

## Provision the guest

On Atlas, use `qm list` to reserve a free VMID in `3100–3199`. Use a clean Debian 13 amd64
cloud-init template with the QEMU guest agent installed and console access.
Record the template, storage, VMID and network in the go-live record. Start with 2 vCPUs, 4 GiB RAM and a 24 GiB boot disk.
Keep the QEMU guest agent and Proxmox console available for administration.

Use a dedicated routed/NAT bridge with an unused guest subnet. Follow the
[Atlas isolation pattern](https://github.com/devdogfish/quantself/tree/main/automation/n8n/assistant-sandbox)
using Bot HQ's own bridge, subnet and firewall table. At the Atlas boundary
allow outbound internet and return traffic. Drop guest traffic to Atlas,
other bridges, private and special-use destinations, the home WAN address,
and all Keep LAN addresses. Block unsolicited uplink-to-guest traffic and
IPv6 forwarding. Use public DNS resolvers for uplink traffic. Check these
rules before starting the guest.

With the bridge and firewall in place, set the variables from the Atlas
inventory and clone the template:

```sh
qm clone "$template_vmid" "$vmid" --full 1 --name bot-hq --storage "$storage"
qm set "$vmid" --cores 2 --memory 4096 --net0 "virtio,bridge=$bridge,firewall=1" \
  --ipconfig0 "ip=$guest_cidr,gw=$guest_gateway,ip6=manual" \
  --nameserver '1.1.1.1 9.9.9.9' --agent enabled=1 --onboot 0
qm start "$vmid"
```

Use the guest console or QEMU agent for the steps below. Install Git,
curl, CA certificates, and the native Node build prerequisites (Python 3,
make, g++) from Debian. Install Tailscale via its
[Debian package instructions](https://tailscale.com/kb/1031/install-linux).
Keep SSH and forwarding of dashboard, MCP, or VNC ports off the LAN uplink.
Set the guest to reject accepted subnet routes. Leave exit-node use,
route advertisement, Tailscale SSH, and Funnel off.

## Review the tailnet grants

Review the policy with the Owner. Merge these entries into the existing
policy only at go-live. Replace the Owner email and per-Agent Tailscale IPv4
addresses. The ports below are examples from the registration contract.
Substitute the actual API, websockify and Chrome DevTools ports for each
Agent, including when they differ between Agents.

```jsonc
{
  "tagOwners": {
    "tag:bot-hq": ["owner@example.com"]
  },
  "hosts": {
    "hq-agent-sam": "SAM_TAILSCALE_IPV4/32",
    "hq-agent-stacy": "STACY_TAILSCALE_IPV4/32",
    "hq-agent-tyler": "TYLER_TAILSCALE_IPV4/32"
  },
  "grants": [
    {"src": ["owner@example.com"], "dst": ["tag:bot-hq"], "ip": ["tcp:443"]},
    {"src": ["tag:bot-hq"], "dst": ["hq-agent-sam"], "ip": ["tcp:8642", "tcp:6080", "tcp:9222"]},
    {"src": ["tag:bot-hq"], "dst": ["hq-agent-stacy"], "ip": ["tcp:8642", "tcp:6080", "tcp:9222"]},
    {"src": ["tag:bot-hq"], "dst": ["hq-agent-tyler"], "ip": ["tcp:8642", "tcp:6080", "tcp:9222"]},
    {"src": ["tag:agent"], "dst": ["tag:bot-hq"], "ip": ["tcp:8787"]}
  ]
}
```

[Tailscale grants](https://tailscale.com/docs/features/access-control/grants)
are additive. Review existing ACLs and grants for broader matches,
including wildcard sources or destinations. Use policy tests to check that
Bot HQ can reach each Agent's three ports and cannot reach any Keep node
or service. Check that Agents can reach HQ TCP 8787 and cannot reach 443,
and that unrelated tailnet devices cannot reach either listener. For
example, add these tests to the policy after replacing the ports and the
Keep alias with the actual values:

```jsonc
"tests": [
  {
    "src": "tag:bot-hq",
    "accept": ["hq-agent-sam:8642", "hq-agent-sam:6080", "hq-agent-sam:9222",
               "hq-agent-stacy:8642", "hq-agent-stacy:6080", "hq-agent-stacy:9222",
               "hq-agent-tyler:8642", "hq-agent-tyler:6080", "hq-agent-tyler:9222"],
    "deny": ["KEEP_TAILNET_HOST:8006"]
  },
  {"src": "tag:agent", "accept": ["tag:bot-hq:8787"], "deny": ["tag:bot-hq:443"]}
]
```

Extend the deny tests to the actual Keep hosts and services in the Atlas
inventory.

After approval, enroll the new VM from its console and complete sign-in
with the Owner:

```sh
sudo tailscale up --hostname=bot-hq --advertise-tags=tag:bot-hq \
  --accept-routes=false --ssh=false
tailscale status --json
```

Verify the dedicated tag and use the actual FQDN from `Self.DNSName`
(without its trailing dot) in the environment file below.

## Stage and activate a pinned release

Install the verified Node version used for the local build. From a
temporary directory on the Debian guest:

```sh
node_dist=node-v24.22.0-linux-x64
curl -fSLO "https://nodejs.org/dist/v24.22.0/$node_dist.tar.xz"
printf '%s  %s\n' cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008 \
  "$node_dist.tar.xz" | sha256sum -c -
sudo tar -xJf "$node_dist.tar.xz" -C /usr/local/lib
sudo ln -sfn "/usr/local/lib/$node_dist/bin/node" /usr/local/bin/node
sudo ln -sfn "/usr/local/lib/$node_dist/bin/npm" /usr/local/bin/npm
```

From a checkout of the reviewed Bot HQ release, create the service user and
configuration on first install:

```sh
getent passwd bot-hq >/dev/null ||
  sudo useradd --system --user-group --home-dir /var/lib/bot-hq --shell /usr/sbin/nologin bot-hq
sudo install -d -o root -g bot-hq -m 0750 /var/lib/bot-hq /etc/bot-hq
sudo install -d -o bot-hq -g bot-hq -m 0750 /var/lib/bot-hq/releases /var/lib/bot-hq/data
sudo install -o root -g root -m 0755 scripts/stage-atlas-release.sh /usr/local/sbin/stage-bot-hq-release
sudo install -o root -g root -m 0644 ops/atlas/bot-hq.service /etc/systemd/system/bot-hq.service
sudo install -o root -g bot-hq -m 0640 ops/atlas/runtime.env.example /etc/bot-hq/runtime.env
sudoedit /etc/bot-hq/runtime.env
```

Fill in the actual URLs, Owner email and a fresh random session secret.
Preserve `runtime.env` on upgrades and restores. The secret signs Agent
MCP credentials. Keep the Database, Library and environment file on the VM's
backed-up disk. Use the platform's existing credential workflow if enabling
xAI.

Set `revision` to the full reviewed SHA from the Owner's fork. Stage as the
service user, then switch the release symlink. Record the previous symlink
target before switching during an upgrade.

```sh
cd /var/lib/bot-hq
sudo -H -u bot-hq /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/sbin/stage-bot-hq-release "$revision"
sudo ln -sfn "/var/lib/bot-hq/releases/$revision" /var/lib/bot-hq/current.next
sudo mv -Tf /var/lib/bot-hq/current.next /var/lib/bot-hq/current
sudo systemctl daemon-reload
sudo systemctl enable bot-hq.service
sudo systemctl restart bot-hq.service
curl -fsS http://127.0.0.1:18787/api/health
ss -ltn 'sport = :18787'
```

Confirm Node listens on `127.0.0.1:18787`. Serve the UI and MCP after the
local health check and grant review. The repeated `/mcp` preserves the
backend's path when Serve strips the mount prefix.
See [Serve](https://tailscale.com/docs/features/tailscale-serve) and the
[Serve path behavior](https://github.com/tailscale/tailscale/issues/12413).

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:18787
sudo tailscale serve --bg --https=8787 --set-path=/mcp http://127.0.0.1:18787/mcp
sudo tailscale serve status --json
sudo tailscale funnel status
```

Create the Owner's one-time login from the VM console:

```sh
cd /var/lib/bot-hq/current
sudo ENV_FILE=/etc/bot-hq/runtime.env bash scripts/sign-in-link.sh "$owner_email"
```

Register Sam, Stacy and Tyler per the [Agent hand-off](remote-agents.md).
Download the per-bot MCP settings and deliver them through the approved Agent
configuration workflow. Use the HTTPS MCP endpoint on port 8787.

## Verify and record

| Probe | Expected |
| --- | --- |
| Owner's tailnet device opens 443 and signs in | HTTPS, then a stream and live noVNC watch/control |
| Each Agent calls its own `/mcp/<botId>` on TCP 8787 | Authenticated JSON-RPC `ping` succeeds. Missing or wrong bearer returns 401 |
| Agent requests `/api/health` and `/mcp/../api/health` on 8787 | No app response. Use `curl --path-as-is` for the traversal probe |
| Agent tries the 443 UI. Unrelated tailnet device tries both ports | Access denied |
| Bot HQ checks each Agent's API health, screen and DevTools | The exact registered ports respond |
| Bot HQ probes known Keep LAN, tailnet and home WAN paths | Keep endpoints unavailable via either path. Home router services unavailable |
| LAN and off-tailnet probe the guest | HQ ports are inaccessible. Serve status shows private listeners with no Funnel |

Add the VM to Atlas's existing nightly PBS job. Check the VMID in a
successful encrypted snapshot and restore it into an isolated guest to
verify that the database, Library, environment and release can be read.
After acceptance, set `qm set "$vmid" --onboot 1` and verify after a reboot.
Record the actual VMID, release SHA, approved policy revision, probe results
and PBS snapshot on #354.

For a release rollback, switch `current` back to the previous staged SHA
and restart `bot-hq.service`. Retain the database and use a pre-upgrade
PBS snapshot if a future schema change requires restoring state. To take
HQ offline, stop its service and turn off the two Serve handlers during
the go-live session.
