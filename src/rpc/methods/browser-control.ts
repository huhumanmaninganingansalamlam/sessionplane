import { z } from 'zod';

import {
  BrowserControlError,
  type BrowserControlService,
} from '../../core/browser-control-service.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const PageKey = z.string().trim().min(1).max(300);
const Ref = z.string().regex(/^@e\d+$/);
const SnapshotId = z.string().trim().min(1).max(300);
const OptionalPage = { pageKey: PageKey.optional() } as const;
const RefTarget = {
  ...OptionalPage,
  ref: Ref,
  snapshotId: SnapshotId.optional(),
} as const;

export function registerBrowserControlMethods(
  router: RpcRouter,
  browser: BrowserControlService,
): void {
  router.register('browser.runtime.status', z.object({}).strict(), () =>
    wrapSync(() => browser.runtimeStatus()),
  );
  router.register('browser.runtime.start', z.object({}).strict(), async () =>
    await wrap(() => browser.startRuntime()),
  );
  router.register('browser.runtime.stop', z.object({}).strict(), async () =>
    await wrap(() => browser.stopRuntime()),
  );
  router.register(
    'browser.runtime.reset',
    z.object({ force: z.boolean().default(false) }).strict(),
    async ({ force }) => await wrap(() => browser.resetRuntime(force)),
  );
  router.register('browser.tabs', z.object({}).strict(), async () => await browser.tabs());
  router.register(
    'browser.select',
    z.object({ pageKey: PageKey }).strict(),
    async ({ pageKey }) => await browser.select(pageKey),
  );
  router.register(
    'browser.new',
    z.object({
      url: z.string().url().optional(),
      activate: z.boolean().optional(),
    }).strict(),
    async ({ url, activate }) => await wrap(() => browser.newPage(
      url,
      activate === undefined ? undefined : { activate },
    )),
  );
  router.register(
    'browser.close',
    z.object(OptionalPage).strict(),
    async ({ pageKey }) => await wrap(() => browser.closePage(pageKey)),
  );
  router.register(
    'browser.cleanup',
    z.object({ keepPageKey: PageKey.optional() }).strict(),
    async ({ keepPageKey }) => await wrap(() => browser.cleanup({
      ...(keepPageKey === undefined ? {} : { keepPageKey }),
    })),
  );
  router.register(
    'browser.navigate',
    z.object({ ...OptionalPage, url: z.string().min(1).max(20_000) }).strict(),
    async (params) => await wrap(() => browser.navigate(params)),
  );
  router.register(
    'browser.reload',
    z.object(OptionalPage).strict(),
    async ({ pageKey }) => await wrap(() => browser.reload(pageKey)),
  );
  router.register(
    'browser.back',
    z.object(OptionalPage).strict(),
    async ({ pageKey }) => await wrap(() => browser.history('back', pageKey)),
  );
  router.register(
    'browser.forward',
    z.object(OptionalPage).strict(),
    async ({ pageKey }) => await wrap(() => browser.history('forward', pageKey)),
  );
  router.register(
    'browser.resize',
    z
      .object({
        ...OptionalPage,
        width: z.number().int().min(200).max(10_000),
        height: z.number().int().min(200).max(10_000),
      })
      .strict(),
    async (params) => await wrap(() => browser.resize(params)),
  );
  router.register(
    'browser.snapshot',
    z
      .object({
        ...OptionalPage,
        interactive: z.boolean().default(true),
        maxNodes: z.number().int().min(1).max(5_000).default(250),
      })
      .strict(),
    async (params) => await wrap(() => browser.snapshot(params)),
  );
  router.register(
    'browser.click',
    z
      .object({
        ...RefTarget,
        button: z.enum(['left', 'right', 'middle']).default('left'),
        clickCount: z.number().int().min(1).max(3).default(1),
      })
      .strict(),
    async (params) => await wrap(() => browser.click(params)),
  );
  router.register(
    'browser.type',
    z
      .object({
        ...RefTarget,
        text: z.string().max(2_000_000),
        append: z.boolean().default(false),
      })
      .strict(),
    async (params) => await wrap(() => browser.type(params)),
  );
  router.register(
    'browser.press',
    z
      .object({
        ...OptionalPage,
        ref: Ref.optional(),
        snapshotId: SnapshotId.optional(),
        key: z.string().min(1).max(200),
      })
      .strict(),
    async (params) => await wrap(() => browser.press(params)),
  );
  router.register(
    'browser.hover',
    z.object(RefTarget).strict(),
    async (params) => await wrap(() => browser.hover(params)),
  );
  router.register(
    'browser.selectOption',
    z
      .object({
        ...RefTarget,
        values: z.array(z.string()).min(1).max(100),
      })
      .strict(),
    async (params) => await wrap(() => browser.selectOption(params)),
  );
  router.register(
    'browser.check',
    z.object(RefTarget).strict(),
    async (params) => await wrap(() => browser.setChecked({ ...params, checked: true })),
  );
  router.register(
    'browser.uncheck',
    z.object(RefTarget).strict(),
    async (params) => await wrap(() => browser.setChecked({ ...params, checked: false })),
  );
  router.register(
    'browser.upload',
    z
      .object({
        ...RefTarget,
        files: z.array(z.string().min(1)).min(1).max(100),
      })
      .strict(),
    async (params) => await wrap(() => browser.upload(params)),
  );
  router.register(
    'browser.drag',
    z
      .object({
        ...OptionalPage,
        sourceRef: Ref,
        targetRef: Ref,
        snapshotId: SnapshotId.optional(),
      })
      .strict(),
    async (params) => await wrap(() => browser.drag(params)),
  );
  router.register(
    'browser.mouse',
    z
      .object({
        ...OptionalPage,
        action: z.enum(['click', 'move', 'down', 'up']),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        button: z.enum(['left', 'right', 'middle']).default('left'),
      })
      .strict(),
    async (params) => await wrap(() => browser.mouse(params)),
  );
  router.register(
    'browser.scroll',
    z
      .object({
        ...OptionalPage,
        deltaX: z.number().finite().default(0),
        deltaY: z.number().finite(),
      })
      .strict(),
    async (params) => await wrap(() => browser.scroll(params)),
  );
  router.register(
    'browser.wait',
    z
      .object({
        ...OptionalPage,
        timeoutMs: z.number().int().min(0).max(600_000).default(30_000),
        selector: z.string().min(1).max(10_000).optional(),
        text: z.string().min(1).max(100_000).optional(),
        ref: Ref.optional(),
        snapshotId: SnapshotId.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        const conditions = [value.selector, value.text, value.ref].filter(
          (entry) => entry !== undefined,
        );
        if (conditions.length > 1) {
          context.addIssue({
            code: 'custom',
            message: 'Use only one browser wait condition',
          });
        }
      }),
    async (params) => await wrap(() => browser.wait(params)),
  );
  router.register(
    'browser.screenshot',
    z
      .object({
        ...OptionalPage,
        outputPath: z.string().min(1).max(10_000),
        fullPage: z.boolean().default(false),
      })
      .strict(),
    async (params) => await wrap(() => browser.screenshot(params)),
  );
  router.register(
    'browser.text',
    z
      .object({
        ...OptionalPage,
        selector: z.string().min(1).max(10_000).optional(),
        maxChars: z.number().int().min(1).max(2_000_000).default(200_000),
      })
      .strict(),
    async (params) => await wrap(() => browser.text(params)),
  );
  router.register(
    'browser.dom',
    z
      .object({
        ...OptionalPage,
        selector: z.string().min(1).max(10_000).optional(),
        maxChars: z.number().int().min(1).max(4_000_000).default(500_000),
      })
      .strict(),
    async (params) => await wrap(() => browser.dom(params)),
  );
  router.register(
    'browser.evaluate',
    z
      .object({
        ...OptionalPage,
        script: z.string().min(1).max(1_000_000),
      })
      .strict(),
    async (params) => await wrap(() => browser.evaluate(params)),
  );
  router.register(
    'browser.console',
    z.object({
      ...OptionalPage,
      clear: z.boolean().default(false),
      limit: z.number().int().min(1).max(10_000).optional(),
    }).strict(),
    (params) => wrapSync(() => browser.console(params)),
  );
  router.register(
    'browser.network',
    z.object({ ...OptionalPage, clear: z.boolean().default(false) }).strict(),
    (params) => wrapSync(() => browser.network(params)),
  );
  router.register(
    'browser.observeBundle',
    z
      .object({
        ...OptionalPage,
        screenshotPath: z.string().min(1).max(10_000).optional(),
        includeBoxes: z.boolean().default(true),
        maxTextChars: z.number().int().min(1).max(2_000_000).default(2_000),
        maxNodes: z.number().int().min(1).max(5_000).default(250),
      })
      .strict(),
    async (params) => await wrap(() => browser.observationBundle(params)),
  );
  router.register(
    'browser.observeActions',
    z
      .object({
        ...OptionalPage,
        instruction: z.string().min(1).max(100_000),
        topN: z.number().int().min(1).max(100).default(10),
        includeDisabled: z.boolean().default(false),
      })
      .strict(),
    async (params) => await wrap(() => browser.observeActions(params)),
  );
}

async function wrap<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throwRpc(error);
  }
}

function wrapSync<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    throwRpc(error);
  }
}

function throwRpc(error: unknown): never {
  if (error instanceof BrowserControlError) {
    throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
  }
  throw error;
}
