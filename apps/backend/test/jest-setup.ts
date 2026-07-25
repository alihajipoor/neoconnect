/** Environment every test can assume.
 *
 * Credential encryption reads its key from the environment at call time
 * (see protocol-users/credentials-crypto.ts), so any test touching a
 * ProtocolUser's credentials needs one. On a developer machine that key
 * happens to be present from local setup, which is exactly why its
 * absence went unnoticed: two specs passed locally and failed on CI for
 * six commits before anyone looked.
 *
 * A fixed, obviously-fake key is set here rather than in each spec, so a
 * future test can't reintroduce the same environment-dependent failure by
 * forgetting to. This value is only ever used to encrypt data these tests
 * created moments earlier, and never touches real credentials.
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??=
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
