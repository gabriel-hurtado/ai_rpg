// chatUtils.js - Utility functions for chat.js

/**
 * Escape HTML to prevent injection.
 */
export function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
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
    const initialHeight = textarea.style.height;
    // Use computed style to get previous pixel value
    const prevHeight = parseInt(window.getComputedStyle(textarea).height, 10);
    textarea.style.height = `${minHeight}px`;
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight));
    const newHeightPx = `${newHeight}px`;
    if (newHeightPx !== initialHeight) {
        textarea.style.height = newHeightPx;
    } else {
        textarea.style.height = initialHeight;
    }
    scrollToBottom('ai-result-output');
}

/**
 * Scroll the chat display container to the bottom.
 * Uses setTimeout for timing reliability.
 * @param {string} containerId - The ID of the scrollable container.
 * @param {boolean} debug - Whether to output debug logs.
 */
export function scrollToBottom(containerId = 'ai-result-output', debug = false) {
   const chatDisplay = document.getElementById(containerId);
   if (!chatDisplay) {
       if (debug) console.error(`[Scroll] scrollToBottom: Container #${containerId} not found.`);
       return;
   }

   // Use setTimeout to ensure DOM updates are processed before scrolling attempt
   setTimeout(() => {
       const scrollH = chatDisplay.scrollHeight;
       const clientH = chatDisplay.clientHeight;
       const currentTop = chatDisplay.scrollTop;
       // Calculate where the bottom is
       const targetScrollTop = scrollH - clientH;

       // Basic debug logging (optional)
       if (debug) {
           console.log(`[Scroll Attempt] #${containerId} | scrollH: ${scrollH}, clientH: ${clientH}, currentTop: ${currentTop}, targetTop: ${targetScrollTop}`);
       }

       // Only scroll if scrolling is actually needed (target > current)
       // and the target is positive (handles cases where content fits)
       if (targetScrollTop > currentTop && targetScrollTop > 0) {
            // Direct assignment is most reliable for instant scroll
           chatDisplay.scrollTop = targetScrollTop;
           if (debug) console.log(`[Scroll] Setting scrollTop for #${containerId} to: ${targetScrollTop}`);
       } else {
           if (debug) console.log(`[Scroll] No scroll needed for #${containerId}.`);
       }
   }, 50); // Delay (e.g., 50ms)
}