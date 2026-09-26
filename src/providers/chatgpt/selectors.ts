export const CHATGPT_SELECTORS = {
  chatSurfaceRadios:
    '[role="radiogroup"] [role="radio"][aria-checked="true"], [role="radiogroup"] [role="radio"][data-state="on"]',
  fileInputs: ['input[type="file"]'],
  uploadTriggers: [
    '[data-testid*="attach"]',
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[aria-label*="file" i]',
  ],
  uploadMenuItems: [
    '[role="menuitem"]:has-text("Upload")',
    '[role="menuitem"]:has-text("파일")',
    'button:has-text("Upload")',
  ],
  attachmentEvidence: [
    '[data-testid*="attachment"]',
    '[data-testid*="file-pill"]',
    '[aria-label*="attachment" i]',
  ],
  artifactLinks: [
    'a[download]',
    'a[href*="/files/"]',
    'a[href*="backend-api/files"]',
    'a[href^="blob:"]',
    'a[href^="data:"]',
    'img[src^="blob:"]',
    'img[src^="data:image/"]',
  ],
  userMessages: '[data-message-author-role="user"], [data-chatgpt-search-message-ids]:has([data-user-message-bubble])',
  userMessageContent: [
    '[data-testid="collapsible-user-message-content"]',
    '.whitespace-pre-wrap',
    '[data-testid*="user-message-content"]',
  ],
  userMessageExpansionControls: 'button[aria-expanded="false"]',
  messages: '[data-message-author-role], [data-chatgpt-search-message-ids]',
  stopControls: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="생성 중지"]',
  ],
  thinkingIndicators: [
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[aria-label*="thinking" i]',
  ],
  dialogs: [
    '[role="alertdialog"]',
    '[role="dialog"]',
    '[data-testid*="interstitial"]',
    '[data-testid*="modal"]',
  ],
} as const;
