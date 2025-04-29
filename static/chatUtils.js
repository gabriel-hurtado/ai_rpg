// chatUtils.js - Utility functions for chat.js

/**
 * Escape HTML to prevent injection.
 */
export function escapeHtml(unsafe) {
  return !unsafe ? "" : unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Set the textarea height dynamically based on content.
 */
export function setTextareaHeight(textarea, scrollOnExpand = false) {
  if (!textarea) return;

  const minHeight = 46;
  const maxHeight = 300;
  const prevHeight = parseInt(window.getComputedStyle(textarea).height, 10);

  textarea.style.height = `${minHeight}px`;
  const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
  textarea.style.height = `${newHeight}px`;

  scrollToBottom('ai-result-output');
}

/**
 * Scroll the chat display container to the bottom.
 * Uses setTimeout for timing reliability.
 * @param {string} containerId - The ID of the scrollable container.
 */
export function scrollToBottom(containerId = 'ai-result-output') {
  const chatDisplay = document.getElementById(containerId);
  if (!chatDisplay) return;

  setTimeout(() => {
    const targetScrollTop = chatDisplay.scrollHeight - chatDisplay.clientHeight;
    if (targetScrollTop > chatDisplay.scrollTop && targetScrollTop > 0) {
      chatDisplay.scrollTop = targetScrollTop;
    }
  }, 50);
}