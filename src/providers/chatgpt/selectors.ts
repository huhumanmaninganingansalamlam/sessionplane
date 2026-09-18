export const CHATGPT_SELECTORS = {
  composer: [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form textarea[placeholder]',
    'form div[contenteditable="true"][data-lexical-editor="true"]',
    'form div[contenteditable="true"][role="textbox"]',
    'form div[contenteditable="true"]',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="전송"]',
  ],
  modelSwitcher: [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-haspopup="menu"][data-testid*="model"]',
    'button[aria-label*="model" i]',
  ],
  modelOptions: '[role="menuitem"], [role="option"], [data-testid*="model-option"], [role="menu"] button',
  effortSwitcher: [
    '[data-testid*="reasoning-effort"]',
    'button[aria-label*="reasoning" i]',
    'button[aria-label*="thinking" i]',
  ],
  surfaceSwitcher: [
    '[data-testid*="composer-tools"]',
    '[data-testid*="tools-button"]',
    'button[aria-label*="tools" i]',
    'button[aria-label*="mode" i]',
  ],
  unsupportedWorkSurfaceMarkers: [
    '[data-testid="composer-model-picker-slider-simple-view"]',
    '[data-testid="composer-model-picker-slider-advanced-view"]',
  ],
  namedModeOptions:
    '[role="menuitem"], [role="option"], [data-testid*="tool"], [data-testid*="mode"], [role="menu"] button',
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
  projectSourceRows: [
    '[data-project-file-id]',
    '[data-testid*="project-source"]',
    '[data-testid*="source-file"]',
    '[data-testid*="file-item"]',
  ],
  projectSourceInputs: ['input[type="file"][multiple]', 'input[type="file"]'],
  projectSourceTriggers: [
    '[data-testid*="add-source"]',
    'button[aria-label*="add files" i]',
    'button[aria-label*="project files" i]',
  ],
  userMessages: '[data-message-author-role="user"]',
  userMessageContent: [
    '[data-testid="collapsible-user-message-content"]',
    '.whitespace-pre-wrap',
    '[data-testid*="user-message-content"]',
  ],
  messages: '[data-message-author-role]',
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

