#!/usr/bin/env node
/**
 * A bounded, resumable L3 ChatGPT Main-rotation acceptance runner.
 *
 * Requires a live Core running THIS exact candidate and an explicitly named
 * acceptance-only owner/key. No installed package, Core, Chrome, profile or
 * existing project is changed by this script. Only the new acceptance project
 * receives benign synthetic prompt submissions after --allow-live-send.
 *
 * Run phase=start then exit; phase=resume is a separate client process.
 * Replaying a phase never generates new mutation IDs or re-sends an original.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { callRpc } from '../src/cli/client.ts';
import { inspectLiveCandidate } from './live-candidate-preflight.mjs';

function assertAcceptanceIdentity(input) {
  if (!input.authorized) throw new Error('Live acceptance sends require --allow-live-send');
  if (!/^sessionplane-l3-[a-z0-9-]{8,80}$/.test(input.clientId ?? '')) {
    throw new Error('Use a dedicated sessionplane-l3- clientId');
  }
  if (!/^sessionplane-l3-[a-z0-9-]{8,80}$/.test(input.projectKey ?? '')) {
    throw new Error('Use a dedicated sessionplane-l3- projectKey');
  }
  if (!['start', 'resume'].includes(input.phase)) throw new Error('Phase must be start or resume');
  if (!path.isAbsolute(input.receiptDir ?? '')) {
    throw new Error('Acceptance receipt directory must be absolute');
  }
}

function loadPlan(input) {
  const dir = input.receiptDir;
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error('Receipt directory cannot be a symlink');
  }
  const filename = path.join(dir, 'plan.json');
  if (input.phase === 'resume' && !existsSync(filename)) {
    throw new Error('Resume requires the previously persisted acceptance plan; no new Task was created');
  }
  if (existsSync(filename)) {
    const plan = JSON.parse(readFileSync(filename, 'utf8'));
    if (plan.version !== 1 || plan.clientId !== input.clientId ||
        plan.projectKey !== input.projectKey || !Array.isArray(plan.tasks) ||
        plan.tasks.length !== 3 || !plan.tasks.every(t =>
          typeof t.requestId === 'string' && typeof t.expectedToken === 'string')) {
      throw new Error('Existing acceptance plan does not match this owner/key');
    }
    return plan;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(12).toString('hex');
  const plan = {
    version: 1, clientId: input.clientId, projectKey: input.projectKey,
    openRequestId: 'l3-open-' + nonce,
    tasks: Array.from({ length: 3 }, (_, index) => {
      const token = 'SP_L3_' + nonce + '_TURN_' + (index + 1);
      return {
        requestId: 'l3-task-' + nonce + '-' + (index + 1),
        expectedToken: token,
        prompt: 'Controlled SessionPlane integration check. Reply with exactly ' +
          token + ' and nothing else.',
      };
    }),
  };
  writeFileSync(filename, JSON.stringify(plan, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  return plan;
}

function readState(dir) {
  const file = path.join(dir, 'state.json');
  if (!existsSync(file)) {
    return { version: 1, projectId: null, conversationId: null,
      tasks: Array.from({ length: 3 }, () => ({
        taskId: null, conversationRevision: null, resultSha256: null,
      })) };
  }
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length !== 3) {
    throw new Error('Invalid durable acceptance state');
  }
  return state;
}

function saveState(dir, state) {
  const file = path.join(dir, 'state.json');
  const tmp = file + '.next-' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', {
    mode: 0o600, flag: 'wx',
  });
  renameSync(tmp, file);
}

/**
 * Only the exact, current Pro model decision can be automated by the explicit
 * acceptance runner. Permissions, provider questions, retries and every
 * human-only decision remain external barriers. No DOM selectors are used.
 */
function exactProModelAction(decision) {
  if (!decision || decision.kind !== 'model_choice' || decision.humanOnly ||
      decision.requestedModel !== 'Pro' || !Array.isArray(decision.options) ||
      decision.options.length !== 1 || !decision.decisionId) return null;
  const action = decision.options[0];
  if (!action || !action.actionRef || action.risk !== 'configuration_only' ||
      !['open_model_chooser', 'choose_model'].includes(action.purpose)) {
    return null;
  }
  if (!Number.isFinite(Date.parse(action.expiresAt)) || Date.now() > Date.parse(action.expiresAt)) {
    return null;
  }
  let selected;
  if (action.purpose === 'open_model_chooser') {
    if (action.inputSchema?.kind !== 'none') return null;
  } else {
    if (action.inputSchema?.kind !== 'option' ||
        action.inputSchema.options?.filter(option =>
          option.value === 'Pro' && option.enabled).length !== 1) return null;
    selected = 'Pro';
  }
  return {
    decisionId: decision.decisionId, actionRef: action.actionRef,
    requestId: 'l3-pro-' + decision.decisionId,
    ...(selected ? { input: selected } : {}),
  };
}

async function acceptOneTask({ plan, state, index, call, receiptDir, limitMs, waitMs }) {
  const row = state.tasks[index];
  const input = plan.tasks[index];
  if (row.resultSha256 !== null) {
    // A mismatching answer was already recorded for investigation. Never
    // reclassify it as an accepted result or advance to another Task.
    if (row.exactAnswerMatched !== true ||
        row.providerConversationBindingVerified !== true) {
      throw new Error('A previous exact result failed acceptance; refuse continuation');
    }
    return { kind: 'already_completed' };
  }

  if (row.taskId === null) {
    const revision = index === 0 ? state.firstRevision :
      state.tasks[index - 1].conversationRevision;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Previous Task has no canonical revision; do not advance');
    }
    // A lost RPC response is safe to recover through the exact same requestId.
    // No "new attempt" mutation or different prompt is synthesized on resume.
    const started = await call('task.start', {
      clientId: plan.clientId,
      projectId: state.projectId,
      expectedConversationRevision: revision,
      requestId: input.requestId,
      prompt: input.prompt,
    });
    if (!started?.taskId || started.projectId !== state.projectId) {
      throw new Error('Core returned no exact new Task identity');
    }
    row.taskId = started.taskId;
    row.conversationRevision = started.conversationRevision;
    saveState(receiptDir, state);
  }

  let summary = await call('task.get', {
    clientId: plan.clientId, taskId: row.taskId,
  });
  const expiresAt = Date.now() + limitMs;
  let modelDecisions = 0;
  while (Date.now() < expiresAt) {
    if (summary.state === 'agent_input_required') {
      const action = exactProModelAction(summary.decision);
      if (!action || modelDecisions >= 4) break;
      // Store the exact request identity before the external UI effect.
      if (row.modelDecision?.decisionId === action.decisionId &&
          (row.modelDecision.actionRef !== action.actionRef ||
            row.modelDecision.requestId !== action.requestId ||
            row.modelDecision.input !== (action.input ?? null))) {
        throw new Error('A previously issued model choice changed without a new decisionId');
      }
      row.modelDecision = { ...action, input: action.input ?? null };
      saveState(receiptDir, state);
      modelDecisions++;
      const decisionResult = await call('task.decide', {
        clientId: plan.clientId, taskId: row.taskId, ...action,
      });
      row.modelDecisionResult = decisionResult?.kind ?? 'unknown';
      saveState(receiptDir, state);
      if (!['performed', 'refresh_required'].includes(decisionResult?.kind)) break;
      const previous = summary;
      summary = await call('task.get', {
        clientId: plan.clientId, taskId: row.taskId,
      });
      if (summary.revision === previous.revision &&
          summary.decision?.decisionId === previous.decision?.decisionId) break;
      continue;
    }
    if (summary.state !== 'working') break;
    summary = await call('task.wait', {
      clientId: plan.clientId, taskId: row.taskId,
      afterRevision: summary.revision,
      waitMs: Math.min(waitMs, Math.max(0, expiresAt - Date.now())),
    });
  }
  row.lastState = summary.state;
  row.lastRevision = summary.revision;
  if (summary.decision) {
    row.decision = {
      decisionId: summary.decision.decisionId,
      kind: summary.decision.kind,
      options: summary.decision.options?.map(o => ({
        actionRef: o.actionRef, purpose: o.purpose, risk: o.risk,
      })) ?? [],
    };
  }
  saveState(receiptDir, state);

  if (summary.state !== 'completed') {
    return { kind: 'pending', taskIndex: index + 1, state: summary.state };
  }
  const result = await call('task.get', {
    clientId: plan.clientId, taskId: row.taskId, view: 'result',
  });
  const evidence = await call('task.get', {
    clientId: plan.clientId, taskId: row.taskId, view: 'evidence',
  });
  if (!result.result || typeof result.result.answerText !== 'string' ||
      result.result.completesTask !== true ||
      result.result.answerBytes !== Buffer.byteLength(result.result.answerText, 'utf8') ||
      result.result.answerSha256 !==
        createHash('sha256').update(result.result.answerText).digest('hex')) {
    throw new Error('Exact canonical FINAL bytes/hash unverified');
  }
  const initial = evidence.evidence?.attempts?.filter(a => a.kind === 'initial') ?? [];
  const binding = evidence.evidence?.conversation?.providerConversationId;
  const root = evidence.evidence?.rootPost ?? null;
  if (!evidence.submission?.acknowledged || initial.length !== 1 ||
      initial[0].state !== 'acknowledged' || !binding) {
    throw new Error('One initial POST and exact canonical ACK have not been proven');
  }
  if (index === 0) {
    if (!root || root.ambiguous || root.observationCount !== 1 ||
        root.canonicalConversationId !== binding) {
      throw new Error('Original new-root POST has no unique canonical ACK');
    }
    state.conversationId = binding;
  } else if (binding !== state.conversationId) {
    throw new Error('A follow-up Task escaped its original Main conversation');
  }
  const tokenMatched = result.result.answerText.trim() === input.expectedToken;
  row.resultSha256 = result.result.answerSha256;
  row.resultBytes = result.result.answerBytes;
  row.exactAnswerMatched = tokenMatched;
  row.providerConversationBindingVerified = true;
  row.conversationRevision = summary.conversationRevision;
  delete row.decision;
  saveState(receiptDir, state);
  if (!tokenMatched) throw new Error('Provider answer does not match the controlled test token');
  return { kind: 'completed', taskIndex: index + 1 };
}

export async function runLiveTaskAcceptance(input) {
  assertAcceptanceIdentity(input);
  const compatibility = await (input.preflight ?? inspectLiveCandidate)({
    socketPath: input.socketPath,
  });
  if (!compatibility.outcome?.candidateMatchesLiveCore) {
    // Do not create a project, send a prompt, or modify existing browser state.
    const blockers = compatibility.outcome?.blockers ?? ['preflight_unavailable'];
    return {
      phase: input.phase, status: 'blocked_before_mutation',
      sourceSchemaMatches: !blockers.includes('installed_core_schema_differs_from_candidate'),
      verifiedInstalledSourceMatches: !blockers.includes('installed_core_source_not_verified_as_candidate'),
      blockers,
      mutationPerformed: false,
    };
  }
  const plan = loadPlan(input);
  const state = readState(input.receiptDir);
  if (input.phase === 'resume' && state.projectId === null) {
    throw new Error('Resume requires the previously admitted acceptance project');
  }
  const call = input.call ?? (async (method, params) => await callRpc({
    socketPath: input.socketPath, method, params,
    timeoutMs: Math.max(10_000, input.waitMs + 5_000),
    maxLineBytes: 8 * 1024 * 1024,
  }));
  if (state.projectId === null) {
    const project = await call('project.open', {
      clientId: plan.clientId, projectKey: plan.projectKey,
      displayName: 'SessionPlane isolated L3 acceptance',
      requestId: plan.openRequestId, provider: 'chatgpt',
      surfaceIntent: 'chat', modelIntent: 'Pro',
    });
    if (project.provider !== 'chatgpt' || project.modelIntent !== 'Pro' ||
        project.mainConversationSlotId !== 'main' ||
        !Number.isSafeInteger(project.conversationRevision)) {
      throw new Error('Core returned an unverified Main/Pro project');
    }
    state.projectId = project.projectId;
    state.firstRevision = project.conversationRevision;
    saveState(input.receiptDir, state);
  }
  const maxWaitMs = input.maxWaitMs ?? 120_000;
  const waitMs = input.waitMs ?? 15_000;
  if (input.phase === 'start') {
    const result = await acceptOneTask({
      plan, state, index: 0, call, receiptDir: input.receiptDir,
      limitMs: 0, waitMs,
    });
    return {
      phase: 'start', status: 'owner_client_exited_after_initial',
      taskId: state.tasks[0].taskId, result: result.kind,
      mutationPerformed: true,
    };
  }
  for (let index = 0; index < 3; index++) {
    const result = await acceptOneTask({
      plan, state, index, call, receiptDir: input.receiptDir,
      limitMs: maxWaitMs, waitMs,
    });
    if (result.kind === 'pending') {
      return {
        phase: 'resume', status: 'read_only_reconnect_pending',
        taskIndex: result.taskIndex, taskState: result.state,
        mutationPerformed: state.tasks.some(task => task.taskId !== null),
      };
    }
  }
  return {
    phase: 'resume', status: 'three_turns_canonical_final_verified',
    projectId: state.projectId,
    sameMainConversation: state.tasks.every(task => task.providerConversationBindingVerified),
    exactAnswerHashes: state.tasks.map(task => task.resultSha256),
    mutationPerformed: true,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--allow-live-send') { args.authorized = true; continue; }
    if (!['--phase', '--socket', '--client-id', '--project-key', '--receipt-dir',
      '--max-wait-ms'].includes(key)) throw new Error('Unknown option: ' + key);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(key + ' requires a value');
    const name = key.replace(/^--/, '').replace(/-([a-z])/g, (_match, letter) =>
      letter.toUpperCase());
    args[name] = argv[++i];
  }
  args.socketPath ??= path.join(homedir(), '.local', 'state', 'sessionplane', 'sessionplane.sock');
  if (args.maxWaitMs) {
    args.maxWaitMs = Number(args.maxWaitMs);
    if (!Number.isSafeInteger(args.maxWaitMs) || args.maxWaitMs < 0 ||
        args.maxWaitMs > 900_000) throw new Error('Invalid bounded max wait');
  }
  return args;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveTaskAcceptance(parseArgs(process.argv.slice(2))).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'blocked_before_mutation') process.exitCode = 3;
    else if (result.status === 'read_only_reconnect_pending') process.exitCode = 4;
  }).catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  });
}
