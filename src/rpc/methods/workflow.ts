import { z } from 'zod';
import type { TeamWorkflow } from '../../core/team-workflow.ts';
import type { RpcRouter } from '../router.ts';

const requestId = z.string().trim().min(1).max(300).describe('Stable unique ID for this mutation. Reuse only for identical arguments.');
const teamId = z.string().uuid().describe('Durable team ID.');
const roleRef = z.string().regex(/^[0-9a-f-]{36}:\d+$/).describe('Copy the roleRef returned by team_get; refresh after each new send or replacement.');
const requestRef = z.string().uuid().describe('Copy the exact requestRef from send or team_get.');
const provider = z.enum(['chatgpt', 'gemini', 'grok']).default('chatgpt');
const mutation = { teamId, requestId };
const request = { teamId, requestRef };

export const workflowSchemas = {
  team_create: z.object({ requestId, name: z.string().max(500).optional(), objective: z.string().max(20_000).optional(), provider }).strict(),
  team_get: z.object({ teamId, requestRef: requestRef.optional(), maxNodes: z.number().int().min(1).max(5000).optional(), history: z.boolean().optional().describe('List all request generations in pages, newest first.'), beforeRequestRef: requestRef.optional().describe('Continue history using nextRequestRef returned by team_get.') }).strict(),
  role_create: z.object({ ...mutation, roleKey: z.string().trim().min(1).max(80), roleType: z.enum(['expert', 'reviewer', 'custom']).default('expert'), displayName: z.string().max(500).optional(), provider }).strict(),
  role_retire: z.object({ ...mutation, roleRef }).strict(),
  session_replace: z.object({ ...mutation, roleRef }).strict(),
  session_delete: z.object({ ...request, requestId, outputsRetrieved: z.literal(true) }).strict(),
  send: z.object({ ...mutation, roleRef, prompt: z.string().min(1).max(200_000), model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(200).optional(), files: z.array(z.string().min(1).max(20_000)).max(20).optional(), sessionDeadlineSec: z.number().int().min(1).max(86_400).default(5400) }).strict(),
  decide: z.object({ ...request, requestId, decision: z.enum(['choose', 'reveal']), purpose: z.enum(['model', 'effort', 'composer', 'submit']), snapshotId: z.string().uuid(), ref: z.string().regex(/^@e\d+$/), value: z.number().optional() }).strict(),
  wait: z.object({ teamId, requestRefs: z.array(requestRef).min(1), waitMs: z.number().int().min(0).max(120_000).default(30_000), outputDir: z.string().min(1).optional() }).strict(),
  stop: z.object({ ...request, requestId }).strict(),
};

export function registerWorkflowMethods(router: RpcRouter, workflow: TeamWorkflow) {
  router.register('workflow.team_create', workflowSchemas.team_create, (input) => workflow.createTeam(input));
  router.register('workflow.team_get', workflowSchemas.team_get, (input) => workflow.getTeam(input));
  router.register('workflow.role_create', workflowSchemas.role_create, (input) => workflow.createRole(input));
  router.register('workflow.role_retire', workflowSchemas.role_retire, (input) => workflow.retireRole(input));
  router.register('workflow.session_replace', workflowSchemas.session_replace, (input) => workflow.replaceSession(input));
  router.register('workflow.session_delete', workflowSchemas.session_delete, (input) => workflow.deleteSession(input));
  router.register('workflow.send', workflowSchemas.send, (input) => workflow.send(input));
  router.register('workflow.decide', workflowSchemas.decide, (input) => workflow.decide(input));
  router.register('workflow.wait', workflowSchemas.wait, (input) => workflow.wait(input));
  router.register('workflow.stop', workflowSchemas.stop, (input) => workflow.stop(input));
}
