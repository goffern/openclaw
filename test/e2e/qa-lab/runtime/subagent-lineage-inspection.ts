// QA Lab producer proves persisted parent-child lineage through a real sessions_spawn turn.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import type {
  AuditRunInspectResult,
  ExecutionIdentityContextV1,
} from "../../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "subagent-lineage-inspection";
const SUMMARY_FILE = `${SCENARIO_ID}-summary.json`;
const PRIVATE_TASK_SENTINEL = "I3-PRIVATE-TASK-SENTINEL";
const PRIVATE_SESSION_SENTINEL = "i3-private-session-sentinel";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type PersistedContext = {
  context: ExecutionIdentityContextV1;
  contextJson: string;
  executionId: string;
  runId: string;
};

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  let artifactBase: string | undefined;
  let repoRoot = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = argv[++index];
    } else if (arg === "--repo-root") {
      repoRoot = argv[++index] ?? repoRoot;
    } else if (arg !== "--") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!artifactBase) {
    throw new Error("--output-dir is required");
  }
  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    repoRoot: path.resolve(repoRoot),
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`, { cause: error });
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function enableExecutionIdentity(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    logging: {
      ...config.logging,
      audit: {
        ...config.logging?.audit,
        executionIdentity: true,
      },
    },
  };
}

function readPersistedContexts(stateDir: string): PersistedContext[] {
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return (
      database
        .prepare(
          "SELECT run_id, execution_id, context_json FROM execution_identity_contexts ORDER BY created_at, context_id",
        )
        .all() as Array<{ context_json: string; execution_id: string; run_id: string }>
    ).map((row) => ({
      context: parseJson<ExecutionIdentityContextV1>(
        row.context_json,
        "persisted identity context",
      ),
      contextJson: row.context_json,
      executionId: row.execution_id,
      runId: row.run_id,
    }));
  } finally {
    database.close();
  }
}

async function waitForLineage(stateDir: string, parentRunId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = readPersistedContexts(stateDir);
    const parent = rows.find((row) => row.runId === parentRunId && !row.context.lineage);
    const children = rows.filter((row) => row.context.lineage?.parentRunId === parentRunId);
    if (parent && children.length === 1) {
      return { parent, child: children[0]! };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for one child identity context for parent ${parentRunId}`);
}

function requirePresentContext(result: AuditRunInspectResult, label: string) {
  if (result.identity.state !== "present") {
    throw new Error(`${label} identity was ${result.identity.state}`);
  }
  return result.identity.context;
}

function assertPrivateValuesAbsent(value: unknown, label: string) {
  const encoded = JSON.stringify(value);
  for (const forbidden of [PRIVATE_TASK_SENTINEL, PRIVATE_SESSION_SENTINEL, "qa-direct-lineage"]) {
    if (encoded.includes(forbidden)) {
      throw new Error(`${label} leaked private value ${forbidden}`);
    }
  }
}

function assertChildLineage(params: {
  child: ExecutionIdentityContextV1;
  parent: ExecutionIdentityContextV1;
}) {
  const { child, parent } = params;
  const lineage = child.lineage;
  if (!lineage) {
    throw new Error("child identity omitted lineage");
  }
  if (
    lineage.parentContextId !== parent.contextId ||
    lineage.parentExecutionId !== parent.executionId ||
    lineage.parentRunId !== parent.runId ||
    lineage.depth !== 1
  ) {
    throw new Error("child identity did not preserve the exact depth-one parent chain");
  }
  if (
    !lineage.parentAgentPrincipal ||
    lineage.parentAgentPrincipal.kind !== "agent" ||
    lineage.parentAgentPrincipal.principalRef !== parent.agentPrincipal.principalRef ||
    !lineage.delegationRef
  ) {
    throw new Error("child lineage did not preserve the parent agent and delegation references");
  }
  if (
    child.coverageState !== "attribution-only" ||
    !child.applicableGrants.some((grant) => grant.state === "present") ||
    !child.assurance.some((entry) => entry.kind === "spawn-lineage") ||
    child.missingEvidence.length !== 0
  ) {
    throw new Error("child lineage coverage, grants, assurance, or missing evidence was incorrect");
  }
  assertPrivateValuesAbsent(child, "child identity");
}

async function inspectJson(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  args: string[],
  label: string,
) {
  return parseJson<AuditRunInspectResult>(
    await gateway.runCli(["audit", ...args, "--explain", "--json"]),
    label,
  );
}

async function runProof(options: ProducerOptions): Promise<string> {
  const mock = await startQaMockOpenAiServer();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: enableExecutionIdentity,
    });
    const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("QA Gateway omitted its isolated state directory");
    }

    const started = (await gateway.call("chat.send", {
      sessionKey: `agent:qa:${PRIVATE_SESSION_SENTINEL}`,
      message: `Use sessions_spawn for this QA check. task="Reply exactly ${PRIVATE_TASK_SENTINEL}." label=qa-direct-lineage mode=run.`,
      deliver: false,
      idempotencyKey: randomUUID(),
    })) as { runId?: string; status?: string };
    if (started.status !== "started" || !started.runId) {
      throw new Error(`chat.send did not start: ${JSON.stringify(started)}`);
    }
    const completed = (await gateway.call(
      "agent.wait",
      { runId: started.runId, timeoutMs: 60_000 },
      { timeoutMs: 65_000 },
    )) as { status?: string };
    if (completed.status !== "ok") {
      throw new Error(`parent agent.wait did not complete: ${JSON.stringify(completed)}`);
    }

    const { parent, child } = await waitForLineage(stateDir, started.runId);
    assertChildLineage({ parent: parent.context, child: child.context });

    const parentText = await gateway.runCli(["audit", "--run", parent.runId, "--explain"]);
    const childText = await gateway.runCli([
      "audit",
      "--execution",
      child.executionId,
      "--explain",
    ]);
    for (const required of [
      "Lineage",
      "Parent context",
      "Parent execution",
      "Parent run",
      "Depth",
    ]) {
      if (!childText.includes(required)) {
        throw new Error(`child audit text omitted ${required}`);
      }
    }
    if (!parentText.includes("Identity")) {
      throw new Error("parent audit text omitted identity");
    }

    const parentBefore = await inspectJson(gateway, ["--run", parent.runId], "parent audit");
    const childBefore = await inspectJson(
      gateway,
      ["--execution", child.executionId],
      "child audit",
    );
    const parentContext = requirePresentContext(parentBefore, "parent");
    const childContext = requirePresentContext(childBefore, "child");
    assertChildLineage({ parent: parentContext, child: childContext });
    if (JSON.stringify(childContext) !== child.contextJson) {
      throw new Error("CLI child context bytes differed from persisted bytes");
    }

    await gateway.restartAfterStateMutation(async () => {});
    const parentAfter = await inspectJson(
      gateway,
      ["--execution", parent.executionId],
      "post-restart parent audit",
    );
    const childAfter = await inspectJson(
      gateway,
      ["--execution", child.executionId],
      "post-restart child audit",
    );
    if (
      JSON.stringify(requirePresentContext(parentAfter, "post-restart parent")) !==
        JSON.stringify(parentContext) ||
      JSON.stringify(requirePresentContext(childAfter, "post-restart child")) !== child.contextJson
    ) {
      throw new Error("parent or child identity context changed across Gateway restart");
    }
    assertPrivateValuesAbsent(childAfter, "post-restart child inspection");

    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      path.join(options.artifactBase, SUMMARY_FILE),
      `${JSON.stringify(
        {
          parent: {
            contextId: parent.context.contextId,
            executionId: parent.executionId,
            runId: parent.runId,
          },
          child: {
            contextId: child.context.contextId,
            executionId: child.executionId,
            runId: child.runId,
            contextSha256: sha256(child.contextJson),
          },
          lineage: {
            depth: child.context.lineage?.depth,
            parentContextId: child.context.lineage?.parentContextId,
            parentExecutionId: child.context.lineage?.parentExecutionId,
            parentRunId: child.context.lineage?.parentRunId,
          },
          evidence: {
            byteEquivalentAfterRestart: true,
            byteEquivalentPersistedReadback: true,
            privateValuesAbsent: true,
            actualSessionsSpawn: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `parent=${parent.runId}; child=${child.runId}; execution=${child.executionId}; lineage depth=1; persisted+CLI bytes stable across restart; sha256=${sha256(child.contextJson)}`;
  } finally {
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      artifacts: [{ filePath: SUMMARY_FILE, kind: "summary" }],
      details: await runProof(options),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Subagent execution lineage inspection",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/tools/subagents.md", "docs/cli/audit.md"],
      codeRefs: [
        "src/agents/tools/sessions-spawn-tool.ts",
        "src/agents/subagents/spawn/subagent-spawn.ts",
        "src/agents/subagents/spawn/subagent-spawn-gateway.ts",
        "src/gateway/agent-turn/agent-run-execution-lineage.ts",
        "src/audit/execution-identity-context-build.ts",
        "src/commands/audit.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  const priorConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = path.join(options.artifactBase, "script-state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(options.artifactBase, "script-openclaw.json");
  try {
    const evidence = await runProducer(options);
    const status = evidence.entries[0]?.result.status;
    console.log(`Subagent lineage evidence: ${QA_EVIDENCE_FILENAME}`);
    console.log(`Subagent lineage status: ${status}`);
    return status === "pass" ? 0 : 1;
  } finally {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    if (priorConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = priorConfigPath;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
