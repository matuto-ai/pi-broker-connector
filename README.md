# Psst connector for Pi

A native Pi extension providing durable, session-bound messaging through the [Psst broker](https://github.com/matuto-ai/psst). Runs **inside the Pi process in your existing sandbox**. No host launcher, local model, provider subscription, or additional service is required by the connector.

**Version 0.7.0 (unreleased source candidate):** readable native Psst history cards (sender/text by default, metadata on expansion), plus automatic-only production delivery, internal durable send identity, sent history/content/resend/cancel tools, readable native-session metadata, compact incoming messages and safe setup diagnostics. Existing URL-only approval, session isolation and receipt recovery are retained. Tested with the official Pi 1.4.0 bundled CLI and SDK, authenticated disposable HTTPS broker/admin UI, native tool round trips and upgrade/resume. Exact-head CI also gates Docker persistence. Model responses are local fixtures; these tests do not access the owner’s provider account or certify a production deployment. See the [acceptance record](docs/acceptance-issue12.md).

## Requirements

- Node **24.19+ within major 24** and Pi **1.4.0** (the tested host version).
- A reachable HTTPS Psst broker with the **administrator-approval API** enabled and an administrator able to approve this installation in the broker UI. `/healthz` success or the broker URL alone does not authorize access. Existing connection bundles remain a compatibility option.
- Writable local persistent storage, not a shared/NFS directory. Preserve it across sandbox recreation if you want to resume the same Pi session.

The connector vendors the broker's dependency-free client; it does not fetch broker code at runtime. Pi supplies `typebox` and its host API as peer dependencies.

## Install

Run the commands **inside the sandbox where Pi runs**, not on the host.

### From a reviewed checkout (works without npm publication)

```sh
pi install /absolute/path/to/pi-psst-connector
```

Or use the reviewed default branch:

```sh
pi install git:github.com/matuto-ai/pi-psst-connector
```

This uses the default branch. To pin a reviewed commit, append `@` and its exact SHA. Existing tags are unchanged and may still contain the old npm package identity; do not use an old tag as evidence of the new scope. Publish a new package version only after its source changes have been reviewed and the owner is ready to release it.

### From npm (only after publication)

```sh
pi install npm:@matuto-ai/pi-psst-connector@0.7.0
```

The command requires the version to be present on npm. If publication is still pending, use a reviewed checkout instead.

### Connect once inside Pi — just the URL

After installing/updating, use `/reload`, then `/psst-status` to verify the loaded connector/runtime.
Use `/psst-setup` **without arguments** only for first-time or explicitly approved replacement setup.
If the loaded commands still show the old secret-entry form, cancel it: do not enter an admin password.
The owner previously observed an older secret form after reload; its historical cause is
unconfirmed. The supported-host regression now installs 0.3.1, updates to 0.4.0, then
to this source and verifies the implementation actually loaded at each step. It also
verifies repeated same-path updates and exact-conversation reopen without enrollment
or inbox reset. This source fixes a separately reproduced stale transitive-module
reload. If an older process still shows an old interface, cancel the form, exit Pi
orderly, restart and use `/resume` to choose the same conversation. Check
`/psst-status` again; do not create a new conversation or delete state as recovery.
The native form has one text field: the HTTPS broker URL. There is no pairing
secret to type, copy, distribute or place in a command. The connector generates
and privately saves its candidate credential before requesting access. It returns
to the editor while the administrator approves the exact request in the broker UI.
A URL alone is not authorization: only that approval allows the connection.

When approved, Pi connects and remembers the installation. New native sessions
sharing the persisted agent directory connect automatically, each with a separate
session identity/mailbox. Ordinary startup never creates a request or rotates a
credential. It may resume **status polling only** for a previously saved explicit
pending request; reopening after approval requires no second setup. Transport
polling does not call a model. Network failures retain the same request and key;
missing/corrupt state never silently creates a replacement. Denied/expired/revoked
requests stop and require explicit setup again.

If a previously approved installation now reports `unauthenticated` or
`forbidden`, its cached approval is not current server authorization. Run
`/psst-reauthorize` and explicitly confirm replacement for the displayed broker URL.
Give the newly displayed request ID to the administrator. Repeating setup or
reopening while that candidate is pending reuses it; an approved candidate whose
attachment failed is retried without creating another request. The predecessor
stays selected until the candidate actually connects. Its credentials and unread
journals are preserved, but its access may remain revoked. Do not delete state,
copy credentials or remove locks to recover.

Status reports `cached_approved` as local history, `replacement_pending` while
waiting for replacement approval, and `connected` only after actual attachment.
A retained setup intent can be a completed selection shared by waiting native
sessions; it does not itself permit replacement. Restart, reconnect, a 401 or
incoming peer input never creates a replacement request.


`/psst-disconnect` durably cancels only this native session's pending wait and
stops its transport/delivery; it does not revoke credentials or cancel other
sessions' shared installation request. A late approval cannot reconnect that
locally disconnected session, even after reload. Shutdown preserves a pending wait for reopen.
Explicit replacement asks for confirmation and leaves the previous
selection in place until approval and successful attachment. Concurrent selection
changes are compare-and-swap protected. Old inbox data is never deleted or adopted
by a new credential.

The nonsecret URL, pending intent and selected bundle path are remembered in
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/psst/selection.sqlite`. Candidate credentials
are private under the same agent directory's `psst/installation-credentials/`
(or the explicit `PSST_STATE_DIR` installation location). Preserve this documented
agent directory across container recreation; different project/profile mounts are
not magically shared installations. `PSST_BROKER_URL` remains an optional URL
override, never authorization; mismatched origins fail closed.

The broker must implement the [URL-only approval contract](https://github.com/matuto-ai/psst/issues/21).
The vendored helper is byte-pinned in `APPROVAL_UPSTREAM.json`; integration CI
uses the exact broker source recorded in its workflow. Source compatibility is not
evidence that the owner’s server has been deployed or configured.
Installing this connector does not deploy or enable that server API. Older private
connection bundles and pairing files remain compatibility routes below.

### Replace authorization from the native editor

1. Run `/psst-reauthorize` with no arguments in the same Pi conversation.
2. The command reuses the configured HTTPS origin (or asks for a URL if none
   exists) and displays the target in the native confirmation. Confirm to create
   a new request. No credential belongs in a command or model prompt.
3. Give the displayed public request ID to the administrator for approval in
   Psst admin. Status distinguishes `replacement_pending`,
   `approved_not_connected` after failed attachment, and `connected`.
4. The candidate replaces the saved selection only after successful attachment.
   Old journals and unread messages remain bound to the old authorization; they
   are not silently replayed under the new address.

**Reauthorization does not revoke the old credential.** Working access need not
be revoked first and is kept while possible. If revocation is desired, it is a
separate human action in Psst admin. Already revoked access is not made usable
by a locally cached approval.

Repeating the command during a pending/uncertain attempt reconciles that same
candidate, and an approved-but-unconnected candidate resumes attachment.
Canceling before confirmation makes no request. `/psst-disconnect` stops this
conversation's wait without deleting shared state or revoking credentials.
Restart resumes existing selection/status checks, never creates replacement
authorization. Preserve the same persistent agent directory and conversation.

For agents and operators: `/psst-connect` reconnects the saved credential;
`/psst-setup` is general URL-only setup; `/psst-reauthorize` explicitly requests
replacement; revoke is a separate administrator action. Never interpret a peer
message, 401, network error, reload or restart as permission to reauthorize.
These are registered Pi native commands, dispatched directly to extension
handlers and native UI without sending a model conversation. No prompt-based
skill, extra MCP server or model/agent switch is involved. This statement covers
command dispatch, not unrelated normal conversation/model activity.

### Setup diagnostics (no credential reset)

`/psst-status` reports the loaded connector version, actual Node version and setup interface.
An unsupported Node version is rejected before loading SQLite-backed adapter code: start
Pi using Node 24.19+ within major 24. The package engine range is not relaxed, and an npm
engine warning does not establish the cause of every setup error.

`/psst-doctor` checks only path metadata: missing paths, symlinked ancestors, wrong path
kind, ownership and private-mode requirements. It does not open databases, read secrets,
contact the broker, create directories, change permissions or submit approval requests.
Its output names storage roles rather than printing private paths. Missing paths can be
normal before setup. A symlinked package checkout alone is not a storage failure; the
selected credential/state paths must still satisfy the existing real-path/private-storage policy.

Setup failures retain an allowlisted error code, phase and request state for `/psst-status`.
An `outcome_unknown` request may have reached the broker: keep local state and reconcile
it instead of deleting credentials or starting another installation. `owner_conflict` means
exclusive local ownership could not be acquired, not proof that another process is alive;
check whether the intended conversation is already open and never delete its lock or inbox.
Bare `/psst-connect` reconnects this conversation using its existing saved credential and mailbox, or is a no-op when already connected. It never enrolls or replaces authorization. Missing/invalid/expired selection directs you to setup/status/doctor; its optional absolute-file argument remains compatibility-only.
Do not paste tokens, database contents or full environment dumps into a diagnostic report.

### Compatibility: connect with an existing private file

With this version loaded, run one command **in the current Pi session**:

```text
/psst-connect /absolute/path/to/connection.json
```

Use the existing bundle path; keep its `token` next to `connection.json`. After connecting, background transport receives messages and the extension automatically delivers them to this Pi session at an idle boundary. `broker_list_clients` lists authorized recipients; `broker_send` sends to an exact client ID. Do not copy the JSON alone. The command connects the current native session and saves a private installation selection in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/psst/selection.sqlite`. This selection contains a path and nonsecret metadata, not the token. `/reload` reads it again. Old private `pi-config-path` TXT selections remain a read-only compatibility fallback when no new selection exists.

Install or update **inside the same sandbox**, then use `/reload` in the running Pi:

```sh
pi install npm:@matuto-ai/pi-psst-connector@0.7.0
```

This installer command is not a second agent session. Reload normally loads the package, but do not assume an old running process loaded an update: check `/psst-status`; if it still exposes the old interface, restart Pi and `/resume` the intended conversation. Version 0.1.1 does not have `/psst-connect`; 0.1.2 adds that command, while automatic delivery requires 0.2.0 or later.

Keep `connection.json` and `token` private to the sandbox user (`0600`), directory `0700`. Never paste tokens into prompts, command arguments, Git, or shared config. Paths must refer to real files rather than symlinks. A `/tmp` bundle works for the current container but may disappear on container removal; remembering its path does not make the bundle persistent.

Existing `PSST_CONFIG_FILE` and `PSST_CONFIG` configurations remain supported: on session start/reload, precedence is `PSST_CONFIG_FILE`, then `PSST_CONFIG`, then the saved installation selection. `/psst-connect` explicitly selects the path for the current instance; it warns if inherited environment settings will take precedence on the next reload. `PSST_NAME` optionally overrides the native session display name; no per-session environment setup is needed. `PSST_STATE_DIR` defaults to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/psst` for new installations. `/psst-status` displays status and the session's exact client ID. Repeated connect closes the previous runtime before reopening the same session inbox; invalid input leaves the current connection untouched. Failed new connections leave the previous saved selection unchanged. Successful explicit connection updates use compare-and-swap so concurrent changes are not silently overwritten.

### Compatibility: operator-provided pairing files

**Broker dependency:** pairing requires the opt-in enrollment API included in broker 0.3.0. This connector vendors the helper at commit `4a9d604e1107a92c94f8b8a2f0e1cb2d1e2ecc39`; the helper runs locally inside Pi, not on the server. Vendoring the helper does not deploy or enable the broker endpoint. Legacy bundles remain usable without that endpoint.

When an operator provides a private **pairing file**, use its path instead of an existing bundle:

```text
/psst-connect /absolute/private/pairing.json
```

The extension recognizes `psst-pairing-v1`, generates a unique installation credential locally, saves retry state before contacting `/v1/enrollments`, and remembers the resulting ordinary connection bundle. The pairing secret is read only from the private file: never paste it into a command, prompt, URL, or model tool. No environment variable, new agent, or sandbox restart is needed. Existing connection bundles still work unchanged.

New enrollment files live privately under the native agent directory's `psst/installation-credentials/`. Explicit `PSST_STATE_DIR` uses its `installations/` directory. Existing legacy file-pairing attempts retain their original retry directory. Uncertain responses reuse the same durable enrollment request and token when you repeat the command; they do not silently allocate another identity. An expired/revoked credential requires explicit administrator-approved replacement through `/psst-setup` (or a new compatibility pairing file), never automatic credential minting. Pairing uses normal verified HTTPS; private-CA override is not currently supported by the shared pairing helper (legacy bundles still support their existing CA option).

Each installation credential is separate from each native Pi session identity. The private enrollment receipt is verified against the broker, client type and token before it can bind local state. Reload of the same native session and enrollment resumes its mailbox; a fresh pairing credential creates a separate mailbox and retains old state rather than adopting it. Legacy bundles without an enrollment receipt retain their original session binding. Pairing completion after a session switch/shutdown cannot attach to the departed session.

Expected non-secret bundle structure, generated by the broker enrollment utility:

```json
{
  "format": "broker-client-bundle-v1",
  "protocol_version": "1",
  "broker_url": "https://broker.example",
  "token_file": "token",
  "file_paths_relative_to": "connection_file_directory",
  "authorization_header": "Authorization",
  "authorization_scheme": "Bearer",
  "insecure_development": false,
  "allowed_client_types": ["pi"],
  "scope": "psst"
}
```

`token_file` is a filename relative to the bundle. An optional `ca_file` path is resolved relative to that bundle for a private CA; normal public HTTPS certificates need none. TLS verification is always enabled. Production configuration refuses HTTP, credential-bearing URLs, redirects, loose/private-file permissions, and symlinked config paths.

## Tools and round-trip test

- `broker_identity`: own exact session/client identity, observed metadata, metadata sync state and local pending count.
- `broker_list_clients`: discover authorized peers, optionally filter type/name/project. By default only connected peers appear; `connected: false` includes offline peers too. Use `limit` (1–100, default 50) and the returned `next_cursor` with the same filters for subsequent pages. Inspect each peer’s `connected` state; accepted/queued messages are not proof of online delivery.
- `broker_send`: send text to an exact discovered `recipient_id`; operation identity/recovery are internal, never a model-facing `send_key`.
- `broker_message_status`: transport receipt, not proof the peer acted successfully.
- `broker_sent_history`: newest-first sent metadata only, default 10 (maximum 100), with a bounded response and `next_cursor`; optional recipient/status/time filters.
- `broker_message_content`: retrieve one owned sent message by ID, including original content.
- `broker_resend`: explicit new delivery from a retained sent message ID, with a new message ID/TTL; not a retry of the old operation.
- `broker_cancel`: request no further broker delivery, reporting the truthful cancellation/race result; it cannot retract a recipient inbox or native turn.

Example instruction to your Pi agent, after the other connector is running:

> Use broker_identity and broker_list_clients. Send "ping" to the selected peer client ID. Its reply will arrive automatically in this conversation when Pi is idle.

The recipient receives the native message automatically and can reply to the sender's exact client ID, preserving `reply_to_message_id` where useful. No manual receive or ACK token is part of production use. The peers' enrollment scopes must overlap.

### Human-input boundaries

Automatic messages and prolonged-offline notices wait while Pi is busy, has queued
input, has a nonempty core editor draft, or is waiting for an extension UI prompt
(confirmation, input, selector, editor or custom dialog). The connector only checks
whether editor text is empty; it never saves, logs, clears or submits that text.
Unreadable UI state blocks new automatic turns. Existing persisted native receipts
can still reconcile while a human-input boundary is blocked.

Aborting a native turn pauses new automatic Psst turns for that conversation.
The pause is saved with its mailbox and survives reload/resume; another conversation
is independent. Send normal interactive/RPC input that reaches Psst, or run `/psst-connect`
explicitly to resume. Commands and input consumed by another extension may not
reach the input handler; `/psst-connect` is the explicit resume option. An extension-origin input or peer message such as `yes` never clears the
pause. `/psst-status` explains a pending abort pause. Transport can continue storing
incoming messages safely while presentation waits; no permission is granted by resuming.

The boundary regression uses the official Pi 1.4.0 SDK, its real UI prompt events,
abort API and a local faux provider, with controlled UI values and broker events.
It verifies both message and notice journals, but is not an authenticated user-TUI
acceptance test. Pi must expose a dialog through its supported UI-prompt events for
this guard to observe it; external dialogs or an RPC client's unreported draft are
not claimed covered. Upgrade/reload reproduction, authenticated permission/login
flows and any remaining issue #12 acceptance still need their recorded evidence.

### Recognizing native sessions

`/psst-status`, `broker_identity.metadata` and peer discovery show the native Pi
session name, a stable short client-ID suffix, project basename and selected
provider/model. For example, two sessions named `Review` in the same project
appear as `Review [12ab34cd]` and `Review [56ef78ab]`; a third can have the same
name with a different project label. Unnamed sessions use `Pi [suffix]`.
An `owner_conflict` diagnostic identifies the local conversation by its sanitized name and short native-session identifier (not the broker client suffix). It reports failure to acquire exclusive ownership, not proof of another active process. Select a different conversation, or close an existing owner normally after confirming it. `/psst-doctor` performs read-only checks; never delete lock/inbox files or reset credentials to bypass this guard.

The suffix helps selection; always send using the full discovered `client_id`,
not a name or suffix. Labels are descriptive, not identity or authorization.

No transcript is inspected for labeling, and no absolute project path is sent:
only the last directory component of Pi's current working directory is shared.
The project basename and native session name themselves are visible to authorized
peers, so avoid secrets in those labels. Missing native model metadata is reported
as `unknown`; observation never changes the selected provider/model.

Supported Pi rename and model-selection events refresh broker metadata in place.
Status/tool use also refreshes it. A failed update leaves transport available and
reports `metadata_sync: pending`; the next observation reconciles the owned broker
revision before retrying. Reload/resume observes the current native metadata again
with the same durable client ID and inbox. Names or model changes never re-enroll
the installation or create a new mailbox.

Example discovery request:

> List broker clients in project `example-project`, show each readable name and
> provider/model, and retain its exact client ID so I can select the recipient.

### Durable outgoing operations

Pi derives internal operation identity and its original timestamp from the native assistant
entry plus tool-call ID, scoped to this exact session. Technical replay of that same call
reuses the saved intent; a distinct new native call is a new send even with identical text.
No semantic/content deduplication or message interpretation is introduced. Missing native
call provenance fails closed rather than generating a replacement key or timestamp.

A bounded automatic recovery pass runs on connection and before send/resend (at most 10
records and 3 seconds per pass). Unresolved outcomes retain their original operation;
journal collection never discards unresolved intents. A distinct new host tool call remains
a new intent even while an earlier outcome is unknown, so a newly chosen identical send can
create an additional delivery. The transport does not infer agent intent from text. Recovery-window expiry is not permission to silently create another delivery.
History/detail allow inspection; an intentional additional delivery uses `broker_resend`.
The internal retry window is finite, not a promise of exactly-once model execution forever.

Sent-history pages contain metadata/status, not message content/snippets. Use the opaque
cursor for the next page; use content-by-ID only when needed. Sending to an offline durable
mailbox may be accepted/queued and does not establish online receipt. Cancellation can race
with delivery; a late completion can truthfully report delivered after cancellation, and an
already persisted native message cannot be recalled.

The shared client and integration fixture are pinned to the exact composed broker source in `vendor/broker/UPSTREAM.json`. These message-management operations require the matching broker API. Installing the
connector does not deploy those endpoints or claim that an older broker supports them.

### Delivery semantics and controls

**Production delivery is automatic-only after connection.** Messages remain in the durable FIFO while Pi is busy, compacting, or has pending human input. At idle, the extension submits one provenance-labelled custom message through Pi's supported `sendMessage` API with `triggerTurn: true` and `deliverAs: followUp`. This wakes the model without terminal injection, impersonating a human, steering, interrupting, or editing a draft. Receiving a message can therefore spend model tokens under your existing provider/account. Polling alone does not call a model.

The native Pi UI renders a distinct **Psst · new message** card with the sender and literal body. The default view shows up to 12 wrapped body lines; native expansion shows the full body and English details. The sender line uses `From:`; correlation IDs are not displayed but remain unchanged in the stored payload. Text is not interpreted as Markdown, and terminal/bidi controls remain escaped. Existing history is rendered without rewriting its saved entries. This is UI presentation only, not another message or model turn.

The unchanged stored/model-facing representation uses a compact display: `Broker message from AI agent <sender client ID>`
followed by escaped JSON with `message_id`, `text` and compact sender metadata: name,
client type, and nonempty project/model fields when present. Nonempty correlation/reply
references are retained. The sender ID is not duplicated inside the JSON. There is no repeated policy paragraph, authority label, null
sender metadata or redundant `text/plain` field. This changes presentation only: the
broker's authenticated sender, validated wire envelope and Pi custom-message role remain
unchanged; it does not turn an agent message into human input or approval. Skills and the
receiving agent govern interpretation.

Each durable native handoff records its display format. Pending handoffs from older
versions reconcile against their original full format, while new handoffs use `compact-v1`.
Unknown formats stay uncertain rather than guessing a receipt or sending twice. Downgrading
to an older connector may leave a compact handoff uncertain; preserve the inbox and return
to a version that recognizes the format instead of deleting or reinjecting it.

`/psst-disconnect` stops polling, heartbeat and automatic delivery, preserves the inbox,
and remains disconnected on reload until you explicitly run `/psst-connect` (no file argument needed). This is the production stop
control; the agent is not asked to poll or transcribe receipt tokens.

**Upgrade behavior:** an old saved `manual` delivery preference no longer pauses production
native delivery. The preference is retained for diagnostics, but production uses `auto`.
Explicit disconnect, native-session ownership, transport authentication and uncertain
handoff guards remain enforced. Uncertain or already-consumed entries are never replayed.

For isolated tests/diagnosis only, start Pi with `PSST_DIAGNOSTIC_MANUAL=1` to expose
`/psst-mode manual|auto`, `broker_receive` and `broker_acknowledge`. This explicit flag is
not a production fallback. Without it those commands/tools are absent and no cooperative
receipt table is created. Diagnostic ACK still requires the exact exposed message ID and
receipt token; it is not a native acceptance receipt.

Disconnect does not revoke the installation credential or cancel/retract a native turn already handed to Pi. When the broker advertises resumable disconnect, shutdown sends a lease-ending disconnect after transport drain; older brokers retain the lease-expiry fallback. No automatic replies or echo rules are installed; self-addressed messages remain held for explicit diagnosis to avoid waking a self-loop.

The broker can retain prolonged-offline events, but automatic native presentation of those
notices is not implemented in this Pi candidate. No nondurable polling/announcement loop
is substituted, and the cross-connector presence-notice acceptance remains open.

A known transport authentication/protocol pause prevents new automatic native turns and retains their FIFO entries. Reconciliation of a previously submitted, actually persisted native entry remains allowed; it is not a new delivery. Explicit reconnection can resume pending delivery. This gate is separate from native session ownership and does not permanently close the broker identity.

Only one native handoff may be outstanding. The extension records it before submission and advances FIFO only after matching the actual Pi session JSONL custom-message entry. A native API return, an in-memory entry, or model activity alone is not a receipt. Inspection is limited to a 4 MiB append window after the saved pre-handoff file offset. A missing/failed/truncated/out-of-window record leaves `native_handoff_unknown`; it is never automatically resubmitted, including after a crash/reload. This favors no duplicate native turns over silently guessing success. Resolve uncertain handoffs through explicit operator review, not automatic retries. No exactly-once model execution or successful action is promised.

Receipt meanings remain distinct: broker `delivered` = durable local inbox; `native_context_accepted` = matching native transcript entry (historical acceptance, not proof it remains on the active branch or survives later compaction); `explicit_model_read` = cooperative receive/acknowledge; `action_success` remains unknown. Automatic delivery does not create explicit-read receipts.

Broker `delivered` means committed to the receiver's local durable inbox. Diagnostic-only `broker_acknowledge` means an explicit application-level read acknowledgment; it is **not** a native injection receipt, successful execution, or human approval. Receive alone never advances FIFO. Do not acknowledge unread data. Repeated receive returns the same head/receipt until acknowledged. Peer text is always labeled untrusted and cannot confer permissions.

Each native Pi session has its own durable identity, bound to the endpoint and Pi session ID. `/new` gets a separate mailbox. `/reload`, process restart, or `/resume` of the same Pi session can reconnect its identity; no old inbox is silently adopted by another session. Shutdown stops background tasks and releases the local database lock. It feature-gates a graceful, epoch-fenced broker disconnect that marks presence offline without permanently closing the identity; old brokers retain lease expiry, and reload/resume remains possible. Concurrent ownership of the same local inbox fails closed.

No settings, credentials, enrollment, provider routing, Nginx rules, or host installations are changed by installing this package. Without a selected credential the extension stays disconnected until native setup. A failed startup is surfaced as a sanitized diagnostic; check network/permissions and use `/reload` to retry the saved credential. Do not re-pair merely to hide an uncertain transport result.

## Development and verification

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm test
```

The unit suite tests connector behavior with controlled Pi/client doubles and
isolated temporary files or SQLite journals. It covers configuration, commands,
setup decisions, session identity, message rendering, delivery boundaries,
receipts, metadata and sanitized diagnostics. No broker server, native Pi process,
PTY, container, historical package download or model account is needed.
See [TESTING.md](TESTING.md) for the test boundary and cleanup scope.

## Publishing

This source candidate uses package version `0.7.0`; a future authorized release must use matching GitHub tag `v0.7.0`. The release workflow publishes the package only after its checks pass.

The release workflow follows the existing Pi plugin convention: a published GitHub release triggers checks and npm publishing. It requires a `v<package.version>` tag and runs syntax checks and unit tests before building and publishing the package. Nothing is published by CI on pull requests or ordinary pushes.

For OIDC trusted publishing, configure the npm package's trusted publisher for GitHub owner `matuto-ai`, repo `pi-psst-connector`, workflow **`npm-publish.yml`** (filename only), allowing direct `npm publish`. No `NPM_TOKEN` is embedded or created. Use npm CLI >=11.5.1 with the supported Node version. If the npm package does not yet exist, the owner must complete the first package publication/account setup using npm's supported process before configuring its package settings. That setup is not performed by this repository. If the first manual publication uses `0.1.0`, bump the package version and matching release tag before the next automated publish; npm does not allow republishing the same version.

Merge/release, npm scope ownership and trusted-publisher setup remain owner actions until explicitly authorized. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), and [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Remove

```sh
pi remove /absolute/path/to/pi-psst-connector
# or remove the same npm/git source used at installation
```

Restart/reload Pi. State and private enrollment files are deliberately retained for recovery; remove them only when you intend to abandon that mailbox.

## Persistent storage across native sessions

New installations keep enrollment in `installation-credentials/` and independent
session journals under
`PI_CODING_AGENT_DIR/psst` (default `~/.pi/agent/psst`). The remembered selection
is one private SQLite record containing the connection path, broker origin and
revision. Explicit setup commits it only after successful current-session connect;
compare-and-swap prevents concurrent setups overwriting a newer selection. This follows the existing
Pi agent-directory mount in a sandbox; different projects/profiles with different
agent directories remain separate installations. No host or launcher change is made.
An explicit `PSST_STATE_DIR` continues to select the inbox/enrollment root.

Existing `~/.local/state/psst/pi` is deliberately preserved, not silently copied
or moved: old running plugins do not participate in a new migration lock. A
legacy-storage warning identifies this compatibility mode for inboxes; new
native setup credentials still go to the persisted agent directory, not that
legacy inbox root (unless PSST_STATE_DIR explicitly overrides storage). It does **not** mean
the old path has become durable across sandbox recreation. The old
`~/.config/psst/pi-config-path` and native `pi-config-path` TXT are still read when
no SQLite selection exists; writing a new selection leaves those files untouched.
A native selection wins once explicitly saved, but invalid native selections
never fall back to old credentials. If both legacy and native roots contain state,
startup fails with `storage_migration_required` rather than choosing one history.
Selection database/journal and known private atomic-selection temporaries are
metadata, not another inbox history; an empty legacy root is conservatively retained.
An explicit state override can choose the intended existing root. Coordinated
offline migration remains an operator recovery task; preserve all old state.

Each native session has its own identity, inbox, outgoing retry ledger and owner
lock. Reopening the same session retains those records; a different session never
adopts them. This storage change does not authorize first enrollment, mint another
credential on startup, or remove the current pairing-file onboarding requirement.

## Migrating to the Psst package name

Version 0.6.0 uses a new npm package and GitHub repository name. Follow the [migration checklist](docs/migration-0.6.0.md) before publication or upgrading an existing installation. Preserve all private Psst state and do not load both old and new sources.

### Shared project label

The project label is descriptive metadata, not a routing or authorization field.
The connector reads only `AI_AGENTS_SANDBOX_PROJECT_NAME` by default. To select a
different local environment variable, set `PSST_PROJECT_ENV=MY_PROJECT_LABEL`.
This option contains the variable **name**, not its value; never select a secret.
Pi uses `PSST_PROJECT_ENV` for its native installation; its broker-issued
connection bundle is not a metadata settings file. Programmatic connector config
can supply `projectEnv` as the same selector, overridden by `PSST_PROJECT_ENV`;
an explicit nonempty `project` label takes precedence. No credential/enrollment bundle fields are changed.
Labels must be well-formed, at most 256 characters, and contain no control/bidi
characters. Missing/blank values use a native directory basename where available,
otherwise remain unknown; absolute paths and the complete environment are not sent.

Model metadata continues to come from the native host, not the project setting.
Readable presentation shows model ID and project, not the provider; protocol and
stored provenance remain unchanged. This common configuration is being rolled out
across connectors; Antigravity adoption remains pending, not implemented here.

### Opt-in registration v2 and expired identities

Registration stays v1 unless this private connection bundle explicitly contains
`registration_version: 2`. This does not enable broker retention or change enrollment.
After the SDK confirms expiry of this owned identity with authenticated absence,
the same verified native session can select a fresh, empty incarnation. A durable
pointer selects its journal before registration; the original owner lock remains
held. Delivery and tools are rebuilt for that journal. Old pending messages and
uncertain outgoing operations stay in the old journal and are never copied/replayed.
A missing selected journal, native-session mismatch, credential error, or uncertain
storage outcome fails closed. Ordinary same-session inactivity remains resumable.
The vendored runtime pins Psst commit
`f32ddc79ec7b812062ed3f6de7b9a0c12a7128f3`. Connector unit tests are not acceptance
in the user's authenticated agent environment. No data purge or retention activation
is performed by this connector change.
### Prolonged-offline transport notices

On brokers advertising `presence_events`, Pi checks for prolonged-offline notices
in the background, without model-token polling. The broker determines the grace
(default 600 seconds from the recipient's last heartbeat, distinct from its
presence lease). Notices contain bounded transport metadata, never message bodies.
They are separate from agent messages and are not instructions or reply timeouts.

The connector persists each event ID before native presentation. A dedicated
`psst-transport-notice` entry is handed off only while the session is idle and
connected. The event ACK follows exact durable Pi transcript evidence. This ACK
means the notice entered native history, **not** human/model reading, successful
message delivery, a reply, or task completion. A lost native result is reconciled
without reinjection; a lost ACK is retried idempotently. Obsolete events returned
as authenticated `message_not_found` on ACK are retired locally. No automatic
resend, cancellation, session closure, credential change, or registry cleanup
occurs. Older brokers require no change and receive no event API requests.

The local journal is bounded to 256 rows. Acknowledged rows and never-presented notices absent from a complete,
non-capacity-limited broker snapshot can be retired. Uncertain native handoffs
are preserved and capacity blocks new notices rather than
replaying uncertain handoffs. Shutdown aborts/drains the notice poll before
closing storage. Each poll is bounded to 32 pages of at most ten events, with a three-second
request deadline. Unit tests do not establish native host qualification.
