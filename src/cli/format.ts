import { RpcClientError } from './client.ts';

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
export interface CliErrorShape {
  readonly requestOk: false;
  readonly errorCode: string;
  readonly message: string;
  readonly details?: unknown;
}

export function writeCliResult(io: CliIo, json: boolean, result: unknown): void {
  io.stdout.write((json ? JSON.stringify(result) : humanResult(result)) + '\n');
}

export function writeCliError(io: CliIo, json: boolean, error: unknown): CliErrorShape {
  const shape = normalizeCliError(error);
  if (json) io.stderr.write(JSON.stringify(shape) + '\n');
  else {
    io.stderr.write('Failed: ' + shape.message + '\nError: ' + shape.errorCode + '\n');
    if (shape.errorCode.startsWith('core.') || shape.errorCode === 'uncertain_mutation') {
      io.stderr.write('Recover the same task/requestId; do not repeat an unacknowledged send.\n');
    }
    if (shape.errorCode === 'idempotency_conflict') {
      io.stderr.write('An existing requestId belongs to a different operation.\n');
    }
  }
  return shape;
}

export function normalizeCliError(error: unknown): CliErrorShape {
  if (error instanceof Error && 'errorCode' in error &&
      typeof error.errorCode === 'string') {
    return { requestOk: false, errorCode: error.errorCode, message: error.message };
  }
  if (error instanceof RpcClientError) {
    const data = isRecord(error.data) ? error.data : {};
    return {
      requestOk: false,
      errorCode: typeof data.errorCode === 'string'
        ? data.errorCode : 'internal_failure',
      message: error.message,
      ...(data.details === undefined ? {} : { details: data.details }),
    };
  }
  return {
    requestOk: false,
    errorCode: 'invalid_request',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function humanResult(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result, null, 2) ?? '';
  if (result.requestOk === false) {
    return 'Failed: ' + String(result.message ?? result.errorCode ?? 'unknown');
  }
  if (typeof result.taskId === 'string' && typeof result.state === 'string') {
    const lines = [
      'Task: ' + result.taskId,
      'State: ' + result.state,
      'Revision: ' + String(result.revision ?? 'unknown'),
    ];
    const submission = isRecord(result.submission) ? result.submission : null;
    if (submission) {
      lines.push('Dispatch attempted: ' + String(submission.attempted === true));
      lines.push('Canonical ACK: ' + String(submission.acknowledged === true));
    }
    if (result.cancelOutcome) lines.push('Cancel: ' + String(result.cancelOutcome));
    const decision = isRecord(result.decision) ? result.decision : null;
    if (decision) {
      lines.push('Decision: ' + String(decision.kind ?? 'pending') + ' [' +
        String(decision.decisionId ?? 'unknown') + ']');
      if (Array.isArray(decision.options)) {
        for (const option of decision.options) {
          if (!isRecord(option)) continue;
          lines.push('  actionRef ' + String(option.actionRef) + ' (' +
            String(option.effect ?? option.purpose ?? 'choice') + ')');
        }
      }
    }
    const recorded = isRecord(result.result) ? result.result : null;
    if (recorded && typeof recorded.answerText === 'string') {
      lines.push('Exact answer (' + String(recorded.answerBytes ?? '?') + ' bytes):');
      lines.push(recorded.answerText);
    } else if (result.resultAvailable === true) {
      lines.push('Result available: sessplane task get ' + result.taskId + ' --view result');
    }
    return lines.join('\n');
  }
  if (typeof result.projectId === 'string' && typeof result.mainConversationSlotId === 'string') {
    return [
      'Project: ' + result.projectId,
      'Main slot: ' + result.mainConversationSlotId,
      'Conversation revision: ' + String(result.conversationRevision ?? '?'),
      'Model intent: ' + String(result.modelIntent ?? 'unspecified'),
    ].join('\n');
  }
  if (typeof result.version === 'string' && isRecord(result.database)) {
    return 'SessionPlane ' + result.version + '\n' +
      'Database: ' + String(result.database.readable === true ? 'readable' : 'unavailable') +
      '\nUse --json for full diagnostics.';
  }
  return JSON.stringify(result, null, 2);
}
