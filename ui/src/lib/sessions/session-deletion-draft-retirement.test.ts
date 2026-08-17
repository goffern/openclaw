import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const retirement = vi.hoisted(() => ({
  run: vi.fn<() => Promise<never>>(),
}));

vi.mock("../chat/composer-draft-store.ts", () => ({
  retireDurableComposerDraft: retirement.run,
}));

beforeEach(() => {
  retirement.run.mockReset();
  retirement.run.mockReturnValue(
    new Promise<never>(() => {
      // Intentionally pending: deletion must not await best-effort browser cleanup.
    }),
  );
});

it("schedules confirmed draft retirement without delaying session deletion", async () => {
  const key = "agent:main:confirmed-delete";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.delete") {
      return { ok: true, deleted: true };
    }
    if (method === "sessions.list") {
      return sessionsResult([], 2);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = {
    gatewayUrl: "ws://gateway.test",
    recoveryScope: "credential-a",
    recoveryScopeReady: true,
    request,
  } as unknown as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client);
  const sessions = createSessionCapability(gateway);

  await expect(sessions.delete(key)).resolves.toEqual({ deleted: true });
  expect(retirement.run).toHaveBeenCalledOnce();
  sessions.dispose();
});

it("does not schedule draft retirement for a deletion no-op", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.delete") {
      return { ok: true, deleted: false };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = {
    gatewayUrl: "ws://gateway.test",
    recoveryScope: "credential-a",
    recoveryScopeReady: true,
    request,
  } as unknown as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client);
  const sessions = createSessionCapability(gateway);

  await expect(sessions.delete("agent:main:not-deleted")).resolves.toEqual({ deleted: false });
  expect(retirement.run).not.toHaveBeenCalled();
  sessions.dispose();
});
