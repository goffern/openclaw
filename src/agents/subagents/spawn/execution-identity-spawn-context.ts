import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";

const PARENT_EXECUTION_IDENTITY = Symbol("parentExecutionIdentity");

type ParentExecutionIdentityCarrier = {
  [PARENT_EXECUTION_IDENTITY]?: ExecutionIdentityAdmissionToken;
};

/** Carry exact parent provenance without adding it to public spawn context types. */
export function withParentExecutionIdentity<T extends object>(
  context: T,
  token: ExecutionIdentityAdmissionToken | undefined,
): T {
  return token ? ({ ...context, [PARENT_EXECUTION_IDENTITY]: token } as T) : context;
}

export function readParentExecutionIdentity(
  context: object,
): ExecutionIdentityAdmissionToken | undefined {
  return (context as ParentExecutionIdentityCarrier)[PARENT_EXECUTION_IDENTITY];
}
