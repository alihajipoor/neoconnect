import { EmailService } from "./email.service";

/** A password change has to reach the wire.
 *
 * The cache fingerprint was host:port:secure:username, none of which a
 * password rotation touches -- so the cached transporter was handed back
 * and kept authenticating with the old secret until the process
 * restarted. Verification and reset emails failed 535 for two days while
 * the panel showed the new password saved.
 */
describe("EmailService transporter cache", () => {
  const base = {
    host: "smtp.example.net",
    port: 587,
    secure: false,
    username: "sender@example.net",
    fromAddress: "sender@example.net",
  };
  const build = () => new EmailService({} as never, {} as never);
  const get = (s: EmailService, settings: unknown) =>
    (s as unknown as { getTransporter(x: unknown): unknown }).getTransporter(settings);

  it("reuses the transporter when nothing changed", () => {
    const s = build();
    const a = get(s, { ...base, password: "same" });
    const b = get(s, { ...base, password: "same" });
    expect(a).toBe(b);
  });

  it("builds a new transporter when only the password changed", () => {
    const s = build();
    const a = get(s, { ...base, password: "old-secret" });
    const b = get(s, { ...base, password: "new-secret" });
    expect(b).not.toBe(a);
  });

  it("still rebuilds when the host or username changes", () => {
    const s = build();
    const a = get(s, { ...base, password: "p" });
    expect(get(s, { ...base, password: "p", host: "smtp2.example.net" })).not.toBe(a);
    const c = get(s, { ...base, password: "p" });
    expect(get(s, { ...base, password: "p", username: "other@example.net" })).not.toBe(c);
  });
});
