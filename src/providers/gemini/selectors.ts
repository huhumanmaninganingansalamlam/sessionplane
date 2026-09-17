export const GEMINI_SELECTORS = {
  composer: [
    'rich-textarea .ql-editor',
    '[role="textbox"][aria-label*="prompt" i]',
    '[role="textbox"][aria-label*="Gemini" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button.send-button',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="메시지 보내기" i]',
  ],
  userMessages: [
    'user-query',
    '[data-test-id="user-query"]',
    '.user-query-container',
    '[data-message-author-role="user"]',
  ],
  assistantMessages: [
    'model-response',
    '[data-response-index]',
    '[data-message-author-role="assistant"]',
  ],
  assistantText: ['message-content', '.markdown', '[class*="response-content"]'],
  completion: ['.response-footer.complete', 'message-actions', '[aria-label*="Good response" i]'],
  stopControls: [
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="Stop generating" i]',
    'button:has-text("Stop")',
  ],
  modelSwitcher: [
    'button[aria-label*="model" i]',
    '[data-test-id*="model" i] button',
    'button[data-test-id*="model" i]',
  ],
  modelOptions: '[role="menuitem"], [role="option"], [data-test-id*="model" i]',
  fileInputs: ['input[type="file"]'],
  uploadTriggers: [
    'button[aria-label="Open upload file menu"]',
    'button[aria-label*="upload file menu" i]',
    'button[aria-label="Upload & tools"]',
    'button[aria-label*="Upload" i][aria-haspopup="menu"]',
    'button[aria-label*="업로드" i][aria-haspopup="menu"]',
  ],
  uploadMenuItems: [
    '[role="menuitem"][aria-label^="Upload files" i]',
    'button[aria-label^="Upload files" i]',
    '[data-test-id="local-images-files-uploader-button"]',
  ],
  attachmentEvidence: [
    'input-area-v2 [data-test-id*="attachment" i]',
    'input-area-v2 [aria-label*="remove file" i]',
    'input-area-v2 [class*="attachment" i]',
  ],
  artifactLinks: [
    'model-response a[download]',
    'model-response a[href*="download" i]',
    'model-response a[href^="blob:"]',
    'model-response a[href^="data:"]',
  ],
} as const;
