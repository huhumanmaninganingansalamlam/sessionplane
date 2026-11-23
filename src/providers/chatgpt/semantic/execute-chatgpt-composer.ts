
import { EDITORS, BUTTONS } from "./semantic-types.ts";

import { sha, captureUi, exactHandle, readExactEditorValue, exactControlReady } from "./chatgpt-page-access.ts";
import { clickExactChatGptSend, watchExactRootDispatch, watchExactDispatch } from "./dispatch-watch.ts";

import type { ElementHandle } from 'playwright-core';

import type { SemanticDispatchEvidence, SemanticRootPostEvidence } from '../../semantic-adapter.ts';
import { semanticConfigurationMatches } from '../../semantic-adapter.ts';

import { observeChatGptDom } from '../dom-observer.ts';

import { inspectSemanticChatGptModelMenu } from '../semantic-model-menu.ts';

import type { ChatGptMutationContext } from './assert-exact-chatgpt-mutation-context.ts';
export interface ChatGptDispatchCapture {
  attempts: SemanticDispatchEvidence[];
  rootPosts: SemanticRootPostEvidence[];
  sinkFailed: boolean;
}
export async function executeChatGptComposerAction(input: ChatGptMutationContext, capture: ChatGptDispatchCapture) {
    const { runtime, request, page, fresh, action, requireExactMutationIdentity } = input;
      if (fresh.editors.length !== 1) return 'stale' as const;
      if (action.purpose === 'compose') {
        if (fresh.editors[0]!.value.length !== 0) return 'stale' as const;
        const editor = await exactHandle(page, EDITORS, fresh.editors[0]!);
        try {
          if (await readExactEditorValue(editor, fresh.editors[0]!) !== '') {
            return 'stale' as const;
          }
          // A human may have advanced the transcript since the earlier UI
          // fingerprint. The empty editor is not evidence of the old turn.
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) return 'stale' as const;
          }
          // The exact-turn read can await while a human types into the same
          // editor. Recheck the pinned control immediately before fill.
          if (await readExactEditorValue(editor, fresh.editors[0]!) !== '' ||
              (await captureUi(page)).fingerprint !== fresh.fingerprint) {
            return 'stale' as const;
          }
          requireExactMutationIdentity();
          await editor.fill(request.input!, { timeout: 5_000 });
        } finally { await editor.dispose(); }
        return 'draft_updated' as const;
      }
      if (action.purpose !== 'submit' && action.purpose !== 'continue') return 'stale' as const;
      if (fresh.buttons.length !== 1 || !fresh.buttons[0]!.enabled ||
        fresh.draftSha256 !== request.expectedContentSha256 ||
        (action.purpose === 'continue' && fresh.editors[0]!.value !== '계속')) {
        return 'stale' as const;
      }
      if (!(await runtime.authorizeAction(request, action.purpose))) return 'stale' as const;
      if (request.context.requiredModel) {
        // The model selected at inspection may have changed before Submit.
        // Re-read exact current configuration immediately inside the same
        // owned-page mutation, rather than treating an earlier decision as proof.
        const currentModel = await inspectSemanticChatGptModelMenu(page);
        const selected = currentModel?.status === 'open'
          ? currentModel.options.filter(option => option.selected && option.enabled) : [];
        if (!semanticConfigurationMatches(runtime.providerKey, request.context.requiredModel, {
          verifiedModel: selected.length === 1 ? selected[0]!.value : null,
          // A closed, uniquely linked trigger is the only durable proof
          // of an applied Pro effort level immediately before Submit.
          verifiedReasoningLevel: currentModel?.status === 'closed'
            ? currentModel.verifiedReasoningLevel : null,
        })) {
          return 'stale' as const;
        }
      }
      const isRoot = request.context.providerConversationId === null;
      const watch = !isRoot ? watchExactDispatch(page, request.context.providerConversationId!,
        request.expectedContentSha256!, evidence => {
          if (!runtime.options.onDispatchObserved) return;
          try {
            runtime.options.onDispatchObserved({
              context: request.context, attemptId: request.authorizedAttemptId!, evidence,
            });
          } catch {
            capture.sinkFailed = true;
          }
        }) : null;
      const rootWatch = isRoot ? watchExactRootDispatch(
        page, request.expectedContentSha256!, evidence => {
          if (!runtime.options.onRootDispatchObserved) {
            capture.sinkFailed = true;
            return;
          }
          try {
            runtime.options.onRootDispatchObserved({
              context: request.context, attemptId: request.authorizedAttemptId!, evidence,
            });
          } catch {
            capture.sinkFailed = true;
          }
        }) : null;
      try {
        const editor = await exactHandle(page, EDITORS, fresh.editors[0]!);
        let button: ElementHandle<HTMLElement> | null = null;
        try {
          button = await exactHandle(page, BUTTONS, fresh.buttons[0]!);
          const currentDraft = await readExactEditorValue(editor, fresh.editors[0]!);
          if (currentDraft === null ||
            sha(currentDraft.replaceAll('\r\n', '\n')) !== request.expectedContentSha256) {
            return 'stale' as const;
          }
          // The journal can authorize a continuation just before a human
          // adds another user turn. The draft hash alone is not turn identity.
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) return 'stale' as const;
          }
          // The boundary read can await while the exact editor or Send control
          // changes. Never click a committed hash from an earlier UI state.
          const finalDraft = await readExactEditorValue(editor, fresh.editors[0]!);
          if (finalDraft === null ||
            sha(finalDraft.replaceAll('\r\n', '\n')) !== request.expectedContentSha256 ||
            !(await exactControlReady(button, fresh.buttons[0]!)) ||
            (await captureUi(page)).fingerprint !== fresh.fingerprint) {
            return 'stale' as const;
          }
          const hiddenClick = await clickExactChatGptSend(
            page, button, fresh.buttons[0]!, requireExactMutationIdentity);
          // Hidden root composition may schedule its network POST after the
          // CDP input is acknowledged. The watcher, not click success, is the
          // only source of durable root dispatch evidence.
          const settleMs = hiddenClick ? 1_800 : 350;
          capture.attempts = watch ? await watch.collect(settleMs) : [];
          capture.rootPosts = rootWatch ? await rootWatch.collect(settleMs) : [];
        } finally {
          await editor.dispose();
          await button?.dispose();
        }
      } finally {
        capture.attempts = watch?.snapshot() ?? [];
        capture.rootPosts = rootWatch?.snapshot() ?? [];
        watch?.stop();
        rootWatch?.stop();
      }
      return isRoot ? 'root_send' as const : 'send' as const;
}
