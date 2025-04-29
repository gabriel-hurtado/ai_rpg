// chatUI.js - Handles DOM updates for chat UI
import { escapeHtml } from './chatUtils.js';

/**
 * Render a chat message in the chat display.
 * @param {'user'|'ai'} sender
 * @param {string} content
 * @param {HTMLElement} chatDisplay
 * @returns {void}
 */
export function renderMessage(sender, content, chatDisplay) {
  const div = document.createElement('div');
  div.className = `${sender === 'user' ? 'user-message' : 'ai-message'} chat-message`;

  let renderedContent;
  if (window.marked) {
    if (window.marked.setOptions) {
      window.marked.setOptions({ breaks: true }); // Treat single \n as <br>
    }
    renderedContent = `<div class="markdown-content">${window.marked.parse(content)}</div>`;
  } else {
    renderedContent = `<p class="m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
  }

  div.innerHTML = `<strong class="sender-label">${sender === 'user' ? 'You' : 'AI'}:</strong>${renderedContent}`;
  chatDisplay.appendChild(div);
}

/**
 * Render an AI response placeholder with spinner.
 * @param {HTMLElement} chatDisplay
 * @returns {HTMLElement} The AI message div
 */
export function renderAIPlaceholder(chatDisplay) {
  const aiDiv = document.createElement('div');
  aiDiv.className = 'ai-message chat-message';
  aiDiv.innerHTML = `<strong>AI:</strong><div class="markdown-content"><span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span><span class="visually-hidden">Generating...</span></div>`;
  chatDisplay.appendChild(aiDiv);
  return aiDiv;
}

/**
 * Display an error in the chat area.
 * @param {string} message
 * @param {HTMLElement} chatDisplay
 * @returns {void}
 */
export function renderChatError(message, chatDisplay) {
  chatDisplay.innerHTML = `<p class="text-danger small text-center">${escapeHtml(message)}</p>`;
}

/**
 * Remove the initial placeholder if present.
 * @param {HTMLElement} chatDisplay
 * @returns {void}
 */
export function removeInitialPrompt(chatDisplay) {
  const placeholder = chatDisplay.querySelector('.initial-chat-prompt');
  if (placeholder) placeholder.remove();
}
