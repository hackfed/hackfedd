# Agent • Hackfed

Agent for Hackfed.

Requires Bun to run.

## Installation

### WireGuard

```bash
touch /etc/wireguard/hackfed0.conf
systemctl enable wg-quick@hackfed0
systemctl start wg-quick@hackfed0

# Check whether the interface is up
wg

# Only now you can start the agent
```

> [!WARNING]
> You still need to restart the interface (up + down) to apply major changes, including firewall rules.

## Example

```bash
bunx @hackfed/hackfedd
```
