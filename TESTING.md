# Connector unit tests

Run with Node in the supported package engine range:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm test
```

`npm test` runs `node --test test/*.test.mjs` directly. The `verify` CI job runs
these same checks. There is no separate host, integration, native or E2E suite.
The existing release workflow runs these checks before packing and publishing;
ordinary pushes and PRs do not publish anything.

## What belongs here

Test decisions owned by this connector: configuration validation and private-path
handling; saved-selection compare-and-swap; setup/cancellation/reconnect behavior;
session identity and shutdown; metadata; tool parameter forwarding; safe message
formatting; idle/abort boundaries; durable receipt handling and sanitized errors.
Use controlled Pi and client doubles. Local temporary files and SQLite journals
are appropriate where persistence is the behavior under test. Two distinct
sessions are sufficient to test isolation, without a thirty-session stress loop.

These tests do not start a broker, listen on a network port, spawn Pi or other
fixture programs, invoke a model, or require Docker, Python, PTYs, credentials,
historical packages or another repository. The Node test runner and syntax-check
script use Node processes only to execute/check the JavaScript files.

## Cleanup scope (issue #30)

Removed the native-host and PTY probes, broker roundtrip/presence/expiry suites,
container definition, copied broker server fixtures, historical-upgrade harnesses,
package-extraction/evidence runner and tests of that runner. Replaced broad
metadata/lifecycle coverage with focused client doubles and removed the
multiprocess selection stress test while preserving stale-writer coverage.
Kept local tests for native delivery and UI boundaries: their names describe
connector behavior, not execution of a native host.

Product source, vendored runtime, package version, dependencies, installation,
credentials and deployment behavior are unchanged. Prior native evidence remains
in the historical GitHub issues and PRs; unit success is not native acceptance.

## Reauthorization endpoint validation (issue #41)

Focused tests invoke the registered command with missing, malformed, mismatched and valid endpoints. They protect pending polling, an in-flight setup, saved selection and unread data against rejected invocations, and exercise the native setup helper without a URL-input dialog. Target checks include saved metadata, environment configuration, legacy bundles and pending-only installations; they do not require valid current enrollment receipts. Ordinary setup's replacement-confirmation, cancellation, uncertain-request recovery and failed-attachment regressions remain in place. Pi's command handler is the deterministic pre-model argument-validation seam; argument placeholders are help text, not a host-enforced schema.

## Explicit reauthorization intent (issue #42)

Focused tests execute the registered reauthorization command through the real native setup helper and durable approval helper with a controlled transport. A valid endpoint needs no input/confirmation capability or extra question; the host UI gate, endpoint validation, ordinary setup confirmation and administrator-pending state remain enforced. Tests cover repeated/uncertain attempts retaining one candidate, failed attachment preserving the predecessor, approved-candidate recovery, and session-switch/shutdown/disconnect fences during approval reads. No model-facing reauthorization tool is registered. These checks are not live-broker or real-agent acceptance evidence; record disposable native-host trials separately rather than treating wording assertions as model compliance.

## Direct commands and collaboration (issues #38 and #40)

Focused tests exercise the supported pre-turn hook and static free-collaboration guidance, human-instruction priority and host safeguards, direct registered command handlers, saved parameter reuse, exact reply-routing forwarding through the send tool, native abort/session rejection, and durable uncertain-send reconciliation. Peer requests use existing permissions without separate per-peer, per-message or per-purpose human grants; peer text cannot override human instructions or host safeguards. These contract tests do not claim a live model chooses to reply or asks no questions; representative real-agent trials are separate behavioral evidence. Existing native-delivery tests preserve automatic admission, human-draft/abort boundaries and exact persisted receipt recovery.
