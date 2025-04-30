// chatUI.js - Handles DOM updates for chat UI
import { escapeHtml } from './chatUtils.js';

/**
 * Render a chat message in the chat display.
 * @param {'user'|'ai'} sender
 * @param {string} content
 * @param {HTMLElement} chatDisplay
 * @param {string|null} messageId
 * @param {function|null} onDelete
 * @param {number|null} index
 * @returns {void}
 */
export function renderMessage(sender, content, chatDisplay, messageId = null, onDelete = null, index = null) {
  const div = document.createElement('div');
  div.className = `${sender === 'user' ? 'user-message' : 'ai-message'} chat-message`;
  if (messageId) div.dataset.messageId = messageId;
  let renderedContent;
  if (window.marked) {
    if (window.marked.setOptions) {
      window.marked.setOptions({ breaks: true }); // Treat single \n as <br>
    }
    renderedContent = `<div class="markdown-content">${window.marked.parse(content)}</div>`;
  } else {
    renderedContent = `<p class="m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
  }
  // Add delete button for each message
  let deleteBtnHtml = '';
  if (typeof onDelete === 'function') {
    deleteBtnHtml = `<button class="btn btn-link btn-sm p-0 ms-2 message-delete-btn" title="Delete from here"><i class="bi bi-x-circle"></i></button>`;
  }
  div.innerHTML = `<strong class="sender-label">${sender === 'user' ? 'You' : 'AI'}:</strong>${renderedContent}${deleteBtnHtml}`;
  chatDisplay.appendChild(div);
  if (deleteBtnHtml && typeof onDelete === 'function') {
    const btn = div.querySelector('.message-delete-btn');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(index);
    });
  }
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
