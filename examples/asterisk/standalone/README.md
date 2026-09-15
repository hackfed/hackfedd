# Standalone Asterisk

These files are examples to merge deliberately into an operator-managed
Asterisk installation. Do not overwrite an existing installation with them.

1. Configure hackfedd to write to `/etc/asterisk/hackfed`.
2. Add the `#tryinclude` lines shown in `iax.conf` and `extensions.conf` to the
   corresponding parent files.
3. Define `HackfedIncomingRouter` for local routing. The generated inbound
   contexts pass only the subscriber suffix in `ARG1`; an exact-prefix call
   passes an empty value.
4. Configure `manager.conf` and `http.conf`, use the same AMI secret in
   hackfedd, then restrict AMI HTTP to the management host/network.

The daemon generates only `iax.conf`, `extensions-inbound.conf`, and
`extensions-outbound.conf` in its output directory. It never edits the parent
files or the operator-owned inbound router.
