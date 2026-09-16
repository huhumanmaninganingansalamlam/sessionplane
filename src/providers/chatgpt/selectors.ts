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
  userMessages: '[data-message-author-role="user"]',
} as const;

