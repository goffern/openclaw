import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";

const IN_PROCESS_AGENT_RUNTIME_IDENTITY = Symbol("inProcessAgentRuntimeIdentity");

type InProcessAgentRuntimeIdentityCarrier = {
  [IN_PROCESS_AGENT_RUNTIME_IDENTITY]?: AgentRuntimeIdentity;
};

/** Carry authenticated runtime identity without widening plugin dispatch options. */
export function withInProcessAgentRuntimeIdentity<T extends object>(
  options: T,
  identity: AgentRuntimeIdentity | undefined,
): T {
  return identity ? ({ ...options, [IN_PROCESS_AGENT_RUNTIME_IDENTITY]: identity } as T) : options;
}

export function readInProcessAgentRuntimeIdentity(
  options: object | undefined,
): AgentRuntimeIdentity | undefined {
  return (options as InProcessAgentRuntimeIdentityCarrier | undefined)?.[
    IN_PROCESS_AGENT_RUNTIME_IDENTITY
  ];
}
