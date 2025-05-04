# services/ai_service.py
import os
import logging
import google.generativeai as genai
from google.generativeai.types import GenerationConfig, HarmCategory, HarmBlockThreshold
from typing import Dict, Any, List, AsyncGenerator, Optional

logger = logging.getLogger(__name__)

# --- Base System Prompt (Default Instructions) ---
BASE_SYSTEM_PROMPT = """You are "Adventure Forge AI", a creative partner for Tabletop Roleplaying Game GMs.
Your goal is to help Game Masters (GMs) build their unique homebrew worlds.
Generate imaginative, detailed, and useful TTRPG content (locations, NPCs, items, monsters, plot hooks, etc.).
Be descriptive, provide actionable details, maintain a helpful, collaborative, and inspiring tone.
Avoid clichés where possible unless requested. Format your output using Markdown for readability."""

# --- Google AI Configuration ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model = None
ai_model_name =  os.getenv("GOOGLE_GENERATIVE_AI_MODEL", "models/gemini-1.5-flash-latest")

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        # Initialize the main model used for chat streaming
        # System instruction here acts as the ultimate fallback
        ai_model = genai.GenerativeModel(
            model_name=ai_model_name,
            system_instruction=BASE_SYSTEM_PROMPT,
        )
        google_ai_configured = True
        logger.info(f"Google AI Client Configured successfully with model: {ai_model.model_name}")
    except Exception as e:
        logger.error(f"Failed to configure Google AI: {e}", exc_info=True)
else:
    logger.warning("GOOGLE_API_KEY not found. AI features disabled.")

# --- Function to Generate System Prompt Override via AI ---
async def generate_system_prompt_from_context(context_data: Dict[str, Any]) -> str | None:
    """
    Uses the AI to generate a tailored system prompt override based on user context.
    Returns the generated prompt string (intended to augment/focus the base prompt), or None on failure.
    """
    if not google_ai_configured or not ai_model:
        logger.error("generate_system_prompt called but AI not configured.")
        return None

    if not isinstance(context_data, dict) or not context_data:
        logger.warning("generate_system_prompt called with empty or invalid context.")
        return None # No context, no override needed

    # --- Construct the Meta-Prompt ---
    meta_prompt_lines = [
        "Analyze the user's TTRPG session context below.",
        "Generate 1-3 concise sentences instructing an AI assistant on how to best generate content for this specific session.",
        "These instructions should guide the AI to tailor its creative TTRPG content generation according to the user's specified context.",
        "Focus on incorporating the Goal, Genre/Tone, Game System, and Key Details provided.",
        "Output *only* the generated instructions, without any preamble like 'Okay, here are the instructions:'.",
        "\n--- User Context ---",
    ]
    # Dynamically add provided context items
    if goal := context_data.get("goal"): meta_prompt_lines.append(f"- Primary Goal: User wants help with '{goal.replace('_',' ').title()}'.")
    if genre := context_data.get("genre_tone"): meta_prompt_lines.append(f"- Genre/Tone: {genre}")
    if system := context_data.get("game_system"): meta_prompt_lines.append(f"- Game System: {system}")
    if details := context_data.get("key_details"): meta_prompt_lines.append(f"- Key Details/Request: {details}")

    # Only proceed if there's actually some context to work with
    if len(meta_prompt_lines) <= 6: # Only the instruction lines + header
        logger.info("No specific context provided by user, no system prompt override needed.")
        return None

    meta_prompt_lines.append("\n--- Generated Instructions for AI Assistant (1-3 sentences max) ---")
    meta_prompt = "\n".join(meta_prompt_lines)

    logger.debug(f"Meta-prompt for system prompt generation:\n------\n{meta_prompt}\n------")

    # --- Call the AI (Non-Streaming) ---
    try:
        generation_config = GenerationConfig(
            temperature=0.4, # Lower temp for more focused, instruction-like output
            max_output_tokens=200 # Limit length
        )
        # Standard safety settings
        safety_settings = { H: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE for H in HarmCategory if H != HarmCategory.HARM_CATEGORY_UNSPECIFIED }

        response = await ai_model.generate_content_async(
            meta_prompt,
            generation_config=generation_config,
            safety_settings=safety_settings
        )

        if not response.parts:
             logger.warning(f"System prompt gen blocked. Feedback: {response.prompt_feedback}. Context: {context_data}")
             return None

        generated_prompt = response.text.strip()

        if not generated_prompt:
            logger.warning(f"System prompt generation resulted in empty text. Context: {context_data}")
            return None

        # Return just the generated instructions. The caller will combine with BASE.
        logger.info(f"Successfully generated system prompt override instruction: '{generated_prompt[:100]}...'")
        return generated_prompt

    except Exception as e:
        logger.error(f"Error calling Google AI for system prompt generation: {e}", exc_info=True)
        return None
        
# --- Streaming Function ---
async def call_google_ai_stream(
    prompt: str,
    history: List[Dict[str, Any]], # History received should now be in the correct format
    system_prompt_override_instructions: str | None = None
) -> AsyncGenerator[str, None]:
    """
    Yields AI response chunks. Uses BASE_SYSTEM_PROMPT initialization but prepends
    the override instructions to the history if provided.
    """
    if not google_ai_configured or not ai_model:
        yield "Error: AI service is not configured."; return

    effective_system_prompt = BASE_SYSTEM_PROMPT
    if system_prompt_override_instructions:
        effective_system_prompt += "\n\n## Session Focus:\n" + system_prompt_override_instructions

    logger.info(f"Streaming AI request. History len: {len(history)}. Using effective system prompt (len {len(effective_system_prompt)}). Prompt: '{prompt[:50]}...'")

    # --- Prepare History with effective system prompt (CORRECTED FORMAT) ---
    current_history = []
    # Inject the *entire* effective system prompt as the first instruction set
    current_history.append({"role": "user", "parts": [{"text": f"[System Instructions For This Session]:\n{effective_system_prompt}"}]})
    current_history.append({"role": "model", "parts": [{"text": "Understood. I will adhere to these instructions and my base role."}]})

    # Now extend with the history received from the router, which is already formatted correctly
    current_history.extend(history)

    try:
        # Start chat WITH the prepared history
        # The prompt itself is the latest message, sent separately
        chat_session = ai_model.start_chat(history=current_history)
        response_stream = await chat_session.send_message_async(prompt, stream=True) # prompt is just text here

        async for chunk in response_stream:
            if hasattr(chunk, 'text') and chunk.text:
                yield chunk.text

    except Exception as e:
        logger.error(f"Error during Google AI streaming API call: {e}", exc_info=True)
        yield f"\n\n**Error:** Could not get response from AI service ({type(e).__name__}). Please try again.**"