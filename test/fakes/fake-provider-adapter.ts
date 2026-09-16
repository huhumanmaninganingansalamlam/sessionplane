import {
  ProviderSubmissionError,
  type ProviderAdapter,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
  type ProviderSubmissionRequest,
} from '../../src/providers/provider-adapter.ts';

export type FakeAcknowledgementMode = 'success' | 'missing';

export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt';
  acknowledgementMode: FakeAcknowledgementMode = 'success';
  submitThrows = false;
  readonly disabledModels = new Set<string>();
  openCount = 0;
  prepareCount = 0;
  submitCount = 0;
  acknowledgementCount = 0;
  bindCount = 0;

  async openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission> {
    this.openCount += 1;
    const adapter = this;
    const pageKey = `fake-page:${request.session.sessionId}`;
    return {
      provider: this.provider,
      pageKey,
      async prepare(): Promise<void> {
        adapter.prepareCount += 1;
        if (request.model !== null && adapter.disabledModels.has(request.model)) {
          throw new ProviderSubmissionError(
            'provider.model-unavailable',
            `Fake model is disabled: ${request.model}`,
          );
        }
      },
      async submitOnce(): Promise<void> {
        adapter.submitCount += 1;
        if (adapter.submitThrows) {
          throw new Error('Synthetic submit transport failure');
        }
      },
      async captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null> {
        adapter.acknowledgementCount += 1;
        if (adapter.acknowledgementMode === 'missing') {
          return null;
        }
        return {
          conversationId: `conversation-${request.session.sessionId}`,
          submittedUserMessageId: `user-message-${request.generation}`,
          submittedUserTurnId: `user-turn-${request.generation}`,
        };
      },
      bindAcknowledgement(): void {
        adapter.bindCount += 1;
      },
    };
  }
}

