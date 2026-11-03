# Pi setup, upgrade and lifecycle acceptance

This record closes the implementation/test gaps in issue #12 without claiming a
release, production deployment, access to an owner's credentials, or real-provider
inference. Existing owner evidence in #12 already records URL-only approval,
multiple distinct native recipients, send/receive and successful interactive resume.
The tests below use official Pi 1.4.0 and an independently authenticated disposable
HTTPS broker. They are not manifests or faux-model responses alone.

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

## Reproduced reload defect and recovery

The historical owner-specific 0.3.1 → 0.4.0 failure is not reproduced in the
controlled official host: that transition loads the URL-only implementation.
However, the subsequent 0.4.0 → current transition reproduced stale transitive
ESM modules after the installed files changed and `/reload` completed. The loaded
commands still lacked the current doctor/runtime diagnostics. Restarting the
process loaded the correct graph. These are separate observations, not a claim
about the cause of the owner's earlier failure.

Pi's injected synchronous loader refreshes the owned graph on reload. The entry
now uses that loader after the runtime preflight, and owned approval/enrollment
imports are static rather than crossing back into Node's persistent ESM cache.
Vendored files are unchanged. Unsupported runtime never loads the SQLite-backed
implementation. A second actual-host defect hid earlier `/psst-status`/doctor
notifications when Pi coalesced several updates. Both commands now emit one
complete notification; the upgrade test asserts the new runtime version is
actually visible in terminal output, not just loaded in memory.

`upgrade-native.probe.mjs` installs exact historical 0.3.1 and 0.4.0 sources with
the real bundled CLI, then the candidate. It records installed versions separately
from actual loaded commands/modules. A second same-path update changes temporary
fixture modules and the manifest version, proving transitive refresh, not merely
entry reevaluation. One native conversation, saved selection, approved credential,
broker client ID and queued inbox survive every transition and process reopen;
the retained message occurs once in native history. Test-only instrumentation is
confined to disposable source copies and is never shipped in the package.

## Executable acceptance map

- `approval-native.probe.mjs`: actual bundled CLI URL-only input, pending request,
  authenticated administrator form approval, verified TLS, automatic native
  receipt; closed pending CLI, approval while offline and reopen; destroyed HOME
  and recreated Docker container retaining only the documented agent directory.
  Also 30 official SDK sessions share one approval but have distinct mailboxes,
  with zero model calls for startup/polling.
- `native-acceptance.probe.mjs`: two actual bundled CLI processes, native
  `broker_send` execution in both directions, authenticated broker traffic,
  automatic native context/provenance, actual draft/prompt/abort boundaries,
  normal exit, offline queued send and interactive `/resume` of the original
  conversation, plus administrator revocation with pending inbox preserved.
  The official local faux provider supplies deterministic model responses; no
  hosted model account or live user workspace is used.
- `authorization-native.probe.mjs`: actual replacement confirmation cancellation,
  administrator denial, retained working selection/credential/native recipient
  and reload without another request.
- `runtime-native.probe.mjs`: actual Node 22.22.2 and official bundled CLI explain
  unsupported runtime, with an intentionally forbidden adapter graph and existing
  selection bytes unchanged. Supported Node 24.19+ behavior is covered by normal
  host/container checks and the version-boundary unit matrix.
- `connect-command`, `connect-config`, `native-setup`, `approval-watch` and
  `setup-diagnostics`: durable intent, selection CAS, lost/late/duplicate results,
  cancellation, restart, terminal decisions, explicit replacement, origin binding,
  corrupt/unsafe state, metadata-only preflight and secret-free diagnostics.
- `message-operations` and `native-host`: real broker discovery pagination including
  offline peers, unchanged filter forwarding, and real host TypeBox rejection of
  invalid booleans/limits/cursors. `connected:false` includes offline and online.
- `connect-command`, `roundtrip`, `graceful-disconnect`, `native-expiry` and presence
  tests: exclusive owner rejection and normal release/resume, crash/lease fallback,
  normal detach versus permanent retirement, unread preservation and distinct new
  conversations. The ownership warning names a sanitized local conversation but
  does not infer an active competing process from `owner_conflict` alone.

## Reproduction and limits

`npm run check` and `npm test` are the cheap first gate. `npm run test:host`,
`npm run test:approval` and `npm run test:native` use the pinned fixtures and
`PI_TEST_*` paths in `.github/workflows/verify.yaml`. The workflow then builds the
pinned Node 24.19.0 image and reruns native approval/persistence with Docker.
Sources, commands and fixture boundaries remain reviewable; credentials and raw
private files are not published as evidence.

A green exact-head workflow establishes these automated native, protocol and
container paths. It does not establish npm publication, configuration of the
owner's deployed broker, root cause of historical local setup errors, or real
provider inference. No production deployment or additional enrollment is needed
to complete this issue's implementation and regression coverage.
