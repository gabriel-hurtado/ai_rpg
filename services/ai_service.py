import os
import logging
import google.generativeai as genai
from google.generativeai.types import GenerationConfig

logger = logging.getLogger(__name__)

# --- System Prompt ---
SYSTEM_PROMPT = """You are a creative assistant for generating Tabletop Roleplaying Game (TTRPG) content.\nYour goal is to help Game Masters (GMs) build their unique homebrew worlds.\nGenerate imaginative and useful content like locations, non-player characters (NPCs) with motivations,\nmagic items with history, monsters with unique abilities, or plot hooks.\nBe descriptive and provide details that a GM can use in their game.\nMaintain a helpful and inspiring tone. Avoid clichés where possible unless requested."""

# --- Google AI Configuration ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model = None

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        ai_model = genai.GenerativeModel(
            model_name='gemini-1.5-flash-latest',
            system_instruction=SYSTEM_PROMPT,
            # generation_config=GenerationConfig(...) # Optional: configure temp, top_k etc.
        )
        google_ai_configured = True
        logger.info(f"Google AI Client Configured successfully with model: {ai_model.model_name}")
    except Exception as e:
        logger.error(f"Failed to configure Google AI: {e}", exc_info=True)
else:
    logger.warning("GOOGLE_API_KEY not found. AI features disabled.")

# --- Google AI Streaming Helper ---
async def call_google_ai_stream(prompt: str, history: list = None):
    """Yields chunks of the AI response as they are produced using the Gemini API."""
    if not google_ai_configured or not ai_model:
        logger.error("Google AI called but not configured.")
        yield "Error: AI service is not configured."
        return

    logger.info(f"Streaming AI request. History length: {len(history) if history else 0}. Prompt: '{prompt[:50]}...'")
    try:
        # Format history for Gemini API
        formatted_history = []
        if history:
            for msg in history:
                role = msg.get("role")
                content = msg.get("content")
                if role and content:
                    api_role = "model" if role == "assistant" else role
                    formatted_history.append({"role": api_role, "parts": [{"text": content}]})

        chat_session = ai_model.start_chat(history=formatted_history)
        response_stream = await chat_session.send_message_async(prompt, stream=True)

        async for chunk in response_stream:
            if chunk.text:
                yield chunk.text
    except Exception as e:
        logger.error(f"Error during Google AI streaming API call: {e}", exc_info=True)
        yield f"Error: Could not connect to AI service ({type(e).__name__})."
