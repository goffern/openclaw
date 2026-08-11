const EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS = Symbol("executionIdentitySpawnAdmissionFacts");

type ExecutionIdentitySpawnAdmissionCarrier = {
  [EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS]?: string;
};

type ExecutionIdentitySpawnLineage = {
  parentContextId?: string;
  parentExecutionId?: string;
  parentRunId?: string;
  parentAgentId: string;
  relation: "sessions_spawn";
  rawRequesterRef: string;
  rawControllerRef: string;
  depth: number;
  localPolicyRefs: string[];
  targetPolicyRefs: string[];
};

type ExecutionIdentitySpawnAdmissionExtension = {
  lineage?: ExecutionIdentitySpawnLineage;
  missingEvidence: string[];
};

type ExecutionIdentitySpawnAdmissionInput =
  | { operation: "serialize"; value: unknown; extra: unknown }
  | { operation: "parse"; value: unknown }
  | { operation: "attach"; value: unknown; extra?: unknown }
  | { operation: "extend-envelope"; value: unknown; extra?: unknown }
  | { operation: "base-envelope"; value: unknown }
  | { operation: "read"; value: unknown };

function isCarrierRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRef(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function validateEnvelopeExtension(
  lineage: unknown,
  missingEvidence: unknown,
): ExecutionIdentitySpawnAdmissionExtension {
  if (
    !Array.isArray(missingEvidence) ||
    missingEvidence.length > 16 ||
    !missingEvidence.every((item) => validRef(item, 256))
  ) {
    throw new Error("execution identity spawn missing-evidence facts are invalid");
  }
  if (lineage === undefined || lineage === null) {
    return { missingEvidence };
  }
  if (
    !isCarrierRecord(lineage) ||
    (lineage.parentContextId !== undefined && !validRef(lineage.parentContextId, 256)) ||
    (lineage.parentExecutionId !== undefined && !validRef(lineage.parentExecutionId, 256)) ||
    (lineage.parentRunId !== undefined && !validRef(lineage.parentRunId, 256)) ||
    !validRef(lineage.parentAgentId, 256) ||
    lineage.relation !== "sessions_spawn" ||
    !validRef(lineage.rawRequesterRef, 4_096) ||
    !validRef(lineage.rawControllerRef, 4_096) ||
    !Number.isSafeInteger(lineage.depth) ||
    typeof lineage.depth !== "number" ||
    lineage.depth < 1 ||
    lineage.depth > 64 ||
    !Array.isArray(lineage.localPolicyRefs) ||
    lineage.localPolicyRefs.length > 16 ||
    !lineage.localPolicyRefs.every((item) => validRef(item, 4_096)) ||
    !Array.isArray(lineage.targetPolicyRefs) ||
    lineage.targetPolicyRefs.length > 16 ||
    !lineage.targetPolicyRefs.every((item) => validRef(item, 4_096))
  ) {
    throw new Error("execution identity spawn lineage facts are invalid");
  }
  return {
    lineage: {
      ...(lineage.parentContextId !== undefined
        ? { parentContextId: lineage.parentContextId }
        : {}),
      ...(lineage.parentExecutionId !== undefined
        ? { parentExecutionId: lineage.parentExecutionId }
        : {}),
      ...(lineage.parentRunId !== undefined ? { parentRunId: lineage.parentRunId } : {}),
      parentAgentId: lineage.parentAgentId,
      relation: lineage.relation,
      rawRequesterRef: lineage.rawRequesterRef,
      rawControllerRef: lineage.rawControllerRef,
      depth: lineage.depth,
      localPolicyRefs: lineage.localPolicyRefs,
      targetPolicyRefs: lineage.targetPolicyRefs,
    },
    missingEvidence,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

// The broad return keeps this private module out of the public Plugin SDK declaration closure.
// Every operation is checked below against the discriminated input and bounded runtime contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executionIdentitySpawnAdmission(input: object): any {
  const operationInput = input as ExecutionIdentitySpawnAdmissionInput;
  const { operation, value } = operationInput;
  if (operation === "serialize") {
    const extension = validateEnvelopeExtension(value, operationInput.extra);
    return JSON.stringify([extension.lineage ?? null, extension.missingEvidence]);
  }
  if (operation === "parse") {
    if (typeof value !== "string") {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    const extension = validateEnvelopeExtension(parsed[0], parsed[1]);
    return [extension.lineage, extension.missingEvidence];
  }
  if (!isCarrierRecord(value)) {
    throw new Error("execution identity spawn admission carrier is invalid");
  }
  if (operation === "attach") {
    return typeof operationInput.extra === "string"
      ? { ...value, [EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS]: operationInput.extra }
      : value;
  }
  if (operation === "extend-envelope") {
    const serialized =
      typeof operationInput.extra === "string" ? operationInput.extra : JSON.stringify([null, []]);
    const [lineage, missingEvidence] = executionIdentitySpawnAdmission({
      operation: "parse",
      value: serialized,
    }) as readonly [ExecutionIdentitySpawnLineage | undefined, string[]];
    const normalizedLineage = lineage
      ? {
          ...lineage,
          localPolicyRefs: uniqueSorted(lineage.localPolicyRefs),
          targetPolicyRefs: uniqueSorted(lineage.targetPolicyRefs),
        }
      : undefined;
    return {
      ...value,
      ...(normalizedLineage ? { lineage: normalizedLineage } : {}),
      missingEvidence: uniqueSorted(missingEvidence),
    };
  }
  if (operation === "base-envelope") {
    const { lineage, missingEvidence, ...baseEnvelope } = value;
    validateEnvelopeExtension(lineage, missingEvidence);
    return baseEnvelope;
  }
  const attached = (value as ExecutionIdentitySpawnAdmissionCarrier)[
    EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS
  ];
  if (attached) {
    return attached;
  }
  if (!Array.isArray(value.missingEvidence)) {
    return undefined;
  }
  const extension = validateEnvelopeExtension(value.lineage, value.missingEvidence);
  return JSON.stringify([extension.lineage ?? null, extension.missingEvidence]);
}
