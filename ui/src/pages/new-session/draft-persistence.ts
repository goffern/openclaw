import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  readDurableComposerDraft,
  retireDurableComposerDraft,
  type DurableComposerDraftAttachment,
  type DurableComposerDraftScope,
} from "../../lib/chat/composer-draft-store.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { releaseChatAttachmentPayloads } from "../chat/attachment-payload-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  durableComposerDraftMatches,
  durableComposerScopeIdentity,
  hydrateDurableComposerAttachments,
  reportDurableComposerStorageError,
  writeDurableComposerSnapshot,
} from "../chat/durable-composer-persistence.ts";

type NewSessionDraftState = {
  message: string;
  attachments: ChatAttachment[];
  incognito: boolean;
};

type DraftSnapshot = {
  scope: DurableComposerDraftScope;
  revision: number;
  text: string;
  attachments: DurableComposerDraftAttachment[] | null;
  writeId: string;
};

export class NewSessionDraftPersistence {
  private gatewayOwner = "";
  private recoveryScope = "";
  private routeKey = "";
  private revision = 0;
  private mutationGeneration = 0;
  private restoreGeneration = 0;
  private restoredIdentity = "";
  private pending: DraftSnapshot | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly committedByScope = new Map<string, number>();

  constructor(
    private readonly read: () => NewSessionDraftState,
    private readonly apply: (
      message: string,
      attachments: ChatAttachment[],
      resetVisibility?: boolean,
    ) => void,
    private readonly onStorageError: () => void,
  ) {}

  setOwner(gatewayUrl: string, recoveryScope: string, preserveCurrent = false) {
    const gatewayOwner = storageTargetForGateway(gatewayUrl).gatewayOwner;
    const nextOwner = JSON.stringify([gatewayOwner, recoveryScope]);
    const currentOwner = this.gatewayOwner
      ? JSON.stringify([this.gatewayOwner, this.recoveryScope])
      : "";
    if (currentOwner === nextOwner) {
      return;
    }
    this.persistNow();
    this.restoreGeneration += 1;
    this.restoredIdentity = "";
    this.routeKey = "";
    this.gatewayOwner = gatewayOwner;
    this.recoveryScope = recoveryScope;
    if (currentOwner && !preserveCurrent) {
      this.apply("", [], true);
    }
  }

  setIncognito(incognito: boolean): Promise<void> {
    if (incognito) {
      return this.retireActive();
    }
    this.noteUserMutation();
    return this.writeChain;
  }

  selectRoute(routeKey: string) {
    if (!this.gatewayOwner || !this.recoveryScope || !routeKey) {
      return;
    }
    if (this.routeKey !== routeKey) {
      this.routeKey = routeKey;
      this.revision = 0;
      this.pending = null;
    }
  }

  activateRoute(routeKey: string) {
    this.selectRoute(routeKey);
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const identity = durableComposerScopeIdentity(scope);
    if (identity === this.restoredIdentity) {
      return;
    }
    this.restoredIdentity = identity;
    if (this.read().incognito) {
      void this.retireActive();
      return;
    }
    const generation = ++this.restoreGeneration;
    const mutationGeneration = this.mutationGeneration;
    const baseline = this.read();
    const signature = chatAttachmentDraftSignature(baseline.message, baseline.attachments);
    void this.restoreScope(scope, generation, mutationGeneration, signature);
  }

  noteUserMutation() {
    this.mutationGeneration += 1;
    this.revision = nextDraftRevision(this.revision);
    if (this.read().incognito) {
      return;
    }
    const snapshot = this.snapshot();
    if (!snapshot) {
      return;
    }
    this.pending = snapshot;
    this.persistNow();
  }

  retireActive(): Promise<void> {
    this.mutationGeneration += 1;
    const requestedRevision = nextDraftRevision(this.revision);
    this.revision = requestedRevision;
    this.pending = null;
    const scope = this.scope();
    if (!scope) {
      return Promise.resolve();
    }
    return this.enqueueWrite(async () => {
      const identity = durableComposerScopeIdentity(scope);
      const minimumRevision = Math.max(requestedRevision, this.committedByScope.get(identity) ?? 0);
      const result = await retireDurableComposerDraft(scope, minimumRevision);
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
      } else if (result.status === "persisted") {
        this.adoptCommittedRevision(scope, result.revision ?? minimumRevision);
      }
    });
  }

  clearSubmittedDraft(): Promise<void> {
    this.mutationGeneration += 1;
    this.pending = null;
    const scope = this.scope();
    if (!scope) {
      return Promise.resolve();
    }
    const submitted = this.read();
    const submittedAttachments = captureDurableChatAttachments(submitted.attachments);
    return this.enqueueWrite(async () => {
      const identity = durableComposerScopeIdentity(scope);
      let expectedRevision = this.committedByScope.get(identity) ?? 0;
      // A closing source page can finish an identical write between read and CAS.
      // Re-read boundedly; differing newer content always wins immediately.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readDurableComposerDraft(scope);
        if (current.status === "storage-failed") {
          reportDurableComposerStorageError(scope, this.onStorageError);
          return;
        }
        const currentRevision =
          current.status === "found" ? current.draft.revision : current.revision;
        if (currentRevision !== undefined && currentRevision !== expectedRevision) {
          if (
            current.status !== "found" ||
            !(await durableComposerDraftMatches(
              current.draft,
              submitted.message,
              submittedAttachments,
            ))
          ) {
            return;
          }
          expectedRevision = currentRevision;
          this.adoptCommittedRevision(scope, currentRevision);
        }
        const revision = nextDraftRevision(Math.max(this.revision, expectedRevision));
        const { result } = await writeDurableComposerSnapshot({
          scope,
          expectedRevision,
          revision,
          text: "",
          storedAttachments: [],
          writeId: `clear:${revision}`,
        });
        if (result.status === "persisted") {
          this.adoptCommittedRevision(scope, result.revision ?? revision);
          return;
        }
        if (result.status === "storage-failed") {
          reportDurableComposerStorageError(scope, this.onStorageError);
          return;
        }
      }
    });
  }

  persistNow() {
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot || this.read().incognito) {
      return;
    }
    void this.enqueueWrite(async () => {
      const identity = durableComposerScopeIdentity(snapshot.scope);
      const expectedRevision = this.committedByScope.get(identity) ?? 0;
      const revision = nextDraftRevision(Math.max(snapshot.revision - 1, expectedRevision));
      const { result, payloadUnavailable } = await writeDurableComposerSnapshot({
        scope: snapshot.scope,
        expectedRevision,
        revision,
        text: snapshot.text,
        storedAttachments: snapshot.attachments,
        writeId: snapshot.writeId,
      });
      if (payloadUnavailable) {
        reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
      }
      if (result.status === "persisted" || result.status === "payload-too-large") {
        const committedRevision =
          result.status === "persisted" ? (result.revision ?? revision) : revision;
        this.adoptCommittedRevision(snapshot.scope, committedRevision);
        if (result.status === "payload-too-large") {
          reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
        }
      } else if (result.status === "storage-failed") {
        reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
      } else if (result.status === "conflict" && this.routeKey === snapshot.scope.scopeKey) {
        this.restoredIdentity = "";
        this.activateRoute(this.routeKey);
      }
    });
  }

  disconnect() {
    this.restoreGeneration += 1;
  }

  private scope(): DurableComposerDraftScope | null {
    if (!this.gatewayOwner || !this.recoveryScope || !this.routeKey) {
      return null;
    }
    return {
      gatewayOwner: this.gatewayOwner,
      recoveryScope: this.recoveryScope,
      scopeKey: this.routeKey,
    };
  }

  private snapshot(): DraftSnapshot | null {
    const scope = this.scope();
    if (!scope || this.revision <= 0) {
      return null;
    }
    const state = this.read();
    return {
      scope,
      revision: this.revision,
      text: state.message,
      attachments: captureDurableChatAttachments(state.attachments),
      writeId: `${this.revision}:${Math.random().toString(36).slice(2)}`,
    };
  }

  private async restoreScope(
    scope: DurableComposerDraftScope,
    generation: number,
    mutationGeneration: number,
    signature: string,
  ) {
    const result = await readDurableComposerDraft(scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
      return;
    }
    const storedRevision = result.status === "found" ? result.draft.revision : result.revision;
    if (storedRevision !== undefined) {
      this.committedByScope.set(durableComposerScopeIdentity(scope), storedRevision);
    }
    const current = this.read();
    const currentScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !currentScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(currentScope) ||
      signature !== chatAttachmentDraftSignature(current.message, current.attachments)
    ) {
      return;
    }
    if (
      storedRevision === undefined ||
      storedRevision < this.revision ||
      (mutationGeneration > 0 && storedRevision <= this.revision)
    ) {
      if (storedRevision !== undefined && storedRevision >= this.revision) {
        this.revision = nextDraftRevision(storedRevision);
      }
      this.persistNow();
      return;
    }
    let attachments: ChatAttachment[] = [];
    if (result.status === "found") {
      try {
        attachments = await hydrateDurableComposerAttachments(result.draft.attachments);
      } catch {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return;
      }
    }
    const hydratedCurrent = this.read();
    const hydratedScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !hydratedScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(hydratedScope) ||
      signature !==
        chatAttachmentDraftSignature(hydratedCurrent.message, hydratedCurrent.attachments)
    ) {
      releaseChatAttachmentPayloads(attachments);
      return;
    }
    this.revision = storedRevision;
    this.apply(result.status === "found" ? result.draft.text : "", attachments);
  }

  private enqueueWrite(run: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(run, run);
    this.writeChain = pending;
    return pending;
  }

  private adoptCommittedRevision(scope: DurableComposerDraftScope, revision: number) {
    const identity = durableComposerScopeIdentity(scope);
    this.committedByScope.set(identity, revision);
    const currentScope = this.scope();
    if (
      currentScope &&
      durableComposerScopeIdentity(currentScope) === identity &&
      revision > this.revision
    ) {
      this.revision = revision;
    }
  }
}
