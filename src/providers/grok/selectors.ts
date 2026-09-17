export const GROK_SELECTORS = {
  composer: [
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"].ProseMirror',
    '[role="textbox"][contenteditable="true"]',
  ],
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="Send" i]',
    '[data-testid="send-button"]',
  ],
  userMessages: ['[data-testid="user-message"]', '[data-message-author-role="user"]'],
  assistantMessages: [
    '[data-testid="assistant-message"]',
    '[data-message-author-role="assistant"]',
  ],
  assistantText: ['.response-content-markdown', '.markdown', '[class*="response-content"]'],
  completion: [
    '[data-testid="assistant-message"] [data-state="complete"]',
    '[data-testid="assistant-message"] button[aria-label*="copy" i]',
  ],
  stopControls: ['button[aria-label*="Stop" i]', 'button:has-text("Stop")'],
  modelSwitcher: [
    'button[aria-label*="model" i]',
    'button[data-testid*="model" i]',
    '[data-testid*="model-selector" i]',
  ],
  modelOptions: '[role="menuitem"], [role="option"], [data-testid*="model" i]',
  fileInputs: ['input[type="file"]'],
  uploadTriggers: [
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Attach" i]',
    'button[data-testid*="plus" i]',
  ],
  uploadMenuItems: ['[role="menuitem"]', 'button[aria-label*="Upload" i]'],
  attachmentEvidence: [
    '[data-testid*="attachment" i]',
    '[data-testid*="file" i]',
    '[aria-label*="attachment" i]',
    '[aria-label*="file" i]',
  ],
  artifactLinks: [
    '[data-testid="assistant-message"] a[download]',
    '[data-testid="assistant-message"] a[href*="download" i]',
    '[data-testid="assistant-message"] a[href^="blob:"]',
    '[data-testid="assistant-message"] a[href^="data:"]',
  ],
} as const;
