import {
  RECOVERY_CODE_LENGTH,
  hashRecoveryCode,
  newRecoveryCode,
  normaliseRecoveryCode,
  recoveryCodeMatches,
} from "./recovery-code";

describe("recovery codes", () => {
  it("are 16 base32 characters, shown in groups of four", () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(code.replace(/-/g, "")).toHaveLength(RECOVERY_CODE_LENGTH);
    expect(newRecoveryCode()).not.toBe(code);
  });

  it("are stored as a hash, never as themselves", () => {
    const code = newRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code.replace(/-/g, ""));
  });

  it("match however they are typed", () => {
    const code = "ABCD-EFGH-IJKL-MNOB";
    const hash = hashRecoveryCode(code);
    for (const typed of ["abcd efgh ijkl mnob", "ABCDEFGHIJKLMNOB", " abcd-efgh-1jkl-mnob ", "ABCD-EFGH-IJKL-MN08"]) {
      expect([typed, recoveryCodeMatches(typed, hash)]).toEqual([typed, true]);
    }
  });

  it("refuse anything else", () => {
    const hash = hashRecoveryCode(newRecoveryCode());
    expect(recoveryCodeMatches(newRecoveryCode(), hash)).toBe(false);
    expect(recoveryCodeMatches("", hash)).toBe(false);
    expect(recoveryCodeMatches("ABCD", hash)).toBe(false);
    expect(recoveryCodeMatches(newRecoveryCode(), null)).toBe(false);
    expect(normaliseRecoveryCode("ABCD-EFGH-IJKL-MNO9")).toBeNull();
    expect(normaliseRecoveryCode("ABCD-EFGH-IJKL-MNOPQ")).toBeNull();
  });
});
