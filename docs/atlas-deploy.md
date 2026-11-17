# Bot HQ on atlas

Use during the Owner-approved go-live session for [#354](https://github.com/devdogfish/quantself/issues/354).
Bot HQ runs in its own guest and listens on loopback. Tailscale Serve exposes
the Owner's HTTPS UI on TCP 443 and the Agents' MCP path on TCP 8787. There
is no public ingress.

## Provision the guest

On Atlas, use `qm list` and `ip -4 route show table all` to check the VMID
and subnet. The preflight found VMID 3100 and `172.28.229.8/30` unused,
with room on `local-lvm`. Recheck before creating anything. Use 2 vCPUs,
4 GiB RAM and a 24 GiB boot disk. Record the image or template, storage,
VMID and network in the go-live record. Use the QEMU guest agent for
administration. The Proxmox console is available for boot diagnostics.

Reserve an unused private subnet and a dedicated routed/NAT bridge. The
[existing Atlas sandbox firewall](https://github.com/devdogfish/quantself/tree/main/automation/n8n/assistant-sandbox)
drops routed traffic from `vmbr0` to other bridges unless the existing
forward chain accepts it first. Render Bot HQ's rules into that same chain.
This puts a narrow return rule for the Bot HQ guest before the catch-all
and retains the n8n rules. An accept in a separate nftables base chain
cannot bypass this drop.

From the Atlas console, use `bridge`, `guest_cidr` and `guest_gateway` from
the reserved network. Keep an unmodified copy of
`/etc/n8n-sandbox/atlas.nft` and compare it with the active ruleset before
rendering. Use the current installed file as the input on first install.

```sh
candidate=$(mktemp)
sudo python3 scripts/render-atlas-firewall.py /etc/n8n-sandbox/atlas.nft \
  "$bridge" "${guest_cidr%/*}" > "$candidate" &&
  sudo nft --check --file "$candidate" &&
  sudo diff -u /etc/n8n-sandbox/atlas.nft "$candidate"
```

A successful syntax check followed by a nonempty diff is expected. The new bridge permits IPv4 internet egress and
established replies only for the Bot HQ address. The shared private and
home-WAN sets block access to Keep, the LAN and the router's WAN address.
The existing WAN refresh timer also updates the shared set for Bot HQ.
Host input from the new bridge and other forwarded traffic to or from it
are dropped, including IPv6 and unsolicited LAN traffic.

At go-live, retain the original file for rollback. Load the checked
candidate in one `nft -f` transaction and install the same file at
`/etc/n8n-sandbox/atlas.nft` so the existing sandbox initialization and
WAN timer retain the rules. Add a stanza like this under
`/etc/network/interfaces.d/` with the reserved host CIDR and bridge name:

```ini
auto BOT_HQ_BRIDGE
iface BOT_HQ_BRIDGE inet static
    address BOT_HQ_HOST_CIDR
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up sysctl -qw net.ipv4.conf.BOT_HQ_BRIDGE.forwarding=1 net.ipv6.conf.BOT_HQ_BRIDGE.disable_ipv6=1
```

Ensure the existing uplink `vmbr0` keeps IPv4 forwarding enabled. Bring up
only the new bridge with `ifup "$bridge"`.
To roll back the network changes, shut down the Bot HQ guest, restore and
load the saved firewall file, and remove the new bridge.

With the bridge and firewall in place, set the variables from the Atlas
inventory. If using a clean Debian 13 amd64 cloud-init template with the
QEMU guest agent enabled, clone it:

```sh
qm clone "$template_vmid" "$vmid" --full 1 --name bot-hq --storage "$storage"
```

The preflight found no template on Atlas. Use this fallback with the
[Debian cloud image](https://www.debian.org/distrib/#cloud) and the
[Proxmox import procedure](https://github.com/proxmox/pve-docs/blob/master/qm-cloud-init.adoc).
Allow at least 1 GiB of free space in the staging directory on Atlas.
The commands assume a checkout of the reviewed Bot HQ revision and
`local` storage at `/var/lib/vz`. They add the `snippets` content type
if needed while preserving the existing storage content types.

```sh
image=debian-13-generic-amd64-20261111-2659.qcow2
image_dir=$(mktemp -d)
curl --fail --show-error --silent --location \
  "https://cloud.debian.org/images/cloud/trixie/20261111-2659/$image" \
  --output "$image_dir/$image"
printf '%s  %s\n' \
  ec8c175e39d59e711798c3a2f22ba11b9aee9bca1887c7e505a800aeffd5d7616099bd0e9fad869efba96100fe09d2c8b49d6d7001d501f0056c556bdc25b605 \
  "$image_dir/$image" | sha512sum -c -
```

Continue only after the checksum passes. Install the cloud-init snippet
from the release checkout before creating the VM. It brings up the guest
agent and masks SSH without adding login credentials.

```sh
set -e
content=$(pvesh get /storage/local --output-format json | \
  python3 -c 'import json, sys; print(json.load(sys.stdin)["content"])')
case ",$content," in
  *,snippets,*) ;;
  *) pvesm set local --content "$content,snippets" ;;
esac
install -d -m 0755 /var/lib/vz/snippets
snippet="bot-hq-$vmid.yaml"
test ! -e "/var/lib/vz/snippets/$snippet"
install -m 0644 ops/atlas/cloud-init.yaml "/var/lib/vz/snippets/$snippet"
qm create "$vmid" --name bot-hq --ostype l26 --scsihw virtio-scsi-pci \
  --serial0 socket --vga serial0 --onboot 0
qm set "$vmid" --scsi0 "$storage:0,import-from=$image_dir/$image" \
  --ide2 "$storage:cloudinit" --boot order=scsi0 \
  --cicustom "user=local:snippets/$snippet"
qm disk resize "$vmid" scsi0 24G
```

For either path, set the network, then verify `qm config` and the
generated cloud-init network config before starting. As of the preflight,
the proposed values were `vmbr3100`, `172.28.229.10/30`, and gateway
`172.28.229.9`.

```sh
qm set "$vmid" --cores 2 --memory 4096 --net0 "virtio,bridge=$bridge,firewall=1" \
  --ipconfig0 "ip=$guest_cidr,gw=$guest_gateway" \
  --nameserver '1.1.1.1 9.9.9.9' --agent enabled=1 --onboot 0
qm config "$vmid"
qm cloudinit dump "$vmid" network
```

Omit `ip6=manual`. On Atlas, Proxmox renders it as the static IPv6
address `manual`, which makes Debian cloud-init reject the entire network
configuration. The bridge already disables host IPv6 and drops routed
IPv6 traffic. Check the generated seed for the intended IPv4 CIDR and
gateway before boot.

Start with `qm start "$vmid"`. Allow cloud-init to finish and use
`qm guest cmd "$vmid" ping` to check readiness. Probe both guests'
internet egress and check that neither can reach Keep or the LAN.
If an import or start fails, check the original Proxmox task and the
VM's config before retrying.

Use the QEMU guest agent for the steps below. Install Git, curl,
CA certificates, and the native Node build prerequisites (Python 3, make,
g++) from Debian. Install Tailscale via its
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
sudo install -o root -g root -m 0755 scripts/activate-atlas-release.sh /usr/local/sbin/activate-bot-hq-release
sudo install -o root -g root -m 0644 ops/atlas/bot-hq.service /etc/systemd/system/bot-hq.service
sudo install -o root -g bot-hq -m 0640 ops/atlas/runtime.env.example /etc/bot-hq/runtime.env
sudoedit /etc/bot-hq/runtime.env
```

Fill in the actual URLs, Owner email and a fresh random session secret.
Preserve `runtime.env` on upgrades and restores. The secret signs Agent
MCP credentials. Keep the Database, Library and environment file on the VM's
backed-up disk. Use the platform's existing credential workflow if enabling
xAI.

Set `revision` to the full reviewed SHA from the Owner's fork. The
activation script stages as the service user, verifies the release files
and commit, and only then swaps `current` and restarts the service. A
staging or verification failure leaves the current release and service
alone. Record the previous target printed by the script.

```sh
sudo /usr/local/sbin/activate-bot-hq-release "$revision" &&
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

Have the Owner run this from the VM console and open the one-time login
link privately:

```sh
cd /var/lib/bot-hq/current
sudo ENV_FILE=/etc/bot-hq/runtime.env bash scripts/sign-in-link.sh "$owner_email"
```

Register Sam, Stacy and Tyler per the [Agent hand-off](remote-agents.md).
Download the per-bot MCP settings and deliver them through the approved Agent
configuration workflow. Use the HTTPS MCP endpoint on port 8787.

## Monitor Agent gateways

Set `HQ_AGENT_HEALTH_TARGETS` in `runtime.env` to comma-separated
`name=tailnet-ipv4` entries for the Agent gateways already in service. Begin
with `HQ_AGENT_HEALTH_TARGETS=tyler=100.112.180.120`. The allowed targets are
addresses in `100.64.0.0/10` on the Agent gateway port `8642`.

In Uptime Kuma on Atlas VM 3358, add one HTTPS GET check every 60 seconds
for each configured name. Start with
`https://bot-hq.tail555ca5.ts.net/api/agent-health/tyler`. Require trusted TLS,
HTTP 200, and zero redirects. The route reads the Agent's `/health` from Bot
HQ on VM 3100.
It returns 503 when the gateway is unhealthy and 404 for an unconfigured
name. Kuma uses the existing Apps-to-Bot HQ HTTPS grant. Add the exact
monitor name to the existing Kuma Healthchecks publisher after confirming
its first healthy heartbeat.

## Optional email from Owner chat

Email stays disabled until the Bot HQ service has valid sender mappings,
recipient settings and dedicated SES credentials. A clear request to email
the Owner authorizes one message from that Agent in the same authenticated
chat turn. When confirmation is needed, the approval card shows the exact
message and all recipients. The MCP tool stages the message. Bot HQ
requires the proposal receipt from the matching active Hermes tool event
before it can send, then posts the SES result in chat. Routines prepare
drafts.

Set these values in the private `/etc/bot-hq/runtime.env`. Map each sender
role to the exact ID of its registered Bot HQ Agent. Bot HQ derives the From
address from that role and the verified domain and sends to all three Owner
addresses. For example, use this format with your own configuration.

```dotenv
HQ_OWNER_EMAIL_TARGETS='{"tyler":"bot_example_tyler","stacy":"bot_example_stacy","sam":"bot_example_sam"}'
HQ_OWNER_EMAIL_TO='["owner@example.org","owner-alt@example.org","owner@example.net"]'
HQ_OWNER_EMAIL_FROM_DOMAIN=example.net
BOT_HQ_EMAIL_SES_ACCESS_KEY_ID=
BOT_HQ_EMAIL_SES_SECRET_ACCESS_KEY=
```

Use a dedicated IAM principal restricted to `ses:SendEmail` in
`ca-central-1`, with the verified identity, exact From addresses, and exact
recipient allowlist. Keep the credentials on the Atlas Bot HQ service and
check that Agent hosts have no SES credentials. [SES IAM conditions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:ca-central-1:111122223333:identity/example.net",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": ["tyler@example.net", "stacy@example.net", "sam@example.net"]
        },
        "ForAllValues:StringEquals": {
          "ses:Recipients": ["owner@example.org", "owner-alt@example.org", "owner@example.net"]
        },
        "Null": { "ses:Recipients": "false" }
      }
    }
  ]
}
```

Verify clear chat, approval, routine denial and uncertain send handling using
mocked SES first. Obtain the Owner's named approval for the Atlas activation,
scoped live verification and rollback. Send harmless test mail to the approved
inboxes and record status and SES receipt IDs. If activation fails, restore the
previous reviewed release and runtime settings, then verify service health.

For an unconfirmed submission, keep the matching request on hold. Inspect
the exact `owner_email_sends` row by bot ID, generation and Owner row
sequence and reconcile against recipient or provider evidence. With the
Owner's named approval for Bot HQ, record `accepted` and the receipt ID
when delivery is confirmed, or `rejected` when the provider proves refusal.
Keep unresolved rows across restarts and upgrades.

## Verify and record

| Probe | Expected |
| --- | --- |
| Owner's tailnet device opens 443 and signs in | HTTPS, then a stream and live noVNC watch/control |
| Each Agent calls its own `/mcp/<botId>` on TCP 8787 | Authenticated JSON-RPC `ping` succeeds. Missing or wrong bearer returns 401 |
| Agent requests `/api/health` and `/mcp/../api/health` on 8787 | No app response. Use `curl --path-as-is` for the traversal probe |
| Agent requests `/mcp/../api/agent-health/tyler` on 8787 | Agent health status is inaccessible. Use `curl --path-as-is` |
| Agent tries the 443 UI. Unrelated tailnet device tries both ports | Access denied |
| Bot HQ checks each Agent's API health, screen and DevTools | The exact registered ports respond |
| Bot HQ probes known Keep LAN, tailnet and home WAN paths | Keep endpoints unavailable via either path. Home router services unavailable |
| LAN and off-tailnet probe the guest | HQ ports are inaccessible. Serve status shows private listeners with no Funnel |

## Nightly backup and isolated restore

Atlas's existing `backup` storage has client encryption disabled. In
Proxmox, have the Owner configure a dedicated PBS storage alias
`backup-bot-hq` on Atlas with client encryption enabled. Use the approved
datastore and credentials. Leave the coding VM's storage and job alone.
The Owner keeps a copy of the encryption key outside Atlas and PBS. See
[Proxmox PBS encryption](https://github.com/proxmox/pve-docs/blob/master/pve-storage-pbs.adoc#encryption).

After the Owner configures the alias and approves the schedule, check the
storage and create the Bot HQ job. Set `backup_schedule` to the approved
nightly time. Reconcile the existing job before retrying creation.

```sh
backup_storage=backup-bot-hq
sudo test -s "/etc/pve/priv/storage/$backup_storage.enc" &&
  sudo pvesh get "/nodes/atlas/storage/$backup_storage/status" --output-format json |
  python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("active") == 1 else "PBS storage is inactive")' &&
  sudo pvesh create /cluster/backup --id "atlas-bot-hq-$vmid-nightly" \
    --node atlas --vmid "$vmid" --storage "$backup_storage" \
    --mode snapshot --schedule "$backup_schedule" --remove 0
```

Seed a test file in the Bot HQ Library and record its path and SHA-256.
Run the job once from the Proxmox UI, wait for the task to finish, then
verify the snapshot belongs to the Bot HQ VM and is marked encrypted in
PBS. Record its volume ID as `snapshot_volume`.

For the restore drill, verify that the approved `restore_vmid` is unused.
Restore without starting the VM or enabling boot and wait for the restore
task to succeed. Check the restored disks belong to the restore VM.

```sh
sudo pvesh create /nodes/atlas/qemu --archive "$snapshot_volume" \
  --vmid "$restore_vmid" --storage "$storage" --unique 1 \
  --start 0 --onboot 0 --autostart 0
sudo qm config "$restore_vmid"
```

While the clone is stopped, detach its network interface and cloud-init
drive. For the fresh-image configuration above, remove `net0`, `ide2`
and `cicustom` from the clone's config. Recheck that it has no NIC,
passthrough device, shared mount or boot hook, then start it. Keep it
disconnected throughout the drill. Within the clone, use QEMU guest
exec to confirm the running app answers `127.0.0.1:18787/api/health`,
SQLite `PRAGMA quick_check` returns `ok`, the test Library file matches
its digest, the runtime env file exists, and `current` points to the
reviewed release. Check the guest command's `exitcode` and record results
without displaying the env file or database rows. Shut down the restore VM.

After acceptance, set `qm set "$vmid" --onboot 1` and verify after a reboot.
Record the actual VMID, release SHA, approved policy revision, probe results
and PBS snapshot and restore results on #354.

For a release rollback, switch `current` back to the previous staged SHA
and restart `bot-hq.service`. Retain the database and use a pre-upgrade
PBS snapshot if a future schema change requires restoring state. To take
HQ offline, stop its service and turn off the two Serve handlers during
the go-live session.

For offline verification, run
`python3 tests/atlas-ops.py /path/to/unmodified/n8n-sandbox/atlas.nft`.
This exercises the render against the sandbox rules and checks activation
failure and success with a temporary release tree and mocked service commands.
