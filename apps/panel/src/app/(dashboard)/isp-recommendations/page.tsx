import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { IspRecommendationsSummary } from "@/lib/types";
import { IspRecommendationsView } from "./isp-recommendations-view";

export default async function IspRecommendationsPage() {
  await requireStaff();
  const summary = await apiFetch<IspRecommendationsSummary>("/isp-recommendations");
  return <IspRecommendationsView summary={summary} />;
}
