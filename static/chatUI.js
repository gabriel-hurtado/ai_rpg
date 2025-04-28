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
    div.className = `chat-message ${sender === 'user' ? 'user-message' : 'ai-message'}`;
    // Use markdown for AI and user messages
    let renderedContent;
    if (window.marked) {
        // Fix: preserve line breaks if message is plain text (no markdown)
        // If content contains no markdown, replace \n with <br> before passing to marked
        const isLikelyPlain = !/[\*\_\`\[\]#\-]/.test(content);
        const safeContent = isLikelyPlain ? content.replace(/\n/g, '  \n') : content;
        renderedContent = '<div class="markdown-content">' + window.marked.parse(safeContent) + '</div>';
    } else {
        renderedContent = '<p class="m-0">' + escapeHtml(content).replace(/\n/g, '<br>') + '</p>';
    }
    div.innerHTML = `<strong>${sender === 'user' ? 'You' : 'AI'}:</strong>` + renderedContent;
    chatDisplay.appendChild(div);
}

/**
 * Render an AI response placeholder with spinner.
 * @param {HTMLElement} chatDisplay
 * @returns {HTMLElement} The AI message div
 */
export function renderAIPlaceholder(chatDisplay) {
    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-message ai-message';
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
