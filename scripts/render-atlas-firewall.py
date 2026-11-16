#!/usr/bin/env python3
"""Render Bot HQ's rules into Atlas's existing sandbox table. Writes only to stdout."""
import argparse
import ipaddress
from pathlib import Path
import re
import sys


def insert_before(source, anchor, rules):
    if source.count(anchor) != 1:
        raise ValueError(f'expected exactly one rule anchor: {anchor.strip()}')
    return source.replace(anchor, rules + anchor, 1)


def render(source, bridge, guest_ip):
    if '# Bot HQ on its isolated bridge' in source:
        raise ValueError('use the unmodified Atlas sandbox firewall as input')
    if f'"{bridge}"' in source or re.search(rf'(?<![0-9.]){re.escape(str(guest_ip))}(?![0-9.])', source):
        raise ValueError('the bridge or guest address already appears in the source rules')
    required = (
        'table inet n8n_sandbox_atlas {',
        'set non_public_ipv4 {',
        'set home_wan_ipv4 {',
    )
    if any(source.count(anchor) != 1 for anchor in required):
        raise ValueError('unexpected Atlas sandbox table or address sets')

    input_header = '    chain input {\n        type filter hook input priority -5; policy accept;\n'
    if source.count(input_header) != 1:
        raise ValueError('expected the Atlas input chain')
    source = source.replace(input_header, input_header + f'        iifname "{bridge}" counter drop\n', 1)

    catch_all = '        iifname "vmbr0" oifname != "vmbr0" counter drop'
    lan_comment = '        # Keep Atlas from routing LAN traffic.'
    forward = '    chain forward {'
    postrouting = '    chain postrouting {\n        type nat hook postrouting priority srcnat; policy accept;\n'
    anchors = (forward, lan_comment, catch_all, postrouting)
    if any(source.count(anchor) != 1 for anchor in anchors) or sorted(anchors, key=source.index) != list(anchors):
        raise ValueError('expected the existing routed-LAN drop')
    source = insert_before(
        source,
        lan_comment,
        f'''        # Bot HQ on its isolated bridge
        iifname "{bridge}" ip daddr @non_public_ipv4 counter drop
        iifname "{bridge}" ip daddr @home_wan_ipv4 counter drop
        iifname "{bridge}" oifname "vmbr0" ip saddr {guest_ip} ct state {{ new, established, related }} counter accept
        iifname "{bridge}" counter drop
        iifname "vmbr0" oifname "{bridge}" ip daddr {guest_ip} ct state {{ established, related }} counter accept
        oifname "{bridge}" counter drop

''',
    )

    nat_rule = f'        iifname "{bridge}" oifname "vmbr0" ip saddr {guest_ip} masquerade\n'
    return source.replace(postrouting, postrouting + nat_rule, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('bridge')
    parser.add_argument('guest_ipv4', type=ipaddress.IPv4Address)
    args = parser.parse_args()

    if not re.fullmatch(r'vmbr[1-9][0-9]{0,3}', args.bridge):
        parser.error('choose a dedicated Proxmox bridge other than vmbr0')
    private = [ipaddress.IPv4Network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    if not any(args.guest_ipv4 in network for network in private):
        parser.error('choose a private IPv4 address')

    try:
        sys.stdout.write(render(args.source.read_text(), args.bridge, args.guest_ipv4))
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
