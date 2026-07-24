import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { Node, ProtocolConfig } from "@/lib/types";
import { ProtocolConfigsTable } from "./protocol-configs-table";

export default async function ProtocolConfigsPage() {
  const [protocolConfigs, nodes, session] = await Promise.all([
    apiFetch<ProtocolConfig[]>("/protocol-configs"),
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
