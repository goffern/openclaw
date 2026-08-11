import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  bindWorkerTurnExecutionIdentity,
  readWorkerTurnExecutionIdentity,
} from "./placement-turn-claim-events.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-claim-close",
  agentId: "main",
  sessionKey: "agent:main:placement-claim-close",
};

let root: string;
let database: OpenClawStateDatabase;
let store: WorkerSessionPlacementStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-claim-"));
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = createWorkerSessionPlacementStore({ database });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

function advanceToActive() {
  let placement = store.startDispatch(SESSION);
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: "environment-placement-claim-close" },
  });
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/workspace/placement-claim-close",
    },
  });
  const active = store.transition({
    sessionId: SESSION.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: 7 },
  });
  if (active.state !== "active") {
    throw new Error("expected active worker placement");
  }
  return active;
}

it("emits exact worker claim closure after release and owner fencing", () => {
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  const active = advanceToActive();
  const owner = {
    kind: "worker" as const,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const first = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-release",
    runId: "run-release",
  });
  const firstIdentity = createExecutionIdentityAdmissionToken(first.runId);
  bindWorkerTurnExecutionIdentity(store, first, firstIdentity);
  expect(
    readWorkerTurnExecutionIdentity(store, {
      sessionId: first.sessionId,
      environmentId: owner.environmentId,
      ownerEpoch: owner.ownerEpoch,
      runId: first.runId,
    }),
  ).toBe(firstIdentity);
  store.releaseTurn(first);
  expect(
    readWorkerTurnExecutionIdentity(store, {
      sessionId: first.sessionId,
      environmentId: owner.environmentId,
      ownerEpoch: owner.ownerEpoch,
      runId: first.runId,
    }),
  ).toBeUndefined();
  expect(closed).toHaveBeenLastCalledWith(first);

  const second = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-fence",
    runId: "run-fence",
  });
  bindWorkerTurnExecutionIdentity(
    store,
    second,
    createExecutionIdentityAdmissionToken(second.runId),
  );
  const draining = store.startDrain({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  store.startReconcile({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  });
  expect(
    readWorkerTurnExecutionIdentity(store, {
      sessionId: second.sessionId,
      environmentId: owner.environmentId,
      ownerEpoch: owner.ownerEpoch,
      runId: second.runId,
    }),
  ).toBeUndefined();
  expect(closed).toHaveBeenLastCalledWith(second);
  expect(closed).toHaveBeenCalledTimes(2);
  unregister();
});
