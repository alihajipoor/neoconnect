import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import { fetchProtocolConfigs } from "@/lib/infra";
import type { Node } from "@/lib/types";
import { ProtocolConfigsTable } from "./protocol-configs-table";

export default async function ProtocolConfigsPage() {
  await requireStaff();
  const [protocolConfigs, nodes, session] = await Promise.all([
    fetchProtocolConfigs(),
    apiFetch<Node[]>("/nodes"),
    getSession(),
  ]);
  return (
    <ProtocolConfigsTable
      protocolConfigs={protocolConfigs}
      nodes={nodes}
      canManage={session?.role === "SUPERADMIN"}
    />
  );
}
