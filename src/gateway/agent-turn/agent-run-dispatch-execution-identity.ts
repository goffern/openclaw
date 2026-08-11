import type { AgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";

const AGENT_RUN_DISPATCH_EXECUTION_IDENTITY = Symbol("agentRunDispatchExecutionIdentity");

type AgentRunDispatchExecutionIdentityCarrier = {
  [AGENT_RUN_DISPATCH_EXECUTION_IDENTITY]?: AgentCommandExecutionIdentitySpawnFacts;
};

export function withAgentRunDispatchExecutionIdentity<T extends object>(
  params: T,
  facts: AgentCommandExecutionIdentitySpawnFacts | undefined,
): T {
  return facts ? ({ ...params, [AGENT_RUN_DISPATCH_EXECUTION_IDENTITY]: facts } as T) : params;
}

export function readAgentRunDispatchExecutionIdentity(
  params: object,
): AgentCommandExecutionIdentitySpawnFacts | undefined {
  return (params as AgentRunDispatchExecutionIdentityCarrier)[
    AGENT_RUN_DISPATCH_EXECUTION_IDENTITY
  ];
}
