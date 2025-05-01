// static/chat.js

// static/chat.js
let allowClassToggle = true; // Global flag

// Assuming chatUtils.js, chatUI.js, chatApi.js are correctly imported or available
// Make sure imports point to the correct helper files if they exist separately
import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';

// --- Constants for Zoom Buttons (Used within ChatManager) ---
const CHAT_ZOOM_TOGGLE_NORMAL_ID = 'chat-zoom-toggle-normal';
const CHAT_ZOOM_TOGGLE_FULLSCREEN_ID = 'chat-zoom-toggle-fullscreen';

/**
 * ChatManager orchestrates chat state, event wiring, and uses modular helpers for UI and API.
 */
const ChatManager = {
  currentConversationId: null,
  chatInitialized: false,
  // Keep track of fullscreen state internally within ChatManager
  isFullscreenActive: false,
  contextModalInstance: null, 

  /**
   * Load the user's latest conversation or show the new conversation prompt.
   */
  async loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
      console.error('[Chat] loadLatestConversation: chat-message-list not found.');
      return;
    }
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay); // Assumes renderChatError is available
      return;
    }
    try {
      const data = await fetchConversations(token); // Assumes fetchConversations is available
      if (Array.isArray(data) && data.length > 0) {
        const latestConv = data[0];
        console.log('[Chat] Found latest conversation:', latestConv.id);
        this.currentConversationId = latestConv.id;
        await this.loadAndDisplayConversation(latestConv.id);
      } else {
        console.log('[Chat] No existing conversations found, loading empty state.');
        await this.loadAndDisplayConversation(null); // Load empty/initial state
      }
    } catch (e) {
      console.error('[Chat] Error processing conversations:', e);
      renderChatError('Error processing conversations.', chatDisplay);
      await this.loadAndDisplayConversation(null); // Load empty/initial state on error
    }
  },

   /**
   * Load and display a specific conversation by ID, or initial state if ID is null.
   * MODIFIED: Show/hide modify context button and update active context display.
   */
   async loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    const modifyContextControls = document.getElementById('chat-context-controls'); // Get controls div
    const activeContextDisplay = document.getElementById('active-context-display'); // Get display area

    if (!chatDisplay) {
        console.error('[Chat] loadAndDisplayConversation: chat-message-list not found.');
        return;
    }
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';

    // Hide controls and clear context display initially
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    if (!conversationId) {
        console.log('[Chat] loadAndDisplayConversation: No conversation ID, displaying initial prompt.');
        this.currentConversationId = null;
        chatDisplay.innerHTML = '';
        removeInitialPrompt(chatDisplay);
        renderMessage('ai', 'Welcome! Start a New Chat (+) to set up your adventure context or select an existing one.', chatDisplay);
        scrollToBottom('ai-result-output', false);
        return; // Exit early
    }

    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      return;
    }

    try {
      console.log(`[Chat] Fetching conversation ID: ${conversationId}`);
      const data = await fetchConversationById(conversationId, token);
      chatDisplay.innerHTML = '';
      removeInitialPrompt(chatDisplay);

      const conversation = data.conversation; // Extract conversation details
      const messages = data.messages;       // Extract messages

      if (!conversation) {
          throw new Error("Conversation data missing in API response.");
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        console.warn('[Chat] Conversation loaded but has no messages:', conversationId);
        renderMessage('ai', 'This conversation is empty. Start typing!', chatDisplay);
      } else {
        console.log(`[Chat] Rendering ${messages.length} messages for conversation ${conversationId}`);
        messages.forEach((msg, idx) => {
          renderMessage(
            msg.role === 'user' ? 'user' : 'ai',
            msg.content,
            chatDisplay,
            msg.id || `temp-${idx}`,
            async (deleteIdx) => {
              if (confirm('Delete this message and all after?')) {
                await ChatManager.deleteMessageAndAfter(deleteIdx);
              }
            },
            idx
          );
        });
      }
      this.currentConversationId = conversationId;
      console.log('[Chat] Successfully loaded conversation:', conversationId);

      this.updateActiveContextDisplay(conversation.context); // Update display
      if (modifyContextControls) modifyContextControls.style.display = 'flex'; // Show button

      // --- Context Display Update ---
      if (conversation.context) {
           this.updateActiveContextDisplay(conversation.context); // Update display with loaded context
      } else {
           if(activeContextDisplay) activeContextDisplay.innerHTML = '<span class="text-muted small">No specific context set.</span>'; // Default if no context
      }
      if (modifyContextControls) modifyContextControls.style.display = 'flex'; // Show modify button


    } catch (e) {
      console.error(`[Chat] Error loading conversation ${conversationId}:`, e);
      renderChatError(`Error loading conversation: ${e.message}`, chatDisplay);
      this.currentConversationId = null;
       if (modifyContextControls) modifyContextControls.style.display = 'none'; // Hide on error
       if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    }
    setTimeout(() => scrollToBottom('ai-result-output', false), 50);
  },

  /**
   * Handle user message submission and display streaming AI response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let success = false;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    const userMessageElement = aiMessageDiv ? aiMessageDiv.previousElementSibling : null; // Get user message element BEFORE API call

    if (!token) {
      if (aiMessageDiv) {
        aiMessageDiv.innerHTML = '<span class="text-danger">Error: Not logged in.</span>';
      } else {
        console.error('[Chat][handleAPISubmission] Cannot display error: aiMessageDiv is missing.');
      }
      // Re-enable inputs immediately if not logged in
      if (textareaElement) textareaElement.disabled = false;
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      return;
    }
    try {
      const response = await sendChatMessage({ prompt: userMessage, conversationId: this.currentConversationId, token }); // Assumes sendChatMessage is available

      if (!response.ok) {
          let errorText = `API Error ${response.status}`;
          try {
              const errorData = await response.json();
              errorText = errorData.detail || errorText;
          } catch (e) { /* Ignore if response is not JSON */ }
          console.error('[Chat][handleAPISubmission] API response not OK:', response.status, errorText);
          throw new Error(errorText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = '';
      const markdownDiv = aiMessageDiv.querySelector('.markdown-content'); // Target the inner div for markdown

      if (!markdownDiv) {
          console.error('[Chat][handleAPISubmission] Markdown display area (.markdown-content) not found in aiMessageDiv.');
          throw new Error('Internal UI Error: Markdown display area not found.');
      }

      let finalPayload = null; // Store the payload when found

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunk = decoder.decode(value, { stream: true });

        // --- Efficient Payload Check ---
        const jsonMarker = '"userMessageId":';
        const potentialJsonStart = chunk.lastIndexOf(jsonMarker);

        if (potentialJsonStart !== -1 && chunk.trim().endsWith('}')) {
            const jsonStringCandidate = chunk.substring(potentialJsonStart - 1); // Include the opening '{'
            try {
                const parsed = JSON.parse(jsonStringCandidate);
                if (parsed.userMessageId && parsed.aiMessageId) {
                    finalPayload = parsed;
                    chunk = chunk.substring(0, potentialJsonStart - 1);
                }
            } catch (e) { /* Ignore parse error, treat as text */ }
        }
        // --- End Payload Check ---

        if (chunk) {
             aiResponseContent += chunk;
             markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
             scrollToBottom('ai-result-output', true);
        }
        if (finalPayload) break; // Exit loop once payload is found

      } // End while loop

      // --- Process Final Payload ---
      if (finalPayload) {
          console.log('[Chat] Processing final message IDs:', finalPayload);
          if (aiMessageDiv) aiMessageDiv.dataset.messageId = finalPayload.aiMessageId;
          if (userMessageElement) {
               userMessageElement.dataset.messageId = finalPayload.userMessageId;
               console.log(`[Chat] Set user message element ID (via previousElementSibling) to ${finalPayload.userMessageId}`);
          } else {
               console.warn(`[Chat] Could not find user message element (via previousElementSibling) to set ID ${finalPayload.userMessageId}`);
               // Fallback search in DOM
               const messages = document.getElementById('chat-message-list')?.children;
               if (messages && messages.length >= 2) {
                   const potentialUserMsg = messages[messages.length - 2];
                   if (potentialUserMsg && potentialUserMsg.classList.contains('user-message') && !potentialUserMsg.dataset.messageId) {
                       potentialUserMsg.dataset.messageId = finalPayload.userMessageId;
                       console.log(`[Chat] Set user message element ID (fallback DOM search) to ${finalPayload.userMessageId}`);
                   }
               }
          }
          // Add Delete Buttons
          const chatDisplay = document.getElementById('chat-message-list');
          if (chatDisplay) {
              const messages = chatDisplay.children;
              const aiMessageIndex = messages.length - 1;
              const userMessageIndex = messages.length - 2;
              if (aiMessageIndex >= 0 && messages[aiMessageIndex] === aiMessageDiv) {
                  this.addDeleteButtonAndListener(aiMessageDiv, aiMessageIndex);
              }
              if (userMessageIndex >= 0) {
                  const userMsgDiv = messages[userMessageIndex];
                  if (userMsgDiv && userMsgDiv.classList.contains('user-message') && userMsgDiv.dataset.messageId === finalPayload.userMessageId) {
                      this.addDeleteButtonAndListener(userMsgDiv, userMessageIndex);
                  }
              }
          }
      } else {
          console.warn('[Chat] Stream finished but no final payload with IDs received.');
      }
      // --- End Process Final Payload ---

       if (markdownDiv) { // Final render pass
            markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
       }

      await this.fetchAndUpdateCreditsDisplay();
      success = true;
      if (textareaElement) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }
      scrollToBottom('ai-result-output', true); // Final scroll

    } catch (error) {
      console.error('[Chat][handleAPISubmission] Error during API call or streaming:', error);
      if (aiMessageDiv) {
        const errorDisplayTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorDisplayTarget.innerHTML = `<span class="text-danger">Error: ${escapeHtml(error.message)}</span>`;
      }
      scrollToBottom('ai-result-output', true);
    } finally {
      // Always re-enable inputs and hide loading indicator
      if (textareaElement) textareaElement.disabled = false;
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
       if (textareaElement) setTextareaHeight(textareaElement);
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
        const credits = data.credits !== null && data.credits !== undefined ? data.credits : '--';
        const navbarCredits = document.getElementById('navbar-user-credits'); // Use constant if available
        if (navbarCredits) navbarCredits.textContent = `Credits: ${credits}`;
        if (window.currentUserInfo && window.currentUserInfo.dbUserData) {
             window.currentUserInfo.dbUserData.credits = data.credits;
             // console.log('[Chat] Updated global credits state:', window.currentUserInfo.dbUserData.credits); // Verbose log
        }
      } else {
          console.warn('[Chat] Failed to fetch updated credits, status:', resp.status);
      }
    } catch (e) {
      console.error('[Chat] Network error fetching updated credits:', e);
    }
  },

  /**
   * Initialize the chat (load latest conversation, set flag).
   */

_performFullscreenToggle() {
  // Check the global flag
  if (!allowClassToggle) {
      console.warn("[Chat Toggle] Debounced/Blocked duplicate toggle call.");
      return; // Prevent rapid re-toggling if something is firing multiple events
  }
  allowClassToggle = false; // Block subsequent calls temporarily
  console.log("[Chat Toggle] Entered performFullscreenToggle (Blocking further calls)");


  const body = document.body;
  const sidebar = document.getElementById('chat-fullscreen-sidebar');
  const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
  const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

  // --- Log state BEFORE modification attempt ---
  console.log(`[Chat Toggle Debug] State BEFORE toggle logic: isFullscreenActive=${this.isFullscreenActive}, Normal has d-none? ${normalZoomBtn?.classList.contains('d-none')}, Fullscreen has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);


  // Toggle the internal state
  this.isFullscreenActive = !this.isFullscreenActive;
  const isFullscreen = this.isFullscreenActive; // Use the new state

  console.log(`[Chat Toggle] Setting internal fullscreen state to: ${isFullscreen}`);

  // Toggle body class
  body.classList.toggle('chat-fullscreen-active', isFullscreen);

  // Toggle sidebar panel visibility
  if (sidebar) {
      sidebar.classList.toggle('d-none', !isFullscreen);
  } else { console.warn('[Chat Toggle] Sidebar element not found.'); }

  // Toggle button visibility
  if (normalZoomBtn) normalZoomBtn.classList.toggle('d-none', isFullscreen);
  if (fullscreenZoomBtn) fullscreenZoomBtn.classList.toggle('d-none', !isFullscreen);

   // --- Log state AFTER modification attempt ---
  console.log(`[Chat Toggle Debug] State AFTER toggle logic: isFullscreenActive=${this.isFullscreenActive}, Normal has d-none? ${normalZoomBtn?.classList.contains('d-none')}, Fullscreen has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);


  // Actions specific to entering/exiting fullscreen
  if (isFullscreen) {
    this.renderSidebarConversations();
  }

  // Adjust layout elements slightly after state change
  setTimeout(() => {
      const promptInput = document.getElementById('ai-prompt-input');
      if (promptInput) setTextareaHeight(promptInput, true);
      if (isFullscreen) scrollToBottom('ai-result-output', false);
      // Re-allow toggling after a short delay
      allowClassToggle = true;
      console.log("[Chat Toggle] Re-enabled toggling.");
  }, 150); // Increased delay slightly for debounce
},

  // static/chat.js (Inside ChatManager object)

  /** Syncs UI element visibility (buttons, sidebar) with the current internal fullscreen state. Useful on init. */
  _syncUIWithState() {
    const isFullscreen = this.isFullscreenActive; // Use the current state determined in initializeChat
    console.log('[Chat Sync] Syncing UI with internal fullscreen state:', isFullscreen);
    const body = document.body;
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
    const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

    // Apply body class FIRST
    body.classList.toggle('chat-fullscreen-active', isFullscreen);

    // --- Explicitly set visibility based on state ---
    if (sidebar) {
        if (isFullscreen) {
            sidebar.classList.remove('d-none'); // Ensure visible
            this.renderSidebarConversations(); // Render content if entering fullscreen
        } else {
            sidebar.classList.add('d-none'); // Ensure hidden
        }
    }
    if (normalZoomBtn) {
        if (isFullscreen) {
            normalZoomBtn.classList.add('d-none'); // Ensure hidden
        } else {
            normalZoomBtn.classList.remove('d-none'); // Ensure visible
        }
    }
    if (fullscreenZoomBtn) {
        if (isFullscreen) {
            fullscreenZoomBtn.classList.remove('d-none'); // Ensure visible
        } else {
            fullscreenZoomBtn.classList.add('d-none'); // Ensure hidden
        }
    }

    console.log(`[Chat Sync] After sync: Normal btn has d-none? ${normalZoomBtn?.classList.contains('d-none')}. Fullscreen btn has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);

  }, // End _syncUIWithState

  /**
   * Initiates the setup process for a NEW chat context.
   * Clears current state and loads the first step into the modal.
   */
  async startNewChatContextSetup() {
    console.log('[Chat Context] Starting NEW context setup.');
    this.currentConversationId = null; // Signal it's a new chat

    const chatDisplay = document.getElementById('chat-message-list');
    const modifyContextControls = document.getElementById('chat-context-controls');
    const activeContextDisplay = document.getElementById('active-context-display');
    const modalContentArea = document.getElementById('modal-content-area');
    const modalElement = document.getElementById('contextModal');
    const sidebarList = document.getElementById('conversation-list'); // To remove 'active' class

    // Clear UI elements related to current chat
    if (chatDisplay) chatDisplay.innerHTML = '<p class="text-muted small text-center">Setting up new adventure context...</p>';
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    if (sidebarList) { // Deactivate sidebar item
      sidebarList.querySelectorAll('li.active').forEach(li => li.classList.remove('active'));
  }

    if (!modalContentArea || !modalElement) {
        console.error('[Chat Context] Modal content area or modal element not found!');
        alert('Error: Cannot open context setup.');
        return;
    }

    // Show loading state in modal
    modalContentArea.innerHTML = `
        <div class="text-center p-5">
            <div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>
            <p class="mt-2 text-muted small">Loading Setup...</p>
        </div>`;

    // Get modal instance (cache it if not already done)
    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    // Note: data-bs-toggle on the button will show the modal, we just load content.

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required to set context.</div>`;
        return;
    }

    try {
        if (window.htmx) {
             console.log('[Chat Context] Triggering HTMX GET for /api/v1/chat/setup/start');
             // Use htmx.ajax to manually trigger request and swap
             htmx.ajax('GET', '/api/v1/chat/setup/start', {
                 target: '#modal-content-area',
                 swap: 'innerHTML',
                 headers: { 'Authorization': `Bearer ${token}` }
             });
        } else {
            throw new Error("HTMX library not found.");
        }
    } catch (error) {
        console.error('[Chat Context] Error fetching start fragment:', error);
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Failed to load setup. Please try again.</div>`;
    }
  },

  /**
   * Initiates editing for the CURRENT chat context via modal.
   */
  async editCurrentChatContext() {
    console.log('[Chat Context] Starting EDIT context setup for conversation:', this.currentConversationId);
    if (!this.currentConversationId) {
        alert('No active chat selected to edit context for.');
        return;
    }

    const modalContentArea = document.getElementById('modal-content-area');
    const modalElement = document.getElementById('contextModal');

    if (!modalContentArea || !modalElement) {
        alert('Error: Cannot open context setup.');
        return;
    }

    // Show loading state
    modalContentArea.innerHTML = `<div class="text-center p-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted small">Loading Existing Context...</p></div>`;

    // Get/cache modal instance
    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    // Bootstrap attributes handle showing modal

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required.</div>`;
        return;
    }

    try {
         if (window.htmx) {
             console.log(`[Chat Context] Triggering HTMX GET for /api/v1/chat/setup/edit/${this.currentConversationId}`);
             htmx.ajax('GET', `/api/v1/chat/setup/edit/${this.currentConversationId}`, {
                 target: '#modal-content-area',
                 swap: 'innerHTML',
                 headers: { 'Authorization': `Bearer ${token}` }
             });
         } else {
            throw new Error("HTMX library not found.");
         }
    } catch (error) {
        console.error('[Chat Context] Error fetching edit fragment:', error);
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Failed to load context for editing.</div>`;
    }
  },

   /**
    * Updates the display area below the chat input with context badges.
    * @param {object} contextData The context object from the backend.
    */
   updateActiveContextDisplay(contextData) {
       const displayArea = document.getElementById('active-context-display');
       if (!displayArea) return;
       console.log("[Chat Context] Updating context display with:", contextData);

       displayArea.innerHTML = ''; // Clear previous

       if (!contextData || Object.keys(contextData).length === 0) {
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Default Context</span>';
           return;
       }

       const badges = [];
       const displayMap = { // Customize labels/icons/order
           goal: { label: "Goal", icon: "bi-bullseye" },
           genre_tone: { label: "Genre/Tone", icon: "bi-masks" },
           game_system: { label: "System", icon: "bi-dpad-fill" },
           key_details: { label: "Details", icon: "bi-info-circle", truncate: 30 } // Optional truncation
       };

       for (const key in displayMap) {
           if (contextData[key]) {
               let value = contextData[key];
               const config = displayMap[key];
               // Simple formatting for goal
               if (key === 'goal') value = value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
               // Truncate if needed
               const titleAttr = config.truncate && value.length > config.truncate ? `title="${escapeHtml(value)}"` : '';
               if (config.truncate && value.length > config.truncate) {
                   value = value.substring(0, config.truncate - 3) + "...";
               }
               badges.push(`<span class="badge lh-base text-bg-secondary bg-opacity-25 me-1 mb-1" ${titleAttr}><i class="bi ${config.icon} me-1"></i>${escapeHtml(value)}</span>`);
           }
       }

       if (badges.length > 0) {
           displayArea.innerHTML = badges.join('');
       } else {
           // If contextData exists but has no *displayable* keys
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Context Set (No Preview)</span>';
       }
   },



  /**
   * Set up all event listeners for chat UI elements.
   */
  setupEventListeners() {
    document.addEventListener('DOMContentLoaded', () => {
      console.log("[Chat Events] DOMContentLoaded - Setting up chat event listeners.");
      const chatForm = document.getElementById('ai-generation-form');
      const promptInput = document.getElementById('ai-prompt-input');
      const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
      const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);
      const newChatButton = document.getElementById('new-conversation-btn');
      const modifyContextButton = document.getElementById('modify-context-button');

      // --- Prompt Input Listeners ---
      if (promptInput) {
        // console.log("[Chat Events] Setting up prompt input listeners."); // Verbose
        promptInput.addEventListener('input', () => setTextareaHeight(promptInput, true));
        promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
        setTextareaHeight(promptInput); // Initial height check
        promptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const generateButton = document.getElementById('ai-generate-button');
            if (generateButton && !generateButton.disabled) {
              const form = promptInput.closest('form');
              if (form) {
                  // console.log("[Chat Events] Enter pressed, submitting form."); // Verbose
                  form.requestSubmit();
              } else { console.warn("[Chat Events] Enter pressed, but couldn't find parent form."); }
            } // else { console.log("[Chat Events] Enter pressed, but generate button is disabled."); } // Verbose
          }
        });
      } else { console.warn("[Chat Events] Prompt input element not found."); }

      // --- Zoom Button Listeners (Using Arrow Function for 'this') ---
      if (normalZoomBtn) {
           console.log('[Chat Events] Adding listener to normal zoom button.');
           // Use arrow function to ensure 'this' refers to ChatManager
           normalZoomBtn.addEventListener('click', () => {
               console.log("[Chat Events] Normal zoom clicked.");
               this._performFullscreenToggle(); // 'this' should be ChatManager here
           });
      } else { console.warn(`[Chat Events] Normal zoom button #${CHAT_ZOOM_TOGGLE_NORMAL_ID} not found.`); }

      if (fullscreenZoomBtn) {
           console.log('[Chat Events] Adding listener to fullscreen zoom button.');
           // Use arrow function to ensure 'this' refers to ChatManager
           fullscreenZoomBtn.addEventListener('click', () => {
                console.log("[Chat Events] Fullscreen zoom clicked.");
               this._performFullscreenToggle(); // 'this' should be ChatManager here
           });
      } else { console.warn(`[Chat Events] Fullscreen zoom button #${CHAT_ZOOM_TOGGLE_FULLSCREEN_ID} not found.`); }


      // --- Chat Form Submit Listener ---
      if (chatForm) {
        // console.log("[Chat Events] Setting up chat form submit listener."); // Verbose
        // Use arrow function here too for consistency, though not strictly needed if not using 'this'
        chatForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          // console.log("[Chat Events] Chat form submitted."); // Verbose
          const currentPromptInput = document.getElementById('ai-prompt-input');
          const chatDisplay = document.getElementById('chat-message-list');
          const currentGenerateButton = document.getElementById('ai-generate-button');
          const currentLoadingIndicator = document.getElementById('ai-loading-indicator');
          if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
            console.error("[Chat Events] Form submit: Missing required elements.");
            return;
          }
          const userMessage = currentPromptInput.value.trim();
          if (!userMessage) {
            // console.log("[Chat Events] Form submit: Empty message, ignoring."); // Verbose
            return;
          }
          currentPromptInput.disabled = true;
          currentGenerateButton.disabled = true;
          currentLoadingIndicator.style.display = 'inline-block';
          removeInitialPrompt(chatDisplay);
          renderMessage('user', userMessage, chatDisplay, null, async (deleteIdx) => {
            if (confirm('Delete this message and all after?')) {
              await ChatManager.deleteMessageAndAfter(deleteIdx);
            }
          });
          const aiDiv = renderAIPlaceholder(chatDisplay);
          scrollToBottom('ai-result-output', false);
          ChatManager.handleAPISubmission(userMessage, aiDiv, currentPromptInput);
          });
      } else { console.warn("[Chat Events] Chat form element not found."); }

      // --- NEW: HTMX Event Listeners (for modal save response) ---
      console.log("[Chat Events] Setting up HTMX response listeners.");
      document.body.addEventListener('htmx:afterOnLoad', (event) => {
          // General listener, check if response came from our save endpoint
          const xhr = event.detail.xhr;
          if (xhr && xhr.responseURL && xhr.responseURL.includes('/api/v1/chat/setup/save')) {
              console.log('[Chat HTMX] Detected response likely from /save endpoint.');
              // Check for custom triggers in the response headers
              const triggerHeader = xhr.getResponseHeader('HX-Trigger');
              if (triggerHeader) {
                  console.log('[Chat HTMX] Found HX-Trigger header:', triggerHeader);
                  try {
                      const triggers = JSON.parse(triggerHeader);
                      if (triggers.newChatCreated) {
                        console.log('[Chat HTMX] Handling newChatCreated trigger:', triggers.newChatCreated);
                        const { id, title, context } = triggers.newChatCreated;
                        if (ChatManager.contextModalInstance) ChatManager.contextModalInstance.hide(); // Hide modal first
                        ChatManager.currentConversationId = id; // Set the new ID
                        ChatManager.renderSidebarConversations(); // Refresh sidebar
                        // Load empty state BUT ensure context display/modify button shown
                        const chatDisplay = document.getElementById('chat-message-list');
                        if(chatDisplay) chatDisplay.innerHTML = ''; // Clear loading/setup message
                        renderMessage('ai', `Context set for "${escapeHtml(title)}". What's your first prompt?`, chatDisplay);
                        ChatManager.updateActiveContextDisplay(context); // Show context badges
                        const modifyBtn = document.getElementById('chat-context-controls');
                        if(modifyBtn) modifyBtn.style.display = 'flex'; // Show modify button
                        scrollToBottom('ai-result-output', false);
                        // Maybe focus input?
                        document.getElementById('ai-prompt-input')?.focus();

                    // --- Handle chatContextUpdated ---
                    } else if (triggers.chatContextUpdated) {
                        console.log('[Chat HTMX] Handling chatContextUpdated trigger:', triggers.chatContextUpdated);
                        const { id, context } = triggers.chatContextUpdated;
                        if (ChatManager.contextModalInstance) ChatManager.contextModalInstance.hide(); // Hide modal
                        // Only update context display if it matches current chat
                         if (id === ChatManager.currentConversationId) {
                              ChatManager.updateActiveContextDisplay(context);
                              // Optional: Show a success toast/message
                              console.log(`[Chat Context] Context updated for conversation ${id}`);
                         }
                    }
                } catch (e) {
                    console.error('[Chat HTMX] Error parsing HX-Trigger JSON:', e);
                     if (ChatManager.contextModalInstance) ChatManager.contextModalInstance.hide(); // Hide modal on error too
                }
            } else {
                 console.warn('[Chat HTMX] Response from /save (204) but no HX-Trigger header found.');
                 // Close modal as a fallback on successful save
                 if (ChatManager.contextModalInstance) ChatManager.contextModalInstance.hide();
            }
        } // End check for /save endpoint
    }); // End htmx:afterOnLoad listener

      console.log("[Chat Events] All event listeners setup completed.");
    }); // End DOMContentLoaded
  }, // End setupEventListeners

  /**
   * Helper function to add a delete button and its listener to a message element.
   * Ensures button isn't added twice.
   * @param {HTMLElement} messageDiv The message div element.
   * @param {number} index The index of this message in the chat list.
   */
   addDeleteButtonAndListener(messageDiv, index) {
    if (!messageDiv) {
      console.warn(`[Chat][addDeleteButton] Skipping for index ${index}: Target div is null.`);
      return;
    }
    if (messageDiv.querySelector('.message-delete-btn')) {
      // console.log(`[Chat][addDeleteButton] Skipping for index ${index}: Delete button already exists.`);
      return;
    }
    if (typeof this.deleteMessageAndAfter !== 'function') {
      console.error("[Chat][addDeleteButton] deleteMessageAndAfter function not found on ChatManager");
      return;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn';
    deleteBtn.title = 'Delete message and all subsequent messages';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.type = 'button';

    // Ensure 'this' context is correct using an arrow function for the listener
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this message and all messages that follow? This cannot be undone.')) {
        // 'this' inside arrow function refers to ChatManager instance
        this.deleteMessageAndAfter(index).catch(error => {
             console.error(`[Chat][Delete] Error during deleteMessageAndAfter execution for index ${index}:`, error);
             alert("An error occurred while trying to delete the message.");
        });
      }
    });
    messageDiv.appendChild(deleteBtn);
    // console.log(`[Chat][addDeleteButton] Successfully appended delete button to message at index ${index}`);
  },

}; // End ChatManager Object

// Expose ChatManager and initialization function to the global scope
window.ChatManager = ChatManager;
window.initializeChat = () => ChatManager.initializeChat();

// Set up event listeners defined within ChatManager
ChatManager.setupEventListeners();

// export default ChatManager; // Uncomment if using ES modules elsewhere
