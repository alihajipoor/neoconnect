import { Job } from "bullmq";
import { AnnouncementsProcessor, AnnouncementJobData } from "../jobs/announcements.processor";
import { ReferralsService } from "../referrals/referrals.service";
import { EmailService } from "./email.service";

/** Picking the right recipient's locale, which is the half of this that
 * the templates cannot check for themselves.
 *
 * Every send site now reads a locale off a row, and the ways that goes
 * wrong are not type errors: reading it off the wrong row (the referral
 * emails address one customer about another), or off no row at all (an
 * announcement whose recipients were queued before the field existed).
 * Both send a perfectly well-formed email in the wrong language, which
 * is the exact failure this whole change is about. */

function fakeEmail() {
  const sendMail = jest.fn().mockResolvedValue(true);
  return { sendMail } as unknown as EmailService & { sendMail: jest.Mock };
}

describe("announcements", () => {
  function processorWith() {
    const email = fakeEmail();
    return { email, processor: new AnnouncementsProcessor(email) };
  }

  function job(data: AnnouncementJobData) {
    return { data } as Job<AnnouncementJobData>;
  }

  it("writes each recipient's shell in their own language", async () => {
    const { email, processor } = processorWith();
    await processor.process(
      job({
        subject: "Maintenance tonight",
        body: "Servers restart at 02:00.",
        recipients: [
          { email: "en@example.com", locale: "en" },
          { email: "fa@example.com", locale: "fa" },
        ],
      }),
    );

    const [first, second] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(first.to).toBe("en@example.com");
    expect(first.html).toContain('<html dir="ltr" lang="en">');
    expect(second.to).toBe("fa@example.com");
    expect(second.html).toContain('<html dir="rtl" lang="fa">');
  });

  it("still sends a broadcast queued before recipients carried a locale", async () => {
    // A deploy does not drain the queue. An announcement enqueued by the
    // old code minutes before the new code starts is still sitting in
    // Redis as a bare string, and a worker that threw on it would lose a
    // broadcast the operator believes they sent.
    const { email, processor } = processorWith();
    await processor.process(
      job({
        subject: "Maintenance tonight",
        body: "Servers restart at 02:00.",
        recipients: ["legacy@example.com"] as unknown as AnnouncementJobData["recipients"],
      }),
    );

    const [sent] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(sent.to).toBe("legacy@example.com");
    // English, which is what that broadcast would have been anyway.
    expect(sent.html).toContain('<html dir="ltr" lang="en">');
  });

  it("keeps the admin's own words untranslated", async () => {
    // Only the shell is localised -- there is no translation of one
    // admin's sentence to reach for, and inventing one would be worse
    // than laying it out correctly.
    const { email, processor } = processorWith();
    await processor.process(
      job({
        subject: "Maintenance tonight",
        body: "Servers restart at 02:00.",
        recipients: [{ email: "fa@example.com", locale: "fa" }],
      }),
    );

    const [sent] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(sent.subject).toBe("Maintenance tonight");
    expect(sent.html).toContain("Servers restart at 02:00.");
    // The chrome around it is Persian.
    expect(sent.html).toContain("Neoxify حساب کاربری دارید");
  });
});

describe("referral notifications", () => {
  /** Two customers with different languages: the one who invited, and
   * the one who just joined. Which of the two an email is addressed to
   * is the whole question. */
  function serviceWith(referrerLocale: string, friendLocale: string) {
    const email = fakeEmail();
    const prisma = {
      customer: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === "friend"
              ? {
                  id: "friend",
                  email: "friend@example.com",
                  locale: friendLocale,
                  referredByCustomerId: "referrer",
                }
              : { id: "referrer", email: "referrer@example.com", locale: referrerLocale },
          ),
        ),
      },
    };

    const service = new ReferralsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      email as never,
    );
    // The credit arithmetic is exercised in referrals.service.spec.ts;
    // here it only has to produce a number for the copy to mention.
    (service as unknown as { progressFor: () => Promise<{ monthsToNextReward: number }> }).progressFor =
      () => Promise.resolve({ monthsToNextReward: 2 });

    return { service, email };
  }

  it("writes to the inviter in the inviter's language", async () => {
    // The two are often not in the same country at all -- a Persian
    // customer inviting an English-speaking friend was the case that
    // made this worth a test rather than a glance.
    const { service, email } = serviceWith("fa", "en");
    await service.notifyReferrerOfActivation("friend");

    const [sent] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(sent.to).toBe("referrer@example.com");
    expect(sent.html).toContain('<html dir="rtl" lang="fa">');
  });

  it("does not follow the joining friend's language", async () => {
    const { service, email } = serviceWith("en", "fa");
    await service.notifyReferrerOfActivation("friend");

    const [sent] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(sent.to).toBe("referrer@example.com");
    expect(sent.html).toContain('<html dir="ltr" lang="en">');
  });

  it("still masks the friend's address", async () => {
    // Unchanged by this work, and worth re-asserting because the masked
    // value now passes through an ltr() wrapper on its way into the
    // Persian body.
    const { service, email } = serviceWith("fa", "en");
    await service.notifyReferrerOfActivation("friend");

    const [sent] = email.sendMail.mock.calls.map((c) => c[0]);
    expect(sent.html).not.toContain("friend@example.com");
    expect(sent.html).toContain("@example.com");
  });
});
