import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const COMPATIBILITY_STATUSES = [
  'implemented',
  'foundation',
  'missing',
  'deferred',
] as const;
export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

const CommandSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    required: z.boolean(),
    status: z.enum(COMPATIBILITY_STATUSES),
    legacyCommands: z.array(z.string().min(1)).min(1),
    canonicalCommands: z.array(z.string().min(1)),
    rpcMethods: z.array(z.string().min(1)),
    contracts: z.array(z.string().min(1)),
  })
  .strict();

const ManifestSchema = z
  .object({
    schemaVersion: z.literal('agbrowse-compatibility-v1'),
    source: z
      .object({
        repository: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        branch: z.string().min(1),
      })
      .strict(),
    commands: z.array(CommandSchema).min(1),
  })
  .strict();

export type AgbrowseCapability = z.infer<typeof CommandSchema>;
export type AgbrowseManifest = z.infer<typeof ManifestSchema>;

export function loadAgbrowseManifest(
  manifestPath = fileURLToPath(new URL('../../compat/agbrowse-manifest.json', import.meta.url)),
): AgbrowseManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const manifest = ManifestSchema.parse(parsed);
  const ids = new Set<string>();
  for (const command of manifest.commands) {
    if (ids.has(command.id)) {
      throw new Error(`Duplicate agbrowse capability id: ${command.id}`);
    }
    ids.add(command.id);
    if (command.status === 'implemented' && command.contracts.length === 0) {
      throw new Error(`Implemented capability has no executable contract: ${command.id}`);
    }
  }
  return manifest;
}

export function requiredIncomplete(
  manifest: AgbrowseManifest,
  category?: string,
): readonly AgbrowseCapability[] {
  return manifest.commands.filter(
    (command) =>
      command.required &&
      command.status !== 'implemented' &&
      (category === undefined || command.category === category),
  );
}

export function capabilityForLegacyCommand(
  manifest: AgbrowseManifest,
  command: string,
): AgbrowseCapability | null {
  return (
    manifest.commands.find((candidate) => candidate.legacyCommands.includes(command)) ?? null
  );
}

export function replacementReady(manifest: AgbrowseManifest): boolean {
  return requiredIncomplete(manifest).length === 0;
}
