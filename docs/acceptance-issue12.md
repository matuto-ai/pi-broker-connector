# Pi setup, upgrade and lifecycle reference

The implementation history and historical native acceptance evidence are recorded
in [issue #12](https://github.com/matuto-ai/pi-psst-connector/issues/12) and
[PR #28](https://github.com/matuto-ai/pi-psst-connector/pull/28). They are historical
observations, not executable gates in the current repository.

[Issue #30](https://github.com/matuto-ai/pi-psst-connector/issues/30) removes the
native-host, PTY, real-broker, upgrade and container harnesses in favor of focused
connector unit tests. Run `npm run check` and `npm test`. These tests use controlled
Pi/client doubles and isolated local state; passing them does not establish native
host, deployed broker, authenticated provider or container acceptance.

## Short user workflow

1. Install the reviewed connector source with `pi install` inside the same environment
   as Pi. Keep only one source for this connector in `pi list`.
2. In Pi, use `/reload`, then `/psst-status`. Check the loaded connector and Node
   versions. Node must be `>=24.19.0 <25`; npm installation despite `EBADENGINE`
   does not establish runtime readiness.
3. For first setup, use `/psst-setup` and enter only the HTTPS broker URL. Match the
   request reference in the administrator's form UI and approve it there. The
   pending native conversation attaches automatically. No token or secret goes in chat.
4. Use `broker_identity`/`broker_list_clients`, then `broker_send` to an exact
   recipient ID. An accepted/queued send is not a delivery or work-completion claim.
   Incoming messages enter the idle native conversation automatically.
5. Exit normally and use interactive `/resume` to choose the original conversation
   when needed. `/new` deliberately gets a different mailbox. Preserve the selected
   agent directory across container recreation; project names do not share mounts.
6. On an old loaded interface, cancel the form and restart Pi, then `/resume` the
   same conversation. On setup failure, use `/psst-status` and read-only
   `/psst-doctor`. Never delete authorization, lock or inbox files to hide a failure.
