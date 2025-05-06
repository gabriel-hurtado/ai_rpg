// chatUI.js - Handles DOM updates for chat UI
import { escapeHtml } from './chatUtils.js';

/**
 * Render a chat message in the chat display.
 * @param {'user'|'ai'} sender
 * @param {string} content
 * @param {HTMLElement} chatDisplay
 * @param {string|null} messageId
 * @param {function|null} onDelete - Callback for delete button, receives index.
 * @param {number|null} index - Index of the message, passed to onDelete callback.
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
    // The actual markdown content will be parsed and put inside this div
    renderedContent = `<div class="markdown-content">${window.marked.parse(content)}</div>`;
  } else {
    // Fallback for non-markdown rendering
    renderedContent = `<div class="markdown-content"><p class="m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</p></div>`;
  }

  // --- Action Buttons Container ---
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'message-actions d-flex align-items-center ms-2'; // Use flex for button alignment

  // --- Copy Button (only for AI messages) ---
  if (sender === 'ai') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-link btn-sm p-0 message-copy-btn';
    copyBtn.title = 'Copy AI response text';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const markdownContentDiv = div.querySelector('.markdown-content');
      if (markdownContentDiv) {
        try {
          // Get text content to avoid copying HTML
          // For marked content, .textContent on the .markdown-content div should be fairly clean
          const textToCopy = markdownContentDiv.textContent || '';
          await navigator.clipboard.writeText(textToCopy.trim());
          // Optional: Provide feedback
          copyBtn.innerHTML = '<i class="bi bi-check-lg text-success"></i>';
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
          }, 1500);
          console.log('[ChatUI] AI message content copied to clipboard.');
        } catch (err) {
          console.error('[ChatUI] Failed to copy AI message content:', err);
          alert('Failed to copy text.');
        }
      }
    });
    actionsDiv.appendChild(copyBtn);
  }

  // --- Delete Button (for all messages if onDelete is provided) ---
  if (typeof onDelete === 'function') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn'; // Added ms-2 for spacing if copy btn exists
    deleteBtn.title = 'Delete message and following';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (index !== null) { // Ensure index is provided
        onDelete(index);
      } else {
        console.warn('[ChatUI] Delete button clicked, but no index provided to callback.');
      }
    });
    actionsDiv.appendChild(deleteBtn);
  }

  // --- Assemble Message ---
  // Structure: [Label] [Content] [Actions Container]
  // This might require a slight adjustment to how messages are styled if `chat-message` was display:flex previously.
  // Using a wrapper for content and actions to keep them together if message itself is flex.
  
  const messageContentWrapper = document.createElement('div');
  messageContentWrapper.className = 'message-content-wrapper flex-grow-1'; // Allow content to take up space
  messageContentWrapper.innerHTML = `<strong class="sender-label">${sender === 'user' ? 'You' : 'AI'}:</strong>${renderedContent}`;

  div.appendChild(messageContentWrapper);
  if (actionsDiv.hasChildNodes()) {
    div.appendChild(actionsDiv); // Append actions container to the main message div
  }
  
  // Ensure the main message div itself is flex if you want label/content/actions side-by-side
  // Or style .message-actions to position it absolutely/relatively as needed.
  // For simplicity, let's assume .chat-message will be styled with display:flex
  // e.g., .chat-message { display: flex; align-items: flex-start; /* or center */ }

  chatDisplay.appendChild(div);
}

/**
 * Render an AI response placeholder with spinner.
 * @param {HTMLElement} chatDisplay
 * @returns {HTMLElement} The AI message div
 */
export function renderAIPlaceholder(chatDisplay) {
  const aiDiv = document.createElement('div');
  aiDiv.className = 'ai-message chat-message'; // Placeholder is also a chat-message
  // AI Placeholder doesn't need copy/delete buttons initially. They are added later if applicable.
  aiDiv.innerHTML = `
    <div class="message-content-wrapper flex-grow-1">
      <strong class="sender-label">AI:</strong>
      <div class="markdown-content">
        <span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span>
        <span class="visually-hidden">Generating...</span>
      </div>
    </div>`;
  // No actionsDiv for placeholder initially
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