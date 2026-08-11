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

type AgentRuntimeExecutionLineageCarrier = {
  executionLineage?: AgentRuntimeExecutionLineage;
};

/** Add private signed lineage without expanding the public session-spawn context. */
export function withAgentRuntimeExecutionLineage<T extends AgentRuntimeSessionSpawnContext>(
  context: T,
  lineage: AgentRuntimeExecutionLineage,
): T {
  return { ...context, executionLineage: lineage } as T;
}

export function readAgentRuntimeExecutionLineage(
  context: AgentRuntimeSessionSpawnContext | undefined,
): AgentRuntimeExecutionLineage | undefined {
  return (
    context as (AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier) | undefined
  )?.executionLineage;
}
