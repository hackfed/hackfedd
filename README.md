# hackfedd

Hackfed's host agent generates WireGuard and Asterisk configuration from the
published directory.

## Install on a Linux host

Install [Bun](https://bun.com/docs/installation) 1.3.6 or newer for root, then
clone a reviewed release tag or commit under `/opt/hackfedd`. The service runs
that checkout directly; restarting it does not select a new daemon version.
Until the first release tag exists, use a reviewed commit SHA for `RELEASE_REF`.

```bash
sudo -i
curl -fsSL https://bun.com/install | bash
/root/.bun/bin/bun --version
RELEASE_REF=your-reviewed-tag-or-commit
git clone https://github.com/hackfed/hackfedd.git /opt/hackfedd
cd /opt/hackfedd
git checkout --detach "$RELEASE_REF"
/root/.bun/bin/bun install --production --frozen-lockfile
install -d -m 0700 /etc/hackfedd
install -m 0600 examples/config.example.yaml /etc/hackfedd/config.yaml
```

Edit `/etc/hackfedd/config.yaml` for this host before starting the service.
The example contains placeholder keys and addresses. See
[`examples/config.example.yaml`](examples/config.example.yaml) for all settings
and the [Asterisk integration instructions](#asterisk) if telephony is enabled.
Validate the configuration, install the unit, and start it:

```bash
/root/.bun/bin/bun /opt/hackfedd/src/index.ts check-config --config /etc/hackfedd/config.yaml
install -m 0644 /opt/hackfedd/examples/hackfedd.service /etc/systemd/system/hackfedd.service
systemctl daemon-reload
systemctl enable --now hackfedd
systemctl status hackfedd
```

To install an update, choose its reviewed tag or commit and run these commands
as root. This also installs any service-unit changes in the selected version.
Use the same commands with the previous tag or commit to roll back.

```bash
RELEASE_REF=your-new-tag-or-commit
cd /opt/hackfedd
git fetch --tags origin
git checkout --detach "$RELEASE_REF"
/root/.bun/bin/bun install --production --frozen-lockfile
/root/.bun/bin/bun src/index.ts check-config --config /etc/hackfedd/config.yaml
install -m 0644 examples/hackfedd.service /etc/systemd/system/hackfedd.service
systemctl daemon-reload
systemctl restart hackfedd
```

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
Inbound caller names are prefixed with the verified short organization ID (for
example, `bksp: Alice`); an empty caller name is presented as just `bksp`.
Connected-line updates are passed over IAX and prefixed by the destination's
short organization ID, so a remote extension can be displayed as `xkem: Alice`
to the caller. The full organization display name is not used in either prefix.

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

## Development

The agent starts the enabled services in `src/cmds/agent`. Each service reads a
validated directory document through `src/lib/common/directory.ts`, applies it
once at startup, then polls for updates. The directory saves a new ETag only
after its change handlers succeed. A handler can return `false` after applying
the healthy part of a document, so the next poll retries the same document.

WireGuard keeps its lifecycle in `src/lib/wireguard/index.ts`; the pure peer
filtering and DNS checks live in `src/lib/wireguard/peers.ts`. It omits local,
ignored, or temporarily unresolvable peers, renders the wg-quick Eta template,
and reloads only when the generated file changes. Asterisk builds a validated
peer model in `src/lib/asterisk/render.ts` and renders the three Eta templates in
`src/lib/asterisk/templates/`. It tracks which Asterisk modules need a reload;
failed reloads stay pending for the next update. Generated files use the shared
atomic writer in `src/lib/common/atomic-file.ts`.

Run `bun test` for the directory, rendering, and lifecycle tests, and
`bun run lint` for TypeScript and style checks.
CI and deployment use Bun's lockfile; install with `bun install --frozen-lockfile`.
The pnpm lockfile remains available for contributors who use pnpm locally.
