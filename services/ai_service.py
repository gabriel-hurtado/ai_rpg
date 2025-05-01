# services/ai_service.py
import os
import logging
import google.generativeai as genai
from google.generativeai.types import GenerationConfig, HarmCategory, HarmBlockThreshold
from typing import Dict, Any, List, AsyncGenerator

logger = logging.getLogger(__name__)

# --- Base System Prompt (Default Instructions) ---
BASE_SYSTEM_PROMPT = """You are "Adventure Forge AI", a creative partner for Tabletop Roleplaying Game GMs.
Generate imaginative, detailed, and useful TTRPG content (locations, NPCs, items, monsters, plot hooks, etc.).
Be descriptive, provide actionable details, maintain a helpful tone, and use Markdown formatting."""

# --- Google AI Configuration ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model_name =  os.getenv("GOOGLE_GENERATIVE_AI_MODEL", "models/gemini-1.5-flash-latest")
ai_model = None

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        ai_model = genai.GenerativeModel(
            model_name=ai_model_name,
            system_instruction=BASE_SYSTEM_PROMPT, # Corrected from SYSTEM_PROMPT
            # generation_config=GenerationConfig(...) # Optional: configure temp, top_k etc.
        )
        google_ai_configured = True
        logger.info(f"Google AI Client Configured successfully with model: {ai_model.model_name}")
    except Exception as e:
        logger.error(f"Failed to configure Google AI: {e}", exc_info=True)
else:
    logger.warning("GOOGLE_API_KEY not found. AI features disabled.")

async def generate_system_prompt_from_context(context_data: Dict[str, Any]) -> str | None:
    """
    Uses the AI to generate a tailored system prompt based on user-provided context.

    Args:
        context_data: Dictionary of context items (goal, genre, system, etc.).

    Returns:
        The generated system prompt string, or None if generation fails.
    """
    if not google_ai_configured or not ai_model: # Use the same model or configure a separate fast one
        logger.error("generate_system_prompt called but AI not configured.")
        return None

    if not isinstance(context_data, dict) or not context_data:
        logger.warning("generate_system_prompt called with empty or invalid context.")
        return None # Return None, calling code should use BASE_SYSTEM_PROMPT

    # --- Construct the Meta-Prompt ---
    meta_prompt_lines = [
        "You are an expert system prompt generator.",
        "Your task is to create a concise set of instructions (a system prompt) for another AI.",
        "This other AI's primary purpose is to generate creative content for Tabletop Roleplaying Games (TTRPGs) based on user requests.",
        "Analyze the following user-defined context for their current TTRPG creation session:",
    ]

    # Add context items clearly labelled
    meta_prompt_lines.append("\n--- User Context ---")
    if goal := context_data.get("goal"): meta_prompt_lines.append(f"- Primary Goal: Help user achieve '{goal.replace('_',' ').title()}'.")
    if genre := context_data.get("genre"): meta_prompt_lines.append(f"- Genre/Tone: {genre}")
    if system := context_data.get("system"): meta_prompt_lines.append(f"- Game System: {system} (If specific rules are mentioned, try to adhere to them).")
    # Add other important context keys here dynamically
    # e.g., if 'npc_role' exists: meta_prompt_lines.append(f"- NPC Focus: Role is '{context_data['npc_role']}'")

    meta_prompt_lines.append("\n--- Instructions for System Prompt ---")
    meta_prompt_lines.append("Based *only* on the provided User Context, generate a short (2-4 sentences) paragraph that instructs the TTRPG AI.")
    meta_prompt_lines.append("This instruction set should guide the TTRPG AI to tailor its responses according to the user's context.")
    meta_prompt_lines.append("Focus on incorporating the Goal, Genre, and System (if provided) into the instructions.")
    meta_prompt_lines.append("Start the output directly with the generated instructions. Do not include conversational text like 'Okay, here is the system prompt:'.")
    meta_prompt_lines.append("Example Output Format: 'Focus on generating [Goal] content within a [Genre] setting, adhering to [System] rules where applicable. Maintain the specified tone.'")

    meta_prompt = "\n".join(meta_prompt_lines)
    logger.debug(f"Meta-prompt for system prompt generation:\n{meta_prompt}")

    # --- Call the AI (Non-Streaming) ---
    try:
        # Use generate_content for a single response, maybe different config
        # Consider lower temperature for more predictable system prompts
        generation_config_sys_prompt = GenerationConfig(
            temperature=0.5, # Lower temp for consistency
            max_output_tokens=150 # Limit length
        )
        # Use safety settings to block harmful content generation for the prompt itself
        safety_settings_sys_prompt = {
             HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
             HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
             HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
             HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
         }

        response = await ai_model.generate_content_async(
            meta_prompt,
            generation_config=generation_config_sys_prompt,
            safety_settings=safety_settings_sys_prompt
            )

        # Handle potential safety blocks or empty responses
        if not response.parts:
             logger.warning(f"System prompt generation produced no parts (potentially blocked). Context: {context_data}")
             # Check prompt_feedback for block reason if needed
             # print(response.prompt_feedback)
             return None
        generated_prompt = response.text.strip()

        if not generated_prompt:
            logger.warning(f"System prompt generation resulted in empty text. Context: {context_data}")
            return None

        logger.info(f"Successfully generated system prompt override: '{generated_prompt[:100]}...'")
        # Combine with BASE prompt? Or replace? Let's prepend to base for robustness.
        # return BASE_SYSTEM_PROMPT + "\n\n## Session Focus:\n" + generated_prompt
        # OR just return the generated part if it's meant to be comprehensive:
        return generated_prompt # Returning only the AI generated part

    except Exception as e:
        logger.error(f"Error calling Google AI for system prompt generation: {e}", exc_info=True)
        return None # Return None on error


# --- Google AI Streaming Helper ---
async def call_google_ai_stream(prompt: str, history: list = None, session_system_prompt: str | None = None):
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
