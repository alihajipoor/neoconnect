import { apiFetch } from "@/lib/api";
import type { SupportTicket } from "@/lib/types";
import { TicketThread } from "../ticket-thread";

export default async function SupportTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ticket = await apiFetch<SupportTicket>(`/support/tickets/${id}`);
  return <TicketThread ticket={ticket} />;
}
