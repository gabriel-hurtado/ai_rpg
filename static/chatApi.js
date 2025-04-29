// chatApi.js - Handles chat-related API requests

/**
 * Fetch the user's conversations list.
 * 
 * @param {string} token - The user's authentication token.
 * @returns {Promise<object>} A promise resolving to the user's conversations list.
 */
export async function fetchConversations(token) {
  const response = await fetch('/api/v1/conversations', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

/**
 * Fetch a specific conversation by ID.
 * 
 * @param {string} conversationId - The ID of the conversation to fetch.
 * @param {string} token - The user's authentication token.
 * @returns {Promise<object>} A promise resolving to the conversation data.
 */
export async function fetchConversationById(conversationId, token) {
  const response = await fetch(`/api/v1/conversations/${conversationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

/**
 * Send a chat message and return the fetch Response (for streaming).
 * 
 * @param {object} options - Options for sending the chat message.
 * @param {string} options.prompt - The message to send.
 * @param {string} [options.conversationId] - The ID of the conversation to send the message to.
 * @param {string} options.token - The user's authentication token.
 * @returns {Promise<Response>} A promise resolving to the fetch Response.
 */
export async function sendChatMessage({ prompt, conversationId, token }) {
  const formData = new FormData();
  formData.append('prompt', prompt);

  if (conversationId) {
    formData.append('conversation_id', conversationId);
  }

  return fetch('/api/v1/chat/message', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
}
