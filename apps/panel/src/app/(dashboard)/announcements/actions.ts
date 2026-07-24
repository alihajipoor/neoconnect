"use server";

import { apiMutate, type MutationResult } from "@/lib/api";
import type { SubscriptionStatus } from "@/lib/types";

export interface SendAnnouncementResult {
  recipientCount: number;
}

export async function sendAnnouncementAction(input: {
  subject: string;
  body: string;
  statuses?: SubscriptionStatus[];
  planIds?: string[];
  routeIds?: string[];
}): Promise<MutationResult<SendAnnouncementResult>> {
  return apiMutate<SendAnnouncementResult>("/announcements/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
