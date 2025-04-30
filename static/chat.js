import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';

/**
 * ChatManager orchestrates chat state, event wiring, and uses modular helpers for UI and API.
 */
const ChatManager = {
  currentConversationId: null,
  chatInitialized: false,

  /**
   * Load the user's latest conversation or show the new conversation prompt.
   */
  async loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) return;
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      return;
    }
    try {
      const data = await fetchConversations(token);
      if (Array.isArray(data) && data.length > 0) {
        const latestConv = data[0];
        this.currentConversationId = latestConv.id;
        await this.loadAndDisplayConversation(latestConv.id);
      } else {
        await this.loadAndDisplayConversation(null);
      }
    } catch (e) {
      renderChatError('Error processing conversations.', chatDisplay);
      await this.loadAndDisplayConversation(null);
    }
  },

  /**
   * Load and display a specific conversation by ID.
   */
  async loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) return;
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      return;
    }
    try {
      const conversation = await fetchConversationById(conversationId, token);
      chatDisplay.innerHTML = '';
      if (!conversation || !Array.isArray(conversation.messages)) {
        renderChatError('No messages found.', chatDisplay);
        return;
      }
      conversation.messages.forEach((msg, idx) => {
        renderMessage(
          msg.role === 'user' ? 'user' : 'ai',
          msg.content,
          chatDisplay,
          msg.id || null,
          async (deleteIdx) => {
            if (confirm('Delete this message and all after?')) {
              await ChatManager.deleteMessageAndAfter(deleteIdx);
            }
          },
          idx
        );
      });
      this.currentConversationId = conversationId;
    }
    catch (e) {
      renderChatError('Error loading conversation.', chatDisplay);
      this.currentConversationId = null;
    }
    scrollToBottom('ai-result-output', false);
  },

  /**
   * Handle user message submission and display streaming AI response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    // console.log('[Chat][handleAPISubmission] Function called. User message:', userMessage); // <-- Remove this log
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let success = false;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    const userMessageElement = aiMessageDiv.previousElementSibling; // Keep this reference

    if (!token) {
      // console.error('[Chat][handleAPISubmission] No token found.'); // <-- Remove log
      if (aiMessageDiv) {
        aiMessageDiv.innerHTML = '<span class="text-danger">Error: Not logged in.</span>';
      }
      return;
    }
    try {
      // console.log('[Chat][handleAPISubmission] Attempting to send message to API. Conversation ID:', this.currentConversationId); // <-- Remove this log
      const response = await sendChatMessage({ prompt: userMessage, conversationId: this.currentConversationId, token });
      // console.log('[Chat][handleAPISubmission] Received response from API. Status:', response.status); // <-- Remove this log

      if (!response.ok) {
          const errorText = await response.text();
          // console.error('[Chat][handleAPISubmission] API response not OK:', response.status, errorText); // <-- Remove log
          throw new Error(errorText);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = '';
      const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
      if (!markdownDiv) {
          // console.error('[Chat][handleAPISubmission] Markdown display area not found in aiMessageDiv.'); // <-- Remove log
          throw new Error('Markdown display area not found.');
      }

      // console.log('[Chat][handleAPISubmission] Starting stream reading loop...'); // <-- Remove this log
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
            // console.log('[Chat][handleAPISubmission] Stream finished (done).'); // <-- Remove this log
            break;
        }
        let chunk = decoder.decode(value, { stream: true });
        // console.log('[Chat][handleAPISubmission] Received raw chunk:', JSON.stringify(chunk)); // Remove raw chunk log

        let jsonPayload = null;
        let textContent = chunk; // Assume it's all text initially

        // --- Check if chunk contains the JSON payload ---
        const potentialJsonStart = chunk.lastIndexOf('{"userMessageId":');
        if (potentialJsonStart !== -1 && chunk.trim().endsWith('}')) {
            const potentialJsonString = chunk.substring(potentialJsonStart).trim();
            try {
                const parsed = JSON.parse(potentialJsonString);
                if (parsed.userMessageId && parsed.aiMessageId) {
                    jsonPayload = parsed;
                    textContent = chunk.substring(0, potentialJsonStart);
                    // console.log('[Chat][handleAPISubmission] Extracted JSON payload:', jsonPayload); // Remove log
                    // console.log('[Chat][handleAPISubmission] Remaining text content:', JSON.stringify(textContent)); // Remove log
                } else {
                     // console.log('[Chat][handleAPISubmission] Parsed object from chunk end, but missing required keys.'); // Remove log
                     jsonPayload = null;
                     textContent = chunk;
                }
            } catch (e) {
                 // console.log('[Chat][handleAPISubmission] Found potential JSON structure at end, but failed to parse:', e.message); // Remove log
                jsonPayload = null;
                textContent = chunk;
            }
        }
        // --- End Check ---

        // Append text content if any exists after potential JSON extraction
        if (textContent && textContent.trim().length > 0) {
            aiResponseContent += textContent;
            markdownDiv.innerHTML = window.marked ? marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
            scrollToBottom('ai-result-output', true);
        }

        // Process JSON payload if it was successfully extracted
        if (jsonPayload) {
            // console.log('[Chat] Processing final message IDs:', jsonPayload); // Remove log

            // --- Assign IDs ---
            aiMessageDiv.dataset.messageId = jsonPayload.aiMessageId;
            if (userMessageElement) {
                 userMessageElement.dataset.messageId = jsonPayload.userMessageId;
                 // console.log(`[Chat] Set user message element ID (via previousElementSibling) to ${jsonPayload.userMessageId}`); // Remove log
            } else {
                 // console.warn(`[Chat] Could not find user message element (via previousElementSibling) to set ID ${jsonPayload.userMessageId}`); // Remove log
            }
            // --- End Assign IDs ---

            // --- Add Delete Buttons ---
            const chatDisplay = document.getElementById('chat-message-list');
            if (!chatDisplay) {
                // console.error("[Chat] Cannot add delete buttons: chat-message-list not found."); // Remove log
            } else {
                const messages = chatDisplay.children;
                const aiMessageIndex = messages.length - 1;
                const userMessageIndex = messages.length - 2;

                // console.log(`[Chat] Attempting to add delete button to AI message at index ${aiMessageIndex}`); // Remove log
                this.addDeleteButtonAndListener(aiMessageDiv, aiMessageIndex);

                if (userMessageIndex >= 0) {
                    const userMessageDivAtIndex = messages[userMessageIndex];
                    if (userMessageDivAtIndex && userMessageDivAtIndex.classList.contains('user-message')) {
                        if (userMessageDivAtIndex.dataset.messageId == jsonPayload.userMessageId) {
                             // console.log(`[Chat] Attempting to add delete button to User message at index ${userMessageIndex}`); // Remove log
                             this.addDeleteButtonAndListener(userMessageDivAtIndex, userMessageIndex);
                        } else {
                             // console.warn(`[Chat] User message element at index ${userMessageIndex} found, but ID (${userMessageDivAtIndex.dataset.messageId}) doesn't match expected (${jsonPayload.userMessageId}). Forcing ID and adding button.`); // Remove log
                             userMessageDivAtIndex.dataset.messageId = jsonPayload.userMessageId;
                             this.addDeleteButtonAndListener(userMessageDivAtIndex, userMessageIndex);
                        }
                    } else {
                         // console.warn(`[Chat] Could not find valid user message element at index ${userMessageIndex} to add delete button.`); // Remove log
                    }
                } else {
                     // console.warn(`[Chat] Invalid user message index calculated (${userMessageIndex}). Cannot add delete button.`); // Remove log
                }
            }
            // --- End Add Delete Buttons ---
            break;
        }
      } // End while loop

      // Final UI update after loop in case the last text chunk wasn't rendered
      markdownDiv.innerHTML = window.marked ? marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');

      await this.fetchAndUpdateCreditsDisplay();
      success = true;
      if (textareaElement && success) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }
      scrollToBottom('ai-result-output', true);
    } catch (error) {
      if (aiMessageDiv) {
        const errorDisplayTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorDisplayTarget.textContent = `Error: ${error.message}`;
        errorDisplayTarget.classList.add('text-danger');
      }
      scrollToBottom('ai-result-output', true);
    } finally {
      if (textareaElement) {
        textareaElement.disabled = false;
        if (success) setTextareaHeight(textareaElement);
      }
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
    }
  },

  /**
   * Fetch and update the user's credits display in the UI.
   */
  async fetchAndUpdateCreditsDisplay() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;
    try {
      const resp = await fetch('/api/v1/user/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        const credits = data.credits;
        const navbarCredits = document.getElementById('navbar-user-credits');
        if (navbarCredits) navbarCredits.textContent = `Credits: ${credits}`;
      }
    } catch (e) {
      console.error('Failed to fetch updated credits:', e);
    }
  },

  /**
   * Initialize the chat (load latest conversation, set flag).
   */
  initializeChat() {
    if (ChatManager.chatInitialized) {
      console.log('[Chat] InitializeChat called, but already initialized.');
      return;
    }
    console.log('[Chat] Initializing chat...');
    ChatManager.loadLatestConversation();
    ChatManager.chatInitialized = true;
    console.log('[Chat] Chat initialized flag set to true.');
    setTimeout(() => scrollToBottom('ai-result-output', false), 100);
  },

  /**
   * Render the sidebar conversation list.
   */
  async renderSidebarConversations() {
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const list = document.getElementById('conversation-list');
    const newBtn = document.getElementById('new-conversation-btn');
    if (!sidebar || !list) return;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      list.innerHTML = '<li><span class="text-muted">Not logged in</span></li>';
      if (newBtn) newBtn.disabled = true;
      return;
    }
    if (newBtn) newBtn.disabled = false;
    try {
      const conversations = await fetchConversations(token);
      list.innerHTML = '';
      if (!Array.isArray(conversations) || conversations.length === 0) {
        list.innerHTML = '<li><span class="text-muted">No conversations</span></li>';
        return;
      }
      conversations.forEach(conv => {
        const li = document.createElement('li');
        li.textContent = conv.title || 'Untitled';
        li.title = conv.title;
        if (conv.id === this.currentConversationId) li.classList.add('active');
        // Add rename button
        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn btn-link btn-sm p-0 ms-2 conversation-rename-btn';
        renameBtn.title = 'Rename Conversation';
        renameBtn.innerHTML = '<i class="bi bi-pencil"></i>';
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showRenameDialog(conv);
        });
        li.appendChild(renameBtn);
        // Add delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 conversation-delete-btn';
        deleteBtn.title = 'Delete Conversation';
        deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Delete this conversation?')) {
            await this.deleteConversation(conv.id);
            await this.renderSidebarConversations();
            await this.loadLatestConversation();
          }
        });
        li.appendChild(deleteBtn);
        li.addEventListener('click', async () => {
          if (conv.id !== this.currentConversationId) {
            await this.loadAndDisplayConversation(conv.id);
            await this.renderSidebarConversations();
          }
        });
        list.appendChild(li);
      });
      if (newBtn && !newBtn.onclick) {
        newBtn.onclick = async (e) => {
          e.preventDefault();
          await this.createNewConversation();
          await this.renderSidebarConversations();
          await this.loadLatestConversation();
        };
      }
    } catch (e) {
      list.innerHTML = '<li><span class="text-danger">Error loading conversations</span></li>';
      if (newBtn) newBtn.disabled = true;
    }
  },

  // Add method to show rename dialog
  async showRenameDialog(conv) {
    const newTitle = prompt('Rename conversation:', conv.title);
    if (newTitle && newTitle.trim() && newTitle !== conv.title) {
      await this.renameConversation(conv.id, newTitle.trim());
      await this.renderSidebarConversations();
    }
  },

  // Add method to call API for new conversation
  async createNewConversation() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;
    await fetch('/api/v1/conversations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  },

  // Add method to call API for rename
  async renameConversation(conversationId, newTitle) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;
    await fetch(`/api/v1/conversations/${conversationId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
  },

  // Add method to call API for delete
  async deleteConversation(conversationId) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;
    await fetch(`/api/v1/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  // Add message delete logic
  async deleteMessageAndAfter(messageIndex) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) return;
    const messages = Array.from(chatDisplay.children);
    if (messageIndex < 0 || messageIndex >= messages.length) {
      console.error('Invalid message index for deletion:', messageIndex);
      return;
    }

    const targetMessageElement = messages[messageIndex];
    if (!targetMessageElement) {
        console.error('Target message element not found at index:', messageIndex);
        return;
    }

    // --- Use messageId from the element for the API call ---
    const messageIdToDelete = targetMessageElement.dataset.messageId;
    if (!messageIdToDelete) {
      alert('Cannot delete message: Missing message ID on the element.');
      console.error('Message element at index', messageIndex, 'is missing data-message-id attribute.');
      return;
    }

    // --- Check if the target is an AI message and get preceding prompt if so ---
    let promptForRegeneration = null;
    const isAIMessage = targetMessageElement.classList.contains('ai-message');

    if (isAIMessage && messageIndex > 0) {
        const precedingUserElement = messages[messageIndex - 1];

        if (precedingUserElement) {
             if (precedingUserElement.classList.contains('user-message')) {
                 let contentElement = precedingUserElement.querySelector('.markdown-content');
                 if (contentElement) {
                     promptForRegeneration = contentElement.textContent || contentElement.innerText;
                 } else {
                      promptForRegeneration = precedingUserElement.textContent || precedingUserElement.innerText;
                      if (promptForRegeneration) {
                          promptForRegeneration = promptForRegeneration.replace(/^User\s*/, '').trim();
                      }
                 }
             }
        }
    }
    // --- End Check ---

    const conversationId = this.currentConversationId;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    if (!token || !conversationId) {
      alert('Cannot delete message: Missing authentication or conversation context.');
      return;
    }

    try {
        const response = await fetch(`/api/v1/conversations/${conversationId}/messages/${messageIdToDelete}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete message: ${response.status} ${errorText}`);
        }

        // --- Remove messages from UI ---
        const messagesToRemove = Array.from(chatDisplay.children).slice(messageIndex);
        messagesToRemove.forEach(msg => msg.remove());

        // --- Trigger Regeneration if applicable ---
        if (promptForRegeneration && promptForRegeneration.length > 0) {
            const textareaElement = document.getElementById('ai-prompt-input');
            const newAiMessageDiv = renderAIPlaceholder(chatDisplay);
            if (typeof this.handleAPISubmission === 'function') {
                 this.handleAPISubmission(promptForRegeneration, newAiMessageDiv, textareaElement);
            } else {
                 console.error('[Chat][Delete] handleAPISubmission function not found on ChatManager.');
                 renderChatError('Failed to start regeneration.', chatDisplay);
            }
        }
        // --- End Trigger Regeneration ---

    } catch (error) {
        console.error('Error deleting message:', error);
        alert(`Error deleting message: ${error.message}`);
    }
  },

  /**
   * Toggle fullscreen UI and sidebar visibility.
   */
  toggleFullscreenUI(isFullscreen) {
    const body = document.body;
    const sidebar = document.getElementById('chat-fullscreen-sidebar'); // Sidebar element

    if (isFullscreen) {
      console.log('[FS Toggle] Entering Fullscreen');
      body.classList.add('chat-fullscreen-active');
      // Remove d-none class - CSS will handle display based on body class
      if (sidebar && sidebar.classList.contains('d-none')) {
          sidebar.classList.remove('d-none');
      }
      this.renderSidebarConversations(); // Render sidebar content

       setTimeout(() => {
            const promptInput = document.getElementById('ai-prompt-input');
            if (promptInput) setTextareaHeight(promptInput);
            scrollToBottom('ai-result-output', false);
          }, 50); // Delay helps with rendering layout changes

    } else {
      console.log('[FS Toggle] Exiting Fullscreen');
      body.classList.remove('chat-fullscreen-active');
      // IMPORTANT: Add d-none back to hide sidebar when NOT fullscreen
      // This ensures it's hidden correctly if CSS doesn't handle it alone
      if (sidebar && !sidebar.classList.contains('d-none')) {
          sidebar.classList.add('d-none');
      }

       setTimeout(() => {
           const promptInput = document.getElementById('ai-prompt-input');
           if (promptInput) setTextareaHeight(promptInput);
           // scrollToBottom('ai-result-output', false); // Scrolling usually not needed when exiting
       }, 50);
    }

    // Update zoom button icon AFTER changing body class
    const zoomButton = document.getElementById('chat-zoom-toggle');
    if (zoomButton) {
        const icon = zoomButton.querySelector('i');
        if(icon) {
             icon.className = isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';
        }
    }
  },

  /**
   * Set up all event listeners for chat UI.
   */
  setupEventListeners() {
    document.addEventListener('DOMContentLoaded', () => {
      const chatForm = document.getElementById('ai-generation-form');
      const zoomButton = document.getElementById('chat-zoom-toggle');
      const promptInput = document.getElementById('ai-prompt-input');

      // --- Prompt Input Listeners ---
      if (promptInput) {
        promptInput.addEventListener('input', () => {
          setTextareaHeight(promptInput, true);
        });
        promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
        setTextareaHeight(promptInput); // Initial height check
        promptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const generateButton = document.getElementById('ai-generate-button');
            if (generateButton && !generateButton.disabled) {
              // Find the form and submit it programmatically
              // This is often more reliable than clicking the button
              const form = promptInput.closest('form');
              if (form) {
                  form.requestSubmit(); // Modern way to submit form via JS
              }
            }
          }
        });
      }

      // --- Zoom Button Listener ---
      if (zoomButton) {
        // Keep track of fullscreen state *outside* the listener
        // Initialize based on current body class state (in case of refresh)
        let currentFullscreenState = document.body.classList.contains('chat-fullscreen-active');

        zoomButton.addEventListener('click', () => {
          // Toggle the state
          currentFullscreenState = !currentFullscreenState;
          console.log('[Zoom Click] Toggling fullscreen. New state:', currentFullscreenState);
          // Call the UI toggle function with the NEW state
          ChatManager.toggleFullscreenUI(currentFullscreenState);
        });
      }

      // --- Chat Form Listener ---
      if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const currentPromptInput = document.getElementById('ai-prompt-input');
          const chatDisplay = document.getElementById('chat-message-list');
          const currentGenerateButton = document.getElementById('ai-generate-button');
          const currentLoadingIndicator = document.getElementById('ai-loading-indicator');
          if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
            console.error("Chat form submit: Missing required elements.");
            return;
          }
          const userMessage = currentPromptInput.value.trim();
          if (!userMessage) {
            return; // Don't submit empty messages
          }
          currentPromptInput.disabled = true;
          currentGenerateButton.disabled = true;
          currentLoadingIndicator.style.display = 'inline-block';
          removeInitialPrompt(chatDisplay);
          renderMessage('user', userMessage, chatDisplay);
          const aiDiv = renderAIPlaceholder(chatDisplay);
          scrollToBottom('ai-result-output', false); // Scroll user msg into view
          ChatManager.handleAPISubmission(userMessage, aiDiv, currentPromptInput);
        });
      }
       console.log("[Chat Events] All chat event listeners setup completed.");
    });
  },
  /**
   * Helper function to add a delete button and its listener to a message element.
   * @param {HTMLElement} messageDiv The message div element.
   * @param {number} index The index of this message in the chat list.
   */
  addDeleteButtonAndListener(messageDiv, index) {
    console.log(`[Chat][addDeleteButton] Called for index ${index}. Target div:`, messageDiv); // Log entry
    if (!messageDiv) {
        console.warn(`[Chat][addDeleteButton] Skipping for index ${index}: Target div is null or undefined.`);
        return;
    }
    if (messageDiv.querySelector('.message-delete-btn')) {
      console.log(`[Chat][addDeleteButton] Skipping for index ${index}: Button already exists.`); // Log skip reason
      return;
    }
    if (typeof this.deleteMessageAndAfter !== 'function') {
        console.error("[Chat][addDeleteButton] deleteMessageAndAfter function not found on ChatManager");
        return;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn';
    deleteBtn.title = 'Delete from here';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent potential parent handlers
      if (confirm('Delete this message and all after?')) {
        // Bind 'this' to ChatManager when calling the method
        this.deleteMessageAndAfter(index);
      }
    });

    // Append the button. Find a suitable place, e.g., after the content or sender label.
    // Appending directly to the messageDiv might be simplest visually.
    messageDiv.appendChild(deleteBtn); // Append at the end of the div's content
    console.log(`[Chat][addDeleteButton] Successfully appended delete button to message at index ${index}`); // Log success
  }, // <--- Ensure comma exists
  };

window.ChatManager = ChatManager;
window.initializeChat = () => ChatManager.initializeChat();

ChatManager.setupEventListeners();

