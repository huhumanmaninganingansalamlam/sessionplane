import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import { isChatGptUrl, parseChatGptConversationId } from '../browser/page-binding.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import { inspectZip } from '../code/zip-inspector.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import {
  discoverChatGptCodeArtifacts,
  downloadChatGptCodeArtifact,
} from '../providers/chatgpt/code-artifacts.ts';
import type {
  ProviderAdapterRegistry,
  ProviderCodeArtifactCandidate,
} from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { TeamDirectory } from './team-directory.ts';
import type { ArtifactService } from './artifact-service.ts';
import type { SessionSendInput, SubmissionService } from './submission-service.ts';

export const CODE_ARTIFACT_PATH = '/mnt/data/result.zip';

export interface CodeGenerateInput extends SessionSendInput {
  readonly outputPath?: string;
  readonly outputDir?: string;
  readonly multiZip?: boolean;
  readonly overwrite?: boolean;
}

export interface CodeExtractInput {
  readonly clientId: string;
  readonly sessionId?: string;
  readonly teamId?: string;
  readonly roleKey?: string;
  readonly generation?: number;
  readonly conversationId?: string;
  readonly outputPath?: string;
  readonly outputDir?: string;
  readonly multiZip?: boolean;
  readonly requirePlan?: boolean;
  readonly overwrite?: boolean;
}

export function buildCodeModePrompt(requirements: string, multiZip = false): string {
  const spec = requirements.trim();
  if (spec.length === 0) {
    throw new SessionPlaneDomainError('input.invalid', 'Code requirements must not be empty');
  }
  const common = [
    '- 가능한 경우 첫 액션으로 계획 도구를 사용한다. 사용할 수 없다면 사용했다고 가장하지 않는다.',
    '- visible todo/checklist는 최대 8개의 top-level 항목만 사용하고, 추가 세부 단계는 PLAN.md 또는 00_plan.md에 텍스트로 기록한다.',
    '- 각 코드 zip 루트에는 비어 있지 않은 PLAN.md 또는 00_plan.md를 포함한다.',
    '- plan 파일에는 Linux sandbox 전제, 구현 계획, 최대 8개 top-level 체크리스트, 실행한 검증 명령, 생략한 검증과 이유, 패키징 기준을 기록한다.',
    '- 완료한 plan 체크리스트는 최종 패키징 전에 [x]로 갱신한다.',
    '- 모든 소스는 먼저 /mnt/data/workdir 아래에 작성한다.',
    '- 의존성은 package.json, requirements.txt, pyproject.toml 같은 manifest로 표현한다.',
    '- 가능한 실제 검증 명령을 실행하고 결과를 plan 파일에 남긴다.',
    '- zip에는 사람이 작성한 소스, 설정, 테스트, fixture, 문서, 경량 asset만 포함한다.',
    '- node_modules, .venv, venv, dist, build, .next, coverage, .turbo, __pycache__, .pytest_cache, .git 및 cache 산출물은 포함하지 않는다.',
    '- 중간 확인 질문 없이 현재 응답에서 작성, 검증, 패키징까지 완료한다.',
  ];
  if (multiZip) {
    return [
      '[CODE MODE (MULTI-ZIP) — 아래 계약을 정확히 지켜라.]',
      '',
      '목표:',
      spec,
      '',
      '계약:',
      ...common,
      '- 패키징 전에 /mnt/data/*.zip을 삭제한다.',
      '- 논리적으로 분리된 결과마다 의미 있는 이름의 zip을 /mnt/data 바로 아래에 만든다.',
      '- find /mnt/data -maxdepth 1 -name "*.zip" -print로 의도한 zip만 존재하는지 검증한다.',
      '- 각 zip 루트에 PLAN.md 또는 00_plan.md가 없으면 다시 패키징한다.',
      '- 최종 응답은 각 zip마다 DOWNLOAD 링크와 MACHINE 절대 경로 두 줄만 출력한다.',
      '- 위 artifact 줄 외 설명, 코드블록, bullet, JSON, 추가 문장을 출력하지 않는다.',
    ].join('\n');
  }
  return [
    '[CODE MODE — 아래 계약을 정확히 지켜라.]',
    '',
    '목표:',
    spec,
    '',
    '계약:',
    ...common,
    '- 패키징 전에 /mnt/data/*.zip을 삭제한다.',
    `- 단 하나의 ${CODE_ARTIFACT_PATH}을 생성한다.`,
    `- find /mnt/data -maxdepth 1 -name "*.zip" -print 결과가 ${CODE_ARTIFACT_PATH} 하나인지 검증한다.`,
    '- result.zip 루트에 PLAN.md 또는 00_plan.md가 없으면 다시 패키징한다.',
    '- 최종 응답은 정확히 다음 두 줄만 출력한다:',
    `DOWNLOAD: [result.zip](sandbox:${CODE_ARTIFACT_PATH})`,
    `MACHINE: ${CODE_ARTIFACT_PATH}`,
    '- 위 두 줄 외 설명, 코드블록, bullet, JSON, 추가 문장을 출력하지 않는다.',
  ].join('\n');
}

export function checkCodeContractCompliance(answerText: string, multiZip = false): {
  readonly compliant: boolean;
  readonly mentionsPath: boolean;
} {
  const text = answerText.trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mentionedPaths = text.match(/\/mnt\/data\/[A-Za-z0-9._-]+\.zip/g) ?? [];
  if (multiZip) {
    const seen = new Set<string>();
    let compliant = lines.length >= 2 && lines.length % 2 === 0;
    for (let index = 0; compliant && index < lines.length; index += 2) {
      const downloadLine = lines[index] ?? '';
      const machineLine = lines[index + 1] ?? '';
      const machine = /^MACHINE:\s+(\/mnt\/data\/([A-Za-z0-9._-]+\.zip))$/.exec(
        machineLine,
      );
      if (machine === null || seen.has(machine[1] ?? '')) {
        compliant = false;
        break;
      }
      const sandboxPath = machine[1] ?? '';
      const basename = machine[2] ?? '';
      const rawDownload = `DOWNLOAD: [${basename}](sandbox:${sandboxPath})`;
      const renderedDownload = `DOWNLOAD: ${basename}`;
      if (downloadLine !== rawDownload && downloadLine !== renderedDownload) {
        compliant = false;
        break;
      }
      seen.add(sandboxPath);
    }
    return { compliant, mentionsPath: mentionedPaths.length > 0 };
  }
  const download = `DOWNLOAD: [result.zip](sandbox:${CODE_ARTIFACT_PATH})`;
  const renderedDownload = 'DOWNLOAD: result.zip';
  const machine = `MACHINE: ${CODE_ARTIFACT_PATH}`;
  return {
    compliant:
      text === CODE_ARTIFACT_PATH ||
      (lines.length === 2 &&
        (lines[0] === download || lines[0] === renderedDownload) &&
        lines[1] === machine),
    mentionsPath: text.includes(CODE_ARTIFACT_PATH),
  };
}

export class ChatGptWorkflowService {
  readonly #browserOwner: BrowserOwner | null;
  readonly #pageRegistry: PageRegistry;
  readonly #directory: TeamDirectory;
  readonly #submissions: SubmissionService;
  readonly #scheduler: ActorScheduler;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #artifacts: ArtifactService;
  readonly #chatgptUrl: string;
  readonly #maxArtifactFileBytes: number;

  constructor(options: {
    readonly browserOwner: BrowserOwner | null;
    readonly pageRegistry: PageRegistry;
    readonly directory: TeamDirectory;
    readonly submissions: SubmissionService;
    readonly scheduler: ActorScheduler;
    readonly adapters: ProviderAdapterRegistry;
    readonly artifacts: ArtifactService;
    readonly chatgptUrl: string;
    readonly maxArtifactFileBytes: number;
  }) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#directory = options.directory;
    this.#submissions = options.submissions;
    this.#scheduler = options.scheduler;
    this.#adapters = options.adapters;
    this.#artifacts = options.artifacts;
    this.#chatgptUrl = options.chatgptUrl;
    this.#maxArtifactFileBytes = options.maxArtifactFileBytes;
  }

  async generateCode(input: CodeGenerateInput): Promise<Readonly<Record<string, unknown>>> {
    this.#requireChatGptTarget(input, 'ChatGPT code mode', 'code-mode.vendor-unsupported');
    const submitted = await this.#submissions.send({
      ...input,
      prompt: buildCodeModePrompt(input.prompt, input.multiZip === true),
      surface: input.surface ?? 'chat',
    });
    const terminal = await this.#waitForTerminal(
      submitted.sessionId,
      submitted.generation,
      input.sessionDeadlineSec * 1_000,
    );
    if (!terminal.terminal) {
      throw new SessionPlaneDomainError(
        'provider.poll-timeout',
        `Code generation did not complete within ${input.sessionDeadlineSec} seconds`,
        { sessionId: terminal.sessionId, generation: terminal.generation },
      );
    }
    if (terminal.sessionState !== 'complete') {
      throw new SessionPlaneDomainError(
        terminal.errorCode ?? 'provider.code-generation-failed',
        `Code generation ended in ${terminal.sessionState}`,
        { snapshot: terminal },
      );
    }
    const compliance = checkCodeContractCompliance(
      terminal.answerText ?? '',
      input.multiZip === true,
    );
    const warnings: string[] = [];
    if (!compliance.compliant) warnings.push('code-mode:contract-drift');
    if (!compliance.mentionsPath && input.multiZip !== true) {
      warnings.push('code-mode:answer-missing-artifact-path');
    }
    const extracted = await this.extractCode({
      clientId: input.clientId,
      sessionId: terminal.sessionId,
      generation: terminal.generation,
      ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
      ...(input.outputDir === undefined ? {} : { outputDir: input.outputDir }),
      multiZip: input.multiZip === true,
      requirePlan: true,
      overwrite: input.overwrite === true,
    });
    return {
      requestOk: true,
      status: 'complete',
      session: terminal,
      compliance,
      warnings,
      ...extracted,
    };
  }

  async extractCode(input: CodeExtractInput): Promise<Readonly<Record<string, unknown>>> {
    const selected = this.#resolveOptionalSession(input);
    if (selected !== null && selected.provider !== 'chatgpt') {
      throw new SessionPlaneDomainError(
        'code-mode.vendor-unsupported',
        'Code artifacts are available only for ChatGPT sessions',
      );
    }
    const explicitConversationId =
      input.conversationId === undefined
        ? null
        : normalizeConversationId(input.conversationId);
    if (input.conversationId !== undefined && explicitConversationId === null) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Invalid ChatGPT conversation identity: ${input.conversationId}`,
      );
    }
    let conversationId: string | null;
    if (selected !== null) {
      if (selected.conversationId === null) {
        throw new SessionPlaneDomainError(
          'code-extract.conversation-id-missing',
          `Session ${selected.sessionId} has no exact ChatGPT conversation identity`,
        );
      }
      if (
        explicitConversationId !== null &&
        explicitConversationId !== selected.conversationId
      ) {
        throw new SessionPlaneDomainError(
          'session.conversation-mismatch',
          `Requested conversation ${explicitConversationId} does not match session ${selected.conversationId}`,
        );
      }
      conversationId = selected.conversationId;
    } else {
      conversationId = explicitConversationId ?? this.#inferSingleOpenConversationId();
    }
    if (conversationId === null) {
      throw new SessionPlaneDomainError(
        'code-extract.conversation-id-missing',
        'Code extraction requires a ChatGPT conversation ID or an exact session',
      );
    }

    const acquired = selected === null
      ? await this.#acquireConversationPage(conversationId)
      : null;
    try {
      const candidates = selected === null
        ? await discoverChatGptCodeArtifacts(acquired!.page, conversationId)
        : await this.#discoverForSession(selected, conversationId);
      if (candidates.length === 0) {
        throw new SessionPlaneDomainError(
          'code-artifact.missing',
          `No /mnt/data/*.zip artifacts were found in conversation ${conversationId}`,
        );
      }
      const chosen = input.multiZip === true ? candidates : [candidates.at(-1)!];
      const artifacts: Readonly<Record<string, unknown>>[] = [];
      for (const [index, candidate] of chosen.entries()) {
        const downloaded = selected === null
          ? await downloadChatGptCodeArtifact(
              acquired!.page,
              conversationId,
              candidate,
              this.#maxArtifactFileBytes,
            )
          : await this.#downloadForSession(selected, conversationId, candidate);
        const inspection = inspectZip(downloaded.bytes, {
          requireRootPlan: input.requirePlan === true,
          maxTotalUncompressedBytes: this.#maxArtifactFileBytes * 4,
        });
        const outputPath = outputPathForCandidate(input, candidate, index, chosen.length);
        const stored = selected === null
          ? storeDirect(outputPath, downloaded.bytes, input.overwrite === true)
          : this.#storeSessionArtifact(
              selected,
              candidate,
              downloaded.bytes,
              outputPath,
              input.overwrite === true,
            );
        artifacts.push(Object.freeze({
          providerArtifactId: candidate.providerArtifactId,
          name: candidate.name,
          sandboxPath: candidate.sandboxPath,
          mintedMessageId: downloaded.mintedMessageId,
          outputPath,
          sizeBytes: downloaded.bytes.byteLength,
          sha256: createHash('sha256').update(downloaded.bytes).digest('hex'),
          files: inspection.files,
          planPath: inspection.planPath,
          ...stored,
        }));
      }
      return {
        requestOk: true,
        status: 'complete',
        conversationId,
        sessionId: selected?.sessionId ?? null,
        generation: selected?.generation ?? null,
        artifacts,
      };
    } finally {
      if (acquired?.temporary === true) {
        await acquired.page.close().catch(() => undefined);
      }
    }
  }

  #resolveOptionalSession(input: CodeExtractInput): SessionSnapshot | null {
    let snapshot: SessionSnapshot | null = null;
    if (input.sessionId !== undefined) {
      snapshot = this.#directory.getSession(input.sessionId);
    } else if (input.teamId !== undefined || input.roleKey !== undefined) {
      if (input.teamId === undefined || input.roleKey === undefined) {
        throw new SessionPlaneDomainError(
          'input.invalid',
          'Code extraction requires both teamId and roleKey',
        );
      }
      snapshot = this.#directory.getCurrentSession(input.teamId, input.roleKey);
    }
    if (
      snapshot !== null &&
      input.generation !== undefined &&
      snapshot.generation !== input.generation
    ) {
      throw new SessionPlaneDomainError(
        'session.generation-superseded',
        `Expected generation ${input.generation}; current generation is ${snapshot.generation}`,
      );
    }
    return snapshot;
  }

  #requireChatGptTarget(
    input: Pick<SessionSendInput, 'sessionId' | 'teamId' | 'roleKey'>,
    feature: string,
    errorCode: string,
  ): SessionSnapshot {
    let snapshot: SessionSnapshot;
    if (input.sessionId !== undefined) {
      snapshot = this.#directory.getSession(input.sessionId);
    } else {
      if (input.teamId === undefined || input.roleKey === undefined) {
        throw new SessionPlaneDomainError(
          'input.invalid',
          `${feature} requires sessionId or teamId + roleKey`,
        );
      }
      snapshot = this.#directory.getCurrentSession(input.teamId, input.roleKey);
    }
    if (snapshot.provider !== 'chatgpt') {
      throw new SessionPlaneDomainError(
        errorCode,
        `${feature} is unavailable for provider ${snapshot.provider}`,
        { provider: snapshot.provider, sessionId: snapshot.sessionId },
      );
    }
    return snapshot;
  }

  #inferSingleOpenConversationId(): string | null {
    const ids = [
      ...new Set(
        this.#pageRegistry
          .listBindings({ includeClosed: false })
          .filter((binding) => isChatGptUrl(binding.url))
          .map((binding) => binding.conversationId)
          .filter((value): value is string => value !== null),
      ),
    ];
    if (ids.length === 0) return null;
    if (ids.length > 1) {
      throw new SessionPlaneDomainError(
        'session.page-identity-unverified',
        'More than one provider conversation is open; specify --conversation or --session',
      );
    }
    return ids[0] ?? null;
  }

  async #waitForTerminal(
    sessionId: string,
    generation: number,
    timeoutMs: number,
  ): Promise<SessionSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      const snapshot = await this.#scheduler.waitSession(sessionId, {
        waitMs: Math.min(120_000, remaining),
        afterRevision: cursor,
        expectedGeneration: generation,
      });
      cursor = Math.max(cursor, snapshot.latestEventSequence);
      if (snapshot.terminal || remaining === 0 || snapshot.waitExpired && Date.now() >= deadline) {
        return snapshot;
      }
    }
  }

  async #discoverForSession(
    snapshot: SessionSnapshot,
    conversationId: string,
  ): Promise<readonly ProviderCodeArtifactCandidate[]> {
    const adapter = this.#adapters.require(snapshot.provider);
    if (adapter.discoverCodeArtifacts === undefined) {
      throw new SessionPlaneDomainError(
        'provider.artifacts-unavailable',
        `Provider ${snapshot.provider} does not expose code artifact discovery`,
      );
    }
    return await adapter.discoverCodeArtifacts({
      session: snapshot,
      generation: snapshot.generation,
      conversationId,
      maxBytes: this.#maxArtifactFileBytes,
    });
  }

  async #downloadForSession(
    snapshot: SessionSnapshot,
    conversationId: string,
    candidate: ProviderCodeArtifactCandidate,
  ) {
    const adapter = this.#adapters.require(snapshot.provider);
    if (adapter.downloadCodeArtifact === undefined) {
      throw new SessionPlaneDomainError(
        'provider.artifacts-unavailable',
        `Provider ${snapshot.provider} does not expose code artifact download`,
      );
    }
    return await adapter.downloadCodeArtifact(
      {
        session: snapshot,
        generation: snapshot.generation,
        conversationId,
        maxBytes: this.#maxArtifactFileBytes,
      },
      candidate,
    );
  }

  #storeSessionArtifact(
    snapshot: SessionSnapshot,
    candidate: ProviderCodeArtifactCandidate,
    bytes: Uint8Array,
    outputPath: string,
    overwrite: boolean,
  ): Readonly<Record<string, unknown>> {
    const artifact = this.#artifacts.storeBytes(
      { sessionId: snapshot.sessionId, generation: snapshot.generation },
      {
        providerArtifactId: candidate.providerArtifactId,
        name: candidate.name,
        sourceUrl: `sandbox:${candidate.sandboxPath}`,
        mediaType: candidate.mediaType,
      },
      bytes,
    );
    const exported = this.#artifacts.export({
      artifactId: artifact.artifactId,
      outputPath,
      overwrite,
    });
    return { artifactId: artifact.artifactId, durable: true, export: exported };
  }

  async #acquireConversationPage(
    conversationId: string,
  ): Promise<{ readonly page: Page; readonly temporary: boolean }> {
    const matches = this.#pageRegistry
      .findByConversation(conversationId)
      .filter((binding) => isChatGptUrl(binding.url));
    if (matches.length > 1) {
      throw new SessionPlaneDomainError(
        'session.page-identity-unverified',
        `Multiple Pages claim conversation ${conversationId}`,
      );
    }
    const existing = matches[0];
    if (existing !== undefined) {
      if (existing.state === 'conflict' || existing.state === 'identity_lost') {
        throw new SessionPlaneDomainError(
          'session.page-identity-unverified',
          `ChatGPT Page ${existing.pageKey} does not have verifiable conversation ownership`,
        );
      }
      return {
        page: this.#pageRegistry.pageForObservation(existing.pageKey, existing.bindingEpoch),
        temporary: false,
      };
    }
    if (this.#browserOwner === null) {
      throw new SessionPlaneDomainError(
        'browser.unavailable',
        'Browser owner is required for conversation-only code extraction',
      );
    }
    const created = await this.#browserOwner.createPage();
    const origin = new URL(this.#chatgptUrl).origin;
    const target = `${origin}/c/${conversationId}`;
    try {
      await created.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const binding = this.#pageRegistry.refreshPage(created.binding.pageKey);
      if (binding.conversationId !== conversationId) {
        throw new SessionPlaneDomainError(
          'code-extract.navigation-failed',
          `ChatGPT did not open conversation ${conversationId}`,
          { actualUrl: binding.url },
        );
      }
      return { page: created.page, temporary: true };
    } catch (error) {
      await created.page.close().catch(() => undefined);
      throw error;
    }
  }
}

function normalizeConversationId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9-]{8,}$/.test(trimmed)) return trimmed;
  try {
    return parseChatGptConversationId(new URL(trimmed).href);
  } catch {
    return null;
  }
}

function outputPathForCandidate(
  input: CodeExtractInput,
  candidate: ProviderCodeArtifactCandidate,
  index: number,
  count: number,
): string {
  if (count === 1 && input.multiZip !== true) {
    return path.resolve(
      input.outputPath ?? `code-artifact-${candidate.providerArtifactId.slice(-8)}.zip`,
    );
  }
  const directory = path.resolve(input.outputDir ?? 'code-artifacts');
  const base = safeZipName(candidate.name, index);
  return path.join(directory, base);
}

function safeZipName(value: string, index: number): string {
  let name = path.basename(value).replaceAll(/[^A-Za-z0-9._-]/g, '_');
  if (name === '' || name === '.' || name === '..') name = `artifact-${index + 1}.zip`;
  if (!name.toLowerCase().endsWith('.zip')) name = `${name}.zip`;
  return name;
}

function storeDirect(
  outputPath: string,
  bytes: Uint8Array,
  overwrite: boolean,
): Readonly<Record<string, unknown>> {
  const destination = path.resolve(outputPath);
  const desiredHash = createHash('sha256').update(bytes).digest('hex');
  if (existsSync(destination)) {
    const existingHash = createHash('sha256').update(readFileSync(destination)).digest('hex');
    if (existingHash === desiredHash) {
      return { artifactId: null, durable: false, reused: true };
    }
    if (!overwrite) {
      throw new SessionPlaneDomainError(
        'input.output-exists',
        `Refusing to replace existing output: ${destination}`,
      );
    }
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.sessionplane-${randomUUID()}.part`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (overwrite) rmSync(destination, { force: true });
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { artifactId: null, durable: false, reused: false };
}
