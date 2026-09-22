# Message cryptography context

This browser-safe workspace owns the message and key-backup wire formats.
`src/index.ts` is the small interface used by browser messaging and the API's
trusted recovery/report paths. It uses JOSE with Web Crypto and Zod; it must
never import the API, database, browser storage or deployment configuration.

Read [the encryption design](../../docs/message-encryption.md) before changing
algorithms, identities, reporting evidence or recovery. This is recoverable
client encryption, not provider-inaccessible E2EE. Changes to a persisted
format need an explicit migration/version strategy; existing identities are
immutable and old recovery key versions must remain available.

**Message identity** means an account's pair of separate encryption and signing
keys, shared by that account's trusted browsers. It does not mean a device key.
**Recovery backup** means that identity's private keys encrypted under the
provider recovery public key. It deliberately permits provider recovery.
**Disclosure** means a signed plaintext message that a participant explicitly
submits as moderation evidence, after decrypting it locally.

Run `pnpm --filter @my-tuums/message-crypto test:unit` and `typecheck` first.
API integration and browser journeys own authorization and storage/recovery
flows. `src/index.test.ts` owns ciphertext integrity and identity binding.
