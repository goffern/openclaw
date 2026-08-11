import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";

type TurnClaimReleaseWaiter = (error?: Error) => void;

const turnClaimReleaseWaiters = resolveGlobalMap<string, Map<string, Set<TurnClaimReleaseWaiter>>>(
  Symbol.for("openclaw.turnClaimReleaseWaiters"),
  (waitersByPath) => {
    const error = new Error("Gateway lifecycle ended while waiting for turn claim release");
    for (const bySession of waitersByPath.values()) {
      for (const waiters of bySession.values()) {
        for (const reject of waiters) {
          reject(error);
        }
      }
    }
    waitersByPath.clear();
  },
);

const workerTurnClaimClosedHandlers = resolveGlobalMap<
  string,
  Set<(claim: WorkerSessionTurnClaim) => void>
>(Symbol.for("openclaw.workerTurnClaimClosedHandlers"), (handlersByPath) => {
  handlersByPath.clear();
});

const workerTurnExecutionIdentities = resolveGlobalMap<
  string,
  Map<
    string,
    { claim: WorkerSessionTurnClaim; claimKey: string; token: ExecutionIdentityAdmissionToken }
  >
>(Symbol.for("openclaw.workerTurnExecutionIdentities"), (identities) => identities.clear());

const WORKER_TURN_EXECUTION_IDENTITY_PATH = Symbol("workerTurnExecutionIdentityPath");
type WorkerTurnExecutionIdentityStore = {
  validateTurnClaim(claim: WorkerSessionTurnClaim): boolean;
  [WORKER_TURN_EXECUTION_IDENTITY_PATH]?: string;
};

function claimKey(claim: WorkerSessionTurnClaim): string {
  return JSON.stringify([
    claim.claimId,
    claim.runId,
    claim.placementGeneration,
    claim.owner.kind,
    claim.owner.kind === "worker" ? claim.owner.environmentId : null,
    claim.owner.kind === "worker" ? claim.owner.ownerEpoch : null,
  ]);
}

/** Bind diagnostic provenance to the exact live worker claim; it grants no authority. */
export function bindWorkerTurnExecutionIdentity(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
  token: ExecutionIdentityAdmissionToken,
): void {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  if (!path || !store.validateTurnClaim(claim)) {
    throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
  }
  const identities = workerTurnExecutionIdentities.get(path) ?? new Map();
  identities.set(claim.sessionId, { claim, claimKey: claimKey(claim), token });
  workerTurnExecutionIdentities.set(path, identities);
}

export function readWorkerTurnExecutionIdentity(
  store: WorkerTurnExecutionIdentityStore,
  binding: { sessionId: string; environmentId: string; ownerEpoch: number; runId: string },
): ExecutionIdentityAdmissionToken | undefined {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const bound = path ? workerTurnExecutionIdentities.get(path)?.get(binding.sessionId) : undefined;
  const owner = bound?.claim.owner;
  return bound &&
    owner?.kind === "worker" &&
    bound.claim.runId === binding.runId &&
    owner.environmentId === binding.environmentId &&
    owner.ownerEpoch === binding.ownerEpoch &&
    store.validateTurnClaim(bound.claim)
    ? bound.token
    : undefined;
}

export function attachWorkerTurnExecutionIdentityStore(store: object, path: string): void {
  Object.defineProperty(store, WORKER_TURN_EXECUTION_IDENTITY_PATH, { value: path });
}

export function waitersFor(path: string, sessionId: string): Set<TurnClaimReleaseWaiter> {
  let bySession = turnClaimReleaseWaiters.get(path);
  if (!bySession) {
    bySession = new Map();
    turnClaimReleaseWaiters.set(path, bySession);
  }
  let waiters = bySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    bySession.set(sessionId, waiters);
  }
  return waiters;
}

export function signalTurnClaimRelease(path: string, sessionId: string): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  bySession.delete(sessionId);
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

export function removeTurnClaimReleaseWaiter(
  path: string,
  sessionId: string,
  waiter: TurnClaimReleaseWaiter,
): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    bySession.delete(sessionId);
  }
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
}

export function registerWorkerTurnClaimClosedHandler(
  path: string,
  handler: (claim: WorkerSessionTurnClaim) => void,
): () => void {
  const handlers = workerTurnClaimClosedHandlers.get(path) ?? new Set();
  handlers.add(handler);
  workerTurnClaimClosedHandlers.set(path, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      workerTurnClaimClosedHandlers.delete(path);
    }
  };
}

export function signalWorkerTurnClaimClosed(path: string, claim: WorkerSessionTurnClaim): void {
  signalTurnClaimRelease(path, claim.sessionId);
  const identities = workerTurnExecutionIdentities.get(path);
  if (identities?.get(claim.sessionId)?.claimKey === claimKey(claim)) {
    identities.delete(claim.sessionId);
    if (identities.size === 0) {
      workerTurnExecutionIdentities.delete(path);
    }
  }
  for (const handler of workerTurnClaimClosedHandlers.get(path) ?? []) {
    try {
      handler(claim);
    } catch {
      // Settlement observation cannot roll back the authoritative store transition.
    }
  }
}
