# hackfedd

Hackfed's host agent generates WireGuard and Asterisk configuration from the
published directory.

## Run

Requires Bun 1.3.6 or newer.

```bash
bunx hackfed/hackfedd agent --config /etc/hackfedd/config.yaml
```

Validate a configuration without starting services:

```bash
bunx hackfed/hackfedd check-config --config /etc/hackfedd/config.yaml
```

See [`examples/config.example.yaml`](examples/config.example.yaml) for all
settings.

## Asterisk

With `telephony.output.type: asterisk`, hackfedd validates `telephony.json`,
selects the local exchange, and writes exactly three generated fragments:

- `iax.conf`
- `extensions-inbound.conf`
- `extensions-outbound.conf`

The outbound context is `[hackfed-outbound]`. It includes a local loopback route
derived from this node's directory prefix, so dialing the full local Hackfed
number reaches the corresponding PJSIP extension without changing caller ID.
Canonical `+`-prefixed and legacy digit-only Hackfed numbers are both accepted;
canonical numbers are normalized to digits before internal and IAX routing.
Generated inbound peer contexts call the operator-owned
`HackfedIncomingRouter` Gosub and pass the local subscriber suffix as `ARG1`, or
an empty value for a call to the exact local prefix.

At the Hackfed boundary, caller numbers are canonicalized to E.164-style
`+<organization-prefix><subscriber>`. Extension-only and already-complete local
caller numbers are supported; a caller claiming another organization's prefix
is rejected. Inbound calls accept canonical or legacy digit-only caller numbers,
verify the sending peer's prefix, and deliver the canonical `+` form locally.
Inbound caller names are prefixed with the verified organization name (for
example, `BKSP: Alice`); an empty caller name is presented as just `BKSP`.

The daemon never edits parent Asterisk or FreePBX files. Follow either the
[`standalone Asterisk`](examples/asterisk/standalone/README.md) or
[`FreePBX 17`](examples/asterisk/freepbx/README.md) integration instructions to
add the one-time includes and create the AMI account. The configured output
directory is maintained with mode `0755`, and generated fragments with mode
`0644`, so Asterisk process could traverse and read them.

> [!IMPORTANT]
> The directory currently publishes no IAX authentication credentials.
> Generated peers therefore rely on the Hackfed WireGuard mesh as their trust
> boundary. Restrict UDP/4569 to that interface and do not expose it publicly.

## WireGuard

The `cmd` strategy uses `wg-quick` for startup and `wg syncconf` for updates.
The `systemctl` strategy restarts `wg-quick@<interface>.service`; wg-quick does
not provide a supported reload operation. Ignored organizations and this
node's own directory address are omitted from the rendered peer list.

Major local configuration changes, including firewall rules, may still require
an explicit interface restart by the operator.
