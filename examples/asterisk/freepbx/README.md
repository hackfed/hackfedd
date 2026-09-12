# FreePBX 17

FreePBX owns and regenerates its parent Asterisk configuration. Never add
hackfedd output directly to generated `iax.conf` or `extensions.conf` files.

1. Configure hackfedd to write its three fragments to
   `/etc/asterisk/hackfed`.
2. Merge the example `iax_custom.conf` and `extensions_custom.conf` snippets
   into the matching FreePBX custom files. In particular, retain any existing
   `[from-internal-custom]` content and add `include => hackfed-outbound`.
3. Customize `HackfedIncomingRouter`; hackfedd never owns or replaces it.
4. In **Settings → Asterisk Managers**, create the `hackfedd` AMI user with a
   strong secret and the `system` and `config` read/write permissions needed by
   the AMI `Reload` action. Do not hand-edit FreePBX's generated manager files.
5. Enable Asterisk's mini-HTTP server in FreePBX Advanced Settings, limit its
   bind address/firewall exposure, and configure hackfedd with the exact
   resulting `/manager` or `/rawman` URI and the GUI-managed credentials.

After starting hackfedd, verify the result from the Asterisk CLI:

```text
iax2 show peers
dialplan show hackfed-outbound
```
