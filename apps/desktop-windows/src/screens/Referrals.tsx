import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, Gift, Users } from "lucide-react";
import { getReferrals } from "../lib/customer";
import type { ReferralOverview } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { formatDate, formatNumber } from "../lib/locale-format";
import { Card, CardHead, Message, PillButton, Skeleton } from "../components/ui";
import { Page } from "../components/shell/Page";
import { StillTrying } from "../components/StillTrying";

/** Invite friends, earn free time.
 *
 * The screen's job is to answer one question at a glance -- how far am I
 * from the next free month -- and it answers it with the server's own
 * arithmetic rather than recomputing the rules here. Two copies of a
 * reward calculation would eventually disagree, and the one the customer
 * reads is not the one that pays out.
 */
export function Referrals({ onBack }: { onBack: () => void }) {
  const { t, language } = useI18n();
  const [data, setData] = useState<ReferralOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getReferrals().then((result) => {
      if (cancelled) return;
      if (result.ok) setData(result.data);
      else setError(failureText(result, t));
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

  const n = (value: number) => formatNumber(value, language);

  return (
    <Page title={t("referrals.title")} lede={t("referrals.subtitle")} back={onBack} backAlways data-referrals>
      {error ? <Message tone="danger">{error}</Message> : null}

      {/* Waiting. The screen used to stay empty, with nothing on it at
          all, for as long as the read took -- up to twenty seconds an
          address now. */}
      {data === null && error === null ? (
        <div className="flex flex-col items-center gap-3 py-10">
          <span className="nx-spin" aria-hidden />
          <StillTrying waiting />
          <Skeleton card rows={2} className="w-full max-w-md" />
        </div>
      ) : null}

      {data && !data.enabled ? (
        <Card>
          <p className="nx-csub m-0">{t("referrals.off")}</p>
        </Card>
      ) : null}

      {data?.enabled ? (
        <div className="nx-cols">
          {/* The code, given the most weight on the screen: it is the one
              thing the customer came here to get. */}
          <Card className="flex flex-col gap-1">
            <CardHead
              icon={<Gift />}
              title={t("referrals.yourCode")}
              hint={t("referrals.rule", {
                months: n(data.rules.loyalFriendMonths),
                friends: n(data.rules.friendsRequired),
                each: n(data.rules.friendMonths),
                days: n(data.rules.rewardDays),
              })}
            />
            <div className="nx-codebox">
              <code dir="ltr">{data.code ?? "--"}</code>
              <PillButton variant="ghost" size="sm" onClick={() => void copyCode()}>
                {copied ? <Check className="nx-done-in" aria-hidden /> : <Copy aria-hidden />}
                <span key={copied ? "done" : "copy"} className="nx-swap">
                  {copied ? t("referrals.copied") : t("referrals.copy")}
                </span>
              </PillButton>
            </div>
          </Card>

          <ProgressCard data={data} />

          <Card className="flex flex-col gap-2">
            <CardHead
              icon={<Users />}
              title={`${t("referrals.friends")} (${n(data.friends.length)})`}
              hint={t("referrals.friendsHint")}
            />
            {data.friends.length === 0 ? (
              <p className="nx-csub">{t("referrals.noFriends")}</p>
            ) : (
              <ul className="nx-alist m-0 list-none p-0">
                {data.friends.map((friend) => (
                  <li key={friend.maskedEmail + friend.joinedAt} className="nx-arow">
                    {/* Neutral: a friend who joined and has not paid yet is
                        not a problem to flag. */}
                    <span className={`nx-fdot ${friend.paidMonths > 0 ? "paid" : friend.activated ? "joined" : ""}`} aria-hidden />
                    <span className="t">
                      <span className="n" dir="ltr">
                        {friend.maskedEmail}
                      </span>
                    </span>
                    <span className="nx-res">
                      {friend.paidMonths > 0
                        ? t(friend.paidMonths === 1 ? "referrals.paidMonth" : "referrals.paidMonths", { count: n(friend.paidMonths) })
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
              <h2 className="nx-ctitle">{t("referrals.earned")}</h2>
              <ul className="nx-alist m-0 list-none p-0">
                {data.rewards.map((reward) => (
                  <li key={reward.id} className="nx-arow">
                    <span className="t">
                      <span className="n">{t("referrals.freeDays", { days: n(reward.rewardDays) })}</span>
                    </span>
                    <span className="nx-res">{formatDate(reward.grantedAt, language)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}

/** How close the next free month is.
 *
 * Shown as a bar against whichever of the two routes is nearer, because
 * "you need 3 months from one friend OR 3 friends with 1 month each" is
 * two sentences nobody reads and one number everybody does.
 */
function ProgressCard({ data }: { data: ReferralOverview }) {
  const { t, language } = useI18n();
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
  const n = (value: number) => formatNumber(value, language);

  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="nx-ctitle">{t("referrals.progress")}</h2>
        <p className="nx-csub m-0">
          {progress.monthsToNextReward === 0
            ? t("referrals.almost")
            : t(progress.monthsToNextReward === 1 ? "referrals.monthToGo" : "referrals.monthsToGo", {
                count: n(progress.monthsToNextReward),
              })}
        </p>
      </div>
      <div
        className="nx-bar"
        role="progressbar"
        aria-label={t("referrals.progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <i style={{ "--f": percent / 100 } as React.CSSProperties} />
      </div>
      <p className="nx-tiny">
        {t("referrals.progressHint", {
          best: n(progress.bestFriendMonths),
          qualifying: n(progress.qualifyingFriends),
        })}
      </p>
    </Card>
  );
}
