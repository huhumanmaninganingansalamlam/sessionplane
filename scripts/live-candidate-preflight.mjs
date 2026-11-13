#!/usr/bin/env node
/**
 * Read-only inspection of the exact installed SessionPlane Core and its
 * Chromium-owned ChatGPT pages. This probe never creates a tab, submits,
 * navigates, focuses, reads a transcript, starts a Core or migrates a DB.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrations } from '../src/storage/migrations/index.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_RPC = new Set(['system.health', 'browser.pages']);

async function rpc(socketPath, method, timeoutMs = 5000) {
  if (!ALLOWED_RPC.has(method)) throw new Error('Mutation not allowed by read-only preflight');
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let done = false;
    const finish = (operation) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Core health read timed out'))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) + '\n');
    });
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > 2 * 1024 * 1024) {
        finish(() => reject(new Error('Core health response exceeds read-only limit')));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      finish(() => {
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (response.error) reject(new Error('Read-only method unavailable: ' + method));
          else resolve(response.result);
        } catch (error) { reject(error); }
      });
    });
    socket.on('error', (error) => finish(() => reject(error)));
  });
}

function chatgptKind(target) {
  if (target?.type !== 'page' || typeof target.url !== 'string') return null;
  try {
    const parsed = new URL(target.url);
    if (!['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)) return null;
    if (parsed.pathname === '/') return 'root';
    if (parsed.pathname.startsWith('/c/')) return 'conversation';
  } catch { /* Unknown URL is never a ChatGPT page. */ }
  return null;
}

function readOnlyStructure() {
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="composer-input"],[contenteditable="true"][role="textbox"]',
  );
  const selectors = [...document.querySelectorAll(
    '[data-testid*="model"],[aria-label*="model"],[aria-label*="모델"]',
  )];
  const modelLabels = selectors.map((element) =>
    (element.getAttribute('aria-label') || '') + ' ' + (element.innerText || '').slice(0, 90));
  return {
    readyState: document.readyState,
    composerPresent: composer !== null,
    composerEditable: composer !== null && composer.getAttribute('contenteditable') !== 'false',
    modelControlPresent: selectors.length > 0,
    modelProVisible: modelLabels.some((value) => /\bPro\b/i.test(value)),
    signInActionVisible: document.querySelector('a[href*="/auth/login"]') !== null,
  };
}

async function readStructure(target, timeoutMs = 6000) {
  const ws = new URL(target.webSocketDebuggerUrl);
  if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) ||
      !ws.pathname.startsWith('/devtools/page/')) {
    throw new Error('Refusing non-local or non-page CDP target');
  }
  return await new Promise((resolve, reject) => {
    const connection = new WebSocket(ws.href);
    let done = false;
    const finish = (run) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.close(); // Detach this read-only socket; never close browser or tab.
      run();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Read-only DOM read timed out'))), timeoutMs);
    connection.addEventListener('open', () => {
      connection.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: {
          expression: '(' + readOnlyStructure.toString() + ')()',
          returnByValue: true, awaitPromise: false, generatePreview: false,
        },
      }));
    });
    connection.addEventListener('message', (event) => {
      let response;
      try { response = JSON.parse(event.data); } catch { return; }
      if (response.id !== 1) return;
      finish(() => {
        if (response.error || response.result?.exceptionDetails ||
            !response.result?.result?.value) {
          reject(new Error('Structure read unavailable'));
        } else {
          resolve(response.result.result.value);
        }
      });
    });
    connection.addEventListener('error', () =>
      finish(() => reject(new Error('Read-only CDP connection unavailable'))));
  });
}

export function evaluateInstalledCandidate({ health, pages, targets, observations, candidate }) {
  const schema = migrations.at(-1)?.version ?? null;
  const blockers = [];
  // An installed Core's commit label alone is not sufficient provenance:
  // a stale/malformed build identity could carry that label with different
  // compiled content. The exact 40-hex source tree is a separate required
  // match, especially before authorizing a reviewed release candidate.
  const sourceCommitKnown = /^[0-9a-f]{40}$/.test(candidate?.sourceCommit ?? '');
  const sourceTreeKnown = /^[0-9a-f]{40}$/.test(candidate?.sourceTree ?? '');
  const sourceTreeMatchesCandidate = sourceTreeKnown &&
    candidate.sourceTree === health?.sourceTree;
  const sourceMatchesCandidate = sourceCommitKnown && sourceTreeMatchesCandidate &&
    health?.sourceCommit === candidate.sourceCommit &&
    health?.sourceState === 'clean' && candidate.sourceState === 'clean';
  const browserOwnership = health?.browser?.ownership;
  if (health?.browser?.state !== 'ready' ||
      !['spawned', 'adopted'].includes(browserOwnership)) {
    blockers.push('core_browser_not_owned_and_ready');
  }
  if (health?.database?.schemaVersion !== schema) {
    blockers.push('installed_core_schema_differs_from_candidate');
  }
  if (health?.version !== candidate?.version) {
    blockers.push('installed_core_version_differs_from_candidate');
  }
  if (!sourceMatchesCandidate) {
    blockers.push('installed_core_source_not_verified_as_candidate');
  }
  const ready = observations.filter(item =>
    item.kind === 'conversation' && item.readyState === 'complete' &&
    item.composerPresent && item.composerEditable);
  const pro = ready.filter(item => item.modelProVisible);
  if (ready.length === 0) blockers.push('no_usable_authenticated_chatgpt_composer_observed');
  return {
    contract: 'sessionplane-live-readonly-preflight-v1',
    mode: 'read_only',
    installed: {
      version: health?.version ?? null,
      schemaVersion: health?.database?.schemaVersion ?? null,
      sourceMatchesCandidate,
      sourceTreeMatchesCandidate,
      browserReady: health?.browser?.state === 'ready',
      browserOwner: health?.browser?.ownership ?? null,
      trackedPageCount: Array.isArray(pages) ? pages.length : 0,
    },
    candidate: {
      version: candidate?.version ?? null,
      schemaVersion: schema,
      sourceCommitKnown,
      sourceTreeKnown,
      clean: candidate?.sourceState === 'clean',
    },
    chrome: {
      totalPageTargets: targets.filter(item => item.type === 'page').length,
      chatgptConversationPages: targets.filter(item => chatgptKind(item) === 'conversation').length,
      chatgptRootPages: targets.filter(item => chatgptKind(item) === 'root').length,
      sampledConversationComposersReady: ready.length,
      sampledConversationProVisible: pro.length,
      sampledRootReady: observations.some(item =>
        item.kind === 'root' && item.readyState === 'complete' && item.composerPresent),
    },
    outcome: {
      candidateMatchesLiveCore: blockers.length === 0,
      mutationPerformed: false,
      liveTaskSubmitted: false,
      blockers,
    },
  };
}

export async function inspectLiveCandidate(options = {}) {
  const socketPath = options.socketPath ?? path.join(
    homedir(), '.local', 'state', 'sessionplane', 'sessionplane.sock');
  const candidate = options.candidate ?? JSON.parse(
    readFileSync(path.join(repo, 'dist', 'build-identity.json'), 'utf8'));
  const readRpc = options.rpc ?? ((method) => rpc(socketPath, method));
  const health = await readRpc('system.health');
  const inventory = await readRpc('browser.pages');
  if (!Array.isArray(inventory.pages)) throw new Error('Core page inventory unavailable');
  const port = health?.browser?.debuggingPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Owned browser debug port unavailable');
  }
  const list = options.listTargets ?? (async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('Owned browser target list unavailable');
    return await response.json();
  });
  const targets = await list();
  if (!Array.isArray(targets)) throw new Error('Unexpected browser target list');
  const sample = [
    ...targets.filter(item => chatgptKind(item) === 'root').slice(0, 1),
    ...targets.filter(item => chatgptKind(item) === 'conversation').slice(0, 3),
  ];
  const observations = [];
  for (const target of sample) {
    try {
      const value = await (options.observe ?? readStructure)(target);
      observations.push({ kind: chatgptKind(target), ...value });
    } catch {
      observations.push({ kind: chatgptKind(target), available: false });
    }
  }
  return evaluateInstalledCandidate({
    health, pages: inventory.pages, targets, observations, candidate,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length === 2 && args[0] !== '--socket') ||
      args.length === 1) {
    process.stderr.write('Usage: node scripts/live-candidate-preflight.mjs [--socket PATH]\n');
    process.exitCode = 2;
  } else {
    inspectLiveCandidate({ ...(args.length ? { socketPath: args[1] } : {}) })
      .then(report => {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        if (!report.outcome.candidateMatchesLiveCore) process.exitCode = 3;
      }).catch(error => {
        process.stderr.write('Read-only preflight unavailable: ' + error.message + '\n');
        process.exitCode = 2;
      });
  }
}
