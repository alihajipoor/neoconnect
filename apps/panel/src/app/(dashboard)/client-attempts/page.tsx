import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type {
  ClientAttempt,
  ClientAttemptOutcome,
  ClientAttemptSummaryRow,
} from "@/lib/types";
import { ClientAttemptsView } from "./client-attempts-view";

/** The summary window. A day is the unit a beta is actually watched in --
 * "how did last night's testing go" -- and long enough that a quiet hour
 * does not read as a collapse. */
const SUMMARY_HOURS = 24;

export default async function ClientAttemptsPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string; failures?: string }>;
}) {
  await requireStaff();
  const { outcome, failures } = await searchParams;

  // Failures-only is the default. A beta log dominated by successful
  // connects buries the thing being looked for, and the operator opening
  // this page is looking for what broke.
  const failuresOnly = outcome ? false : failures !== "0";

  const query = new URLSearchParams();
  if (outcome) query.set("outcome", outcome);
  if (failuresOnly) query.set("failuresOnly", "true");

  const [attempts, summary] = await Promise.all([
    apiFetch<ClientAttempt[]>(`/client-attempts?${query.toString()}`),
    apiFetch<ClientAttemptSummaryRow[]>(`/client-attempts/summary?hours=${SUMMARY_HOURS}`),
  ]);

  return (
    <ClientAttemptsView
      attempts={attempts}
      summary={summary}
      summaryHours={SUMMARY_HOURS}
      activeOutcome={(outcome as ClientAttemptOutcome | undefined) ?? null}
      failuresOnly={failuresOnly}
    />
  );
}
