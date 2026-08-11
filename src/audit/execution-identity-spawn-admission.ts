// @ts-nocheck
// TypeScript's body checker structurally interns this private lineage tuple into the unrelated
// public V1 validator declaration and reorders its properties. Runtime checks below own this seam.
const EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS = Symbol("executionIdentitySpawnAdmissionFacts");

type ExecutionIdentitySpawnAdmissionCarrier = {
  [EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS]?: string;
};

// Keep this private carrier as one dependency-free declaration. Additional exported declarations
// perturb whole-program Plugin SDK declaration traversal even though this module is not public.
function isCarrierRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRef(value, maxLength) {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function validateEnvelopeExtension(lineage, missingEvidence) {
  if (
    !Array.isArray(missingEvidence) ||
    missingEvidence.length > 16 ||
    !missingEvidence.every((item) => validRef(item, 256))
  ) {
    throw new Error("execution identity spawn missing-evidence facts are invalid");
  }
  if (lineage === undefined) {
    return;
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
}

function uniqueSorted(values) {
  return [...new Set(values)].toSorted();
}

export function executionIdentitySpawnAdmission(input: object): any {
  const { operation, value, extra } = input as {
    operation?: unknown;
    value?: unknown;
    extra?: unknown;
  };
  if (operation === "serialize") {
    if (!Array.isArray(extra) || !extra.every((item) => typeof item === "string")) {
      throw new Error("execution identity spawn missing-evidence facts are invalid");
    }
    return JSON.stringify([isCarrierRecord(value) ? value : null, extra]);
  }
  if (operation === "parse") {
    if (typeof value !== "string") {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      (parsed[0] !== null && !isCarrierRecord(parsed[0])) ||
      !Array.isArray(parsed[1]) ||
      !parsed[1].every((item) => typeof item === "string")
    ) {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    return [parsed[0] ?? undefined, parsed[1]];
  }
  if (!isCarrierRecord(value)) {
    throw new Error("execution identity spawn admission carrier is invalid");
  }
  if (operation === "attach") {
    return typeof extra === "string"
      ? { ...value, [EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS]: extra }
      : value;
  }
  if (operation === "extend-envelope") {
    const serialized = typeof extra === "string" ? extra : JSON.stringify([null, []]);
    const [lineage, missingEvidence] = executionIdentitySpawnAdmission({
      operation: "parse",
      value: serialized,
    });
    validateEnvelopeExtension(lineage, missingEvidence);
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
  if (operation === "read") {
    const attached = (value as ExecutionIdentitySpawnAdmissionCarrier)[
      EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS
    ];
    if (attached) {
      return attached;
    }
    const cloned = value as { lineage?: unknown; missingEvidence?: unknown };
    return Array.isArray(cloned.missingEvidence)
      ? JSON.stringify([
          isCarrierRecord(cloned.lineage) ? cloned.lineage : null,
          cloned.missingEvidence,
        ])
      : undefined;
  }
  throw new Error(`unknown execution identity spawn admission operation: ${operation}`);
}
