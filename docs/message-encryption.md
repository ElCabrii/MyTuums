# Recoverable message encryption

New message text bodies are encrypted in the sender's browser and decrypted in the
participants' browsers. **This is not provider-inaccessible end-to-end encryption.**
The chosen recovery policy lets a signed-in user recover history using their
verified email, without a separate passphrase, recovery key or existing device.
To provide that, MyTuums holds a recovery key capable of unlocking account keys
and message history. The recovery screen describes these privacy limits.

## Default activation

Messaging keys are prepared automatically when a signed-in user opens any page
of the app after completing onboarding and accepting the current terms. There
is no activation button or plaintext sending mode. This applies to new accounts
and existing accounts on their first visit after rollout. An account that has
not visited the updated app still has no public messaging key and cannot receive
messages yet; no server-side backfill provisions keys for absent users.

The account-scoped access query performs idempotent initialization. A browser
lock serializes registration and local persistence across tabs. The server's
immutable identity remains authoritative if different devices race; the losing
device requires email recovery. Existing identities are never replaced, and a
new browser or cleared site data still requires explicit email recovery. No
recovery email is sent merely by signing in. A setup failure leaves a retry in
Messages without blocking other pages or falling back to plaintext.

## Ownership and protocol

- `packages/message-crypto` owns the versioned wire formats and uses JOSE 6.2.5
  over Web Crypto. It contains no database, networking, storage or logging.
- `apps/web/src/atoms/message-access.ts` owns setup and email recovery;
  `apps/web/src/lib/message-key-store.ts` persists non-extractable private
  CryptoKeys in IndexedDB, scoped to the account. This is a trusted-browser
  feature: signing out clears memory caches but retains these local keys.
  Clearing this site's browser data removes them and requires email recovery.
- Each account has separate P-256 encryption and signing keys, immutable after
  registration. Every message has a fresh General JWE content key, AES-256-GCM
  encryption and ECDH-ES+A256KW recipients for sender and recipient. Inside is
  an ES256-signed payload binding format version, message UUID, sender,
  recipient and text. Decryption verifies that binding against the thread.
- `packages/api/src/messages.ts` accepts only bounded encrypted envelopes for
  new sends and requires both participants to have registered keys. There is
  no plaintext fallback. D1 stores a fixed `[encrypted]` body placeholder and
  the envelope. The ordinary API returns ciphertext; inbox previews are generic
  and SSE transports only invalidations. Messaging routes are excluded from
  analytics page views, including when analytics consent is granted. Identities
  and conversation metadata remain visible to the service.
- `packages/api/src/message-keys.ts` owns authenticated public-key lookup,
  immutable registration and recovery challenges. A user's private-key backup
  is a Compact JWE under the provider's recovery public key. Registration
  decrypts and validates this backup so a mismatched backup cannot strand the
  account. Private account keys therefore pass through the trusted recovery
  implementation in memory during both registration and recovery.
- `packages/api/src/message-recovery-keys.ts` holds the private recovery
  keyring supplied by the application Worker's `MESSAGE_RECOVERY_KEYRING`
  secret. This is separate from D1 and the auth secret, **not an isolated
  recovery service or HSM**. The same Worker hosts messaging and recovery.
  Secret access or Worker compromise permits recovering history.

The JOSE formats follow [RFC 7516](https://www.rfc-editor.org/rfc/rfc7516) and
[RFC 7518](https://www.rfc-editor.org/rfc/rfc7518); the implementation uses the
[JOSE library](https://github.com/panva/jose). This application's composition
has not received an independent cryptographic audit.

## Email recovery

After normal sign-in (including existing account two-factor requirements), the
browser creates a temporary response-encryption key. The server sends a random
16-character hexadecimal code to the account's currently verified email. The
challenge stores only a SHA-256 digest of the code bound to a random challenge
ID; it is also bound to the account, initiating session, email and temporary
public key. A new request replaces the old challenge.

Codes expire after ten minutes. Account limits permit three requests and ten
attempts per hour; the database atomically enforces five guesses per challenge
and one successful consumption even under concurrent requests. Changed email,
other sessions, expired codes and replays are refused. Mail delivery failure
removes that challenge. The recovered identity is encrypted to the requesting
browser's temporary key before leaving the Worker. Codes, private keys,
plaintext messages and recovery responses must never enter logs or analytics.

An ordinary password reset can restore account access, followed by this email
code flow to restore messages. Existing two-factor authentication is not
bypassed. Whoever can satisfy the account's sign-in and email recovery checks
can obtain the same history; provider access also remains trusted.

## Limits and evidence disclosure

Image, voice and video attachments retain the existing server-managed media
pipeline. Their bytes are not encrypted in the browser: the service and storage
providers can access them. Participant authorization and report-scoped moderator
access still apply. Message signatures bind the text, not attachment bytes.

This version uses stable account keys, not a ratcheting protocol. It has **no
forward secrecy, post-compromise recovery, post-quantum protection, per-device
key revocation or user-verifiable key transparency**. Compromise of an account
private key exposes that account's history and future messages until a future
key-rotation design replaces it. Public-key authenticity relies on the service.
Non-extractable browser keys prevent straightforward export, not use by an XSS
payload, malicious extension or compromised browser. Web delivery also trusts
the origin to serve honest JavaScript. TLS, authentication, CSP and authorization
remain necessary.

Encrypted-message reports deliberately disclose the selected signed
plaintext and that message’s attachments to moderation. The server verifies sender signature, message ID and
recipient before storing the report snapshot. If a caption cannot be decrypted,
participants can report its stored attachments alone: the snapshot contains no
text and no neighboring messages. Supplied but invalid signatures are still
rejected; attachment-only reports cannot introduce unverified text. The report dialog explains this
disclosure. Moderators have no conversation-browsing endpoint. Already disclosed
reports remain plaintext evidence after message deletion. The UI cannot report
an encrypted tombstone whose plaintext is no longer available to that browser.

Existing message rows remain legacy plaintext and are labeled accordingly.
They are not retroactively encrypted, and existing database backups cannot be
made private retroactively. Legacy reports retain the bounded legacy context
window. Migration 0011 adds identities, challenges and envelope storage;
0012 forbids new plaintext inserts and content mutation while allowing
existing rows to be read and tombstoned. D1 operators can still alter data;
these triggers protect application rollout and rollback, not a hostile operator.

## Deployment and recovery-key custody

No production key is included in this repository or installed by this change.
The local/e2e entrypoints alone use an explicitly public synthetic test key.
Never use that fixture key in a hosted environment.

1. Generate a distinct recovery keyring for each hosted environment, outside
   the checkout: `pnpm messages:recovery-key /secure/absolute/path/recovery.json recovery-2026-09`.
   The command refuses an existing file, writes with mode 0600 and prints only
   the path. Keep an access-controlled backup independent of the D1 backup.
2. Install that file's JSON as the application Worker's encrypted secret
   `MESSAGE_RECOVERY_KEYRING` through the existing Cloudflare secret-management
   workflow. Never commit it, place it in Wrangler vars or expose it to the SPA.
   The shape is `{ "active": "key-id", "keys": { "key-id": <private P-256 JWK> } }`.
3. Apply committed D1 migrations through the normal pre-deploy workflow and
   deploy the matching Worker and SPA together. After 0012, older Workers
   cannot send messages; do not remove the guard to make a rollback work.
4. Verify registration, delivery in two browsers and recovery from captured
   test email in preview before enabling production. No hosted rollout has
   been performed as part of this implementation.

When the secret is absent, setup and recovery are unavailable rather than
falling back to plaintext; existing browsers with keys can still exchange
ciphertext. Losing the recovery key and all local participant keys makes the
corresponding history unrecoverable. Retain old keyring entries when adding a
new `active` key: backups record their wrapping key ID. There is no automated
backup rewrapping or account-key rotation in this version. Do not delete an old
entry until its backups have been migrated and restored successfully.

## Verification

`packages/message-crypto/src/index.test.ts` covers participant-only decryption,
tamper and identity-binding rejection, recovery and non-extractable imports.
API integration tests cover plaintext refusal, access controls, verified report
disclosure and recovery's account/session/expiry/concurrency boundaries.
`messages-migration.int.test.ts` checks legacy preservation and write guards.
`e2e/tests/specs/messages.spec.ts` exercises browser setup, encrypted send/read,
live delivery across sessions and email recovery after deleting local keys.
These tests are regression evidence, not a cryptographic security audit.
