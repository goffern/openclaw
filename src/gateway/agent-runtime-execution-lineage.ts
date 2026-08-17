import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-identity-token.js";

export type AgentRuntimeExecutionLineage = {
  relation: "sessions_spawn";
  requesterRef: string;
  controllerRef: string;
  depth: number;
  applicableGrantRefs: string[];
  localPolicyRefs: string[];
  runtimeAssuranceRefs: string[];
  targetPolicyRefs: string[];
  externalNativeActions: "observable" | "unsupported";
};

export type AgentRuntimeExecutionLineageCarrier = {
  executionLineage?: AgentRuntimeExecutionLineage;
};

/** Add private signed lineage without expanding the public session-spawn context. */
export function withAgentRuntimeExecutionLineage<T extends AgentRuntimeSessionSpawnContext>(
  context: T,
  lineage: AgentRuntimeExecutionLineage,
): T & AgentRuntimeExecutionLineageCarrier {
  return { ...context, executionLineage: lineage };
}

export function readAgentRuntimeExecutionLineage(
  context: (AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier) | undefined,
): AgentRuntimeExecutionLineage | undefined {
  return context?.executionLineage;
}
