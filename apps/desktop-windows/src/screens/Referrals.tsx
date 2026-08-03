import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ArrowLeft, Check, Copy, Gift, Users } from "lucide-react";
import { getReferrals } from "../lib/customer";
import type { ReferralOverview } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { Button, Card } from "../components/ui";

/** Invite friends, earn free time.
 *
 * The screen's job is to answer one question at a glance -- how far am I
 * from the next free month -- and it answers it with the server's own
 * arithmetic rather than recomputing the rules here. Two copies of a
 * reward calculation would eventually disagree, and the one the customer
 * reads is not the one that pays out.
 */
export function Referrals({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<ReferralOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getReferrals().then((result) => {
      if (cancelled) return;
      if (result.ok) setData(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function copyCode() {
    if (!data?.code) return;
    try {
      await writeText(data.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard that refuses is not worth an error banner -- the
      // code is on screen and can be read out.
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 p-5">
      <div>
        <h1 className="text-base font-semibold">{t("referrals.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("referrals.subtitle")}</p>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {data && !data.enabled ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("referrals.off")}</p>
          </Card>
        ) : null}

        {data?.enabled ? (
          <>
            {/* The code, given the most weight on the screen: it is the
                one thing the customer came here to get. */}
            <Card className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
                  <Gift className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{t("referrals.yourCode")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("referrals.rule", {
                      months: data.rules.loyalFriendMonths,
                      friends: data.rules.friendsRequired,
                      each: data.rules.friendMonths,
                      days: data.rules.rewardDays,
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <code
                  dir="ltr"
                  className="flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-center text-lg font-semibold tracking-[0.2em] text-foreground"
                >
                  {data.code ?? "--"}
                </code>
                <Button variant="outline" onClick={() => void copyCode()} className="shrink-0 gap-2">
                  {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                  {copied ? t("referrals.copied") : t("referrals.copy")}
                </Button>
              </div>
            </Card>

            <ProgressCard data={data} />

            <Card className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Users className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold">
                    {t("referrals.friends")} ({data.friends.length})
                  </p>
                  <p className="text-xs text-muted-foreground">{t("referrals.friendsHint")}</p>
                </div>
              </div>

              {data.friends.length === 0 ? (
                <p className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-3 text-center text-xs text-muted-foreground">
                  {t("referrals.noFriends")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.friends.map((friend) => (
                    <li
                      key={friend.maskedEmail + friend.joinedAt}
                      className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.025] px-2.5 py-2"
                    >
                      <span
                        className={[
                          "size-1.5 shrink-0 rounded-full",
                          friend.paidMonths > 0
                            ? "bg-success"
                            : friend.activated
                              ? "bg-warning"
                              : "bg-muted-foreground/40",
                        ].join(" ")}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs" dir="ltr">
                        {friend.maskedEmail}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {friend.paidMonths > 0
                          ? t("referrals.paidMonths", { count: friend.paidMonths })
                          : friend.activated
                            ? t("referrals.joined")
                            : t("referrals.pending")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {data.rewards.length > 0 ? (
              <Card className="flex flex-col gap-2">
                <p className="text-sm font-semibold">{t("referrals.earned")}</p>
                <ul className="flex flex-col gap-1.5">
                  {data.rewards.map((reward) => (
                    <li
                      key={reward.id}
                      className="flex items-center justify-between rounded-lg border border-success/25 bg-success/10 px-2.5 py-2 text-xs"
                    >
                      <span className="font-medium text-success">
                        {t("referrals.freeDays", { days: reward.rewardDays })}
                      </span>
                      <span className="text-muted-foreground">
                        {new Date(reward.grantedAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        ) : null}
      </div>

      <Button variant="ghost" onClick={onBack} className="w-full justify-center gap-2 border border-white/10">
        <ArrowLeft className="size-4" />
        {t("nav.back")}
      </Button>
    </div>
  );
}

/** How close the next free month is.
 *
 * Shown as a bar against whichever of the two routes is nearer, because
 * "you need 3 months from one friend OR 3 friends with 1 month each" is
 * two sentences nobody reads and one number everybody does.
 */
function ProgressCard({ data }: { data: ReferralOverview }) {
  const { t } = useI18n();
  const { rules, progress } = data;

  // The denominator is whichever route the customer is actually on --
  // the same one the remaining count was measured against, or the bar
  // and the number underneath it would disagree.
  const viaFriends = rules.friendsRequired * rules.friendMonths;
  const total = progress.bestFriendMonths >= progress.qualifyingFriends * rules.friendMonths
    ? rules.loyalFriendMonths
    : viaFriends;
  const done = Math.max(0, total - progress.monthsToNextReward);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold">{t("referrals.progress")}</p>
        <p className="text-xs text-muted-foreground">
          {progress.monthsToNextReward === 0
            ? t("referrals.almost")
            : t("referrals.monthsToGo", { count: progress.monthsToNextReward })}
        </p>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,var(--primary),var(--highlight))] transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("referrals.progressHint", {
          best: progress.bestFriendMonths,
          qualifying: progress.qualifyingFriends,
        })}
      </p>
    </Card>
  );
}
