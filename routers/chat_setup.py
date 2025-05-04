# routers/chat_setup.py
import logging
import json
from typing import Optional, Dict, Any
from uuid import uuid4
from datetime import datetime, timezone

from fastapi import (
    APIRouter, Depends, Request, HTTPException, Form, Query, Path
)
from fastapi.responses import HTMLResponse, Response
from sqlmodel import Session, select

# Core application components
from database import get_session
from models import User, Conversation, ChatMessage, MessageRole
from main import PropelUser
from services.auth_service import safe_require_user
from services.db_service import get_or_create_db_user
# Import AI service function and base prompt
from services.ai_service import generate_system_prompt_from_context, call_google_ai_stream, BASE_SYSTEM_PROMPT
from main import templates
from services.db_service import get_or_create_db_user, check_credit_status

# routers/chat_setup.py
# ... other imports ...

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/chat/setup",
    tags=["Chat Context Setup"],
    dependencies=[Depends(safe_require_user)]
)

# --- Constants for Predefined Options ---
PREDEFINED_GOALS = ['describe_location', 'create_npc', 'create_monster', 'create_item', 'create_encounter', 'refine_text', 'charsheet']
PREDEFINED_GENRES = [
    "High Fantasy, Adventurous",
    "Dark Fantasy, Gritty",
    "Sci-Fi, Space Opera",
    "Cyberpunk, Noir",
    "Modern Urban Fantasy",
    "Historical Fiction",
    "Horror, Suspenseful",
    "Comedy/Satire",
    "System-Agnostic", # Maybe useful here too?
]
PREDEFINED_SYSTEMS = [
    "D&D 5e",
    "Pathfinder 2e",
    "System-Agnostic",
    "Fate Core",
    "Powered by the Apocalypse (PbtA)",
    "Blades in the Dark",
    "Call of Cthulhu",
    "My Homebrew Rules",
]

# Define the simplified setup sections and their templates
SETUP_SECTIONS = {
    "goal": "_step_goal.html",
    "context": "_step_context.html",
}

# Define default values for new chats
DEFAULT_CONTEXT = {
    "goal": PREDEFINED_GOALS[0], # Default to first goal
    "genre_tone": PREDEFINED_GENRES[0], # Default to first genre
    "game_system": PREDEFINED_SYSTEMS[0], # Default to first system
    "key_details": "",
    "conversation_id": None,
}

INITIAL_PROMPT = "Give me an overview of what you will help me do."

# --- Helper Function (Optional but Recommended) ---
def prepare_context_for_template(incoming_context: Dict[str, Any]) -> Dict[str, Any]:
    """Merges incoming context with defaults and prepares 'other' flags/values."""
    context = DEFAULT_CONTEXT.copy()
    context.update(incoming_context)

    # Coerce conversation_id
    conv_id_val = context.get("conversation_id")
    if conv_id_val in [None, 'None', 'null', '']: context["conversation_id"] = None
    else:
        try: context["conversation_id"] = int(conv_id_val)
        except (ValueError, TypeError): context["conversation_id"] = None

    # --- Handle 'other' logic for Goal ---
    current_goal = context.get("goal")
    goal_is_other = current_goal is not None and current_goal not in PREDEFINED_GOALS
    context["is_goal_other_selected"] = goal_is_other
    if goal_is_other:
        context["goal_other_text"] = current_goal # Keep original text
        context["goal"] = "other" # Set select value to 'other'
    else:
        context["goal_other_text"] = "" # Clear other text if not selected

    # --- Handle 'other' logic for Genre ---
    current_genre = context.get("genre_tone")
    genre_is_other = current_genre is not None and current_genre not in PREDEFINED_GENRES
    context["is_genre_other_selected"] = genre_is_other
    if genre_is_other:
        context["genre_tone_other_text"] = current_genre
        context["genre_tone"] = "other"
    else:
        context["genre_tone_other_text"] = ""

    # --- Handle 'other' logic for System ---
    current_system = context.get("game_system")
    system_is_other = current_system is not None and current_system not in PREDEFINED_SYSTEMS
    context["is_system_other_selected"] = system_is_other
    if system_is_other:
        context["game_system_other_text"] = current_system
        context["game_system"] = "other"
    else:
        context["game_system_other_text"] = ""

    # Pass predefined lists to template
    context["predefined_goals"] = PREDEFINED_GOALS
    context["predefined_genres"] = PREDEFINED_GENRES
    context["predefined_systems"] = PREDEFINED_SYSTEMS

    return context

# --- Endpoints ---

@router.get("/start", response_class=HTMLResponse)
async def get_setup_start(request: Request, user: PropelUser = Depends(safe_require_user)):
    """Returns the initial HTML fragment for Step 1 (Goal)."""
    logger.info(f"User {user.user_id}: GET /start - New chat context setup.")
    # Prepare context using the helper
    context_to_pass = prepare_context_for_template({"conversation_id": None}) # Start fresh
    template_name = f"chat_setup/{SETUP_SECTIONS['goal']}"
    return templates.TemplateResponse(template_name, {"request": request, "context": context_to_pass})


@router.get("/fragment", response_class=HTMLResponse)
async def get_setup_fragment(
    request: Request,
    section: str = Query(..., description="The setup section to load ('goal' or 'context')"),
    user: PropelUser = Depends(safe_require_user)
):
    """Returns HTML fragment for a setup step, pre-filled with current context from query params."""
    logger.info(f"User {user.user_id}: GET /fragment - Loading section '{section}'.")

    if section not in SETUP_SECTIONS:
        logger.warning(f"User {user.user_id}: Invalid setup section '{section}'.")
        return HTMLResponse(content="<div class='alert alert-danger m-3'>Invalid section.</div>", status_code=400)

    # Reconstruct context from query parameters
    incoming_context = dict(request.query_params)
    incoming_context.pop("section", None) # Remove the control parameter

    # --- Handle specific 'other' text fields coming from the form ---
    # If goal is 'other', use goal_other_text as the value to process
    if incoming_context.get("goal") == "other":
        other_text = incoming_context.pop("goal_other_text", "").strip()
        if other_text: incoming_context["goal"] = other_text
        # If other_text is empty, keep goal='other'

    # Do the same for genre and system
    if incoming_context.get("genre_tone") == "other":
        other_text = incoming_context.pop("genre_tone_other_text", "").strip()
        if other_text: incoming_context["genre_tone"] = other_text

    if incoming_context.get("game_system") == "other":
        other_text = incoming_context.pop("game_system_other_text", "").strip()
        if other_text: incoming_context["game_system"] = other_text
    # ----------------------------------------------------------------

    # Prepare context using the helper
    context_to_pass = prepare_context_for_template(incoming_context)

    logger.debug(f"Rendering fragment '{section}' with prepared context: {context_to_pass}")
    template_name = f"chat_setup/{SETUP_SECTIONS[section]}"
    try:
        return templates.TemplateResponse(template_name, {"request": request, "context": context_to_pass})
    except Exception as e:
        logger.error(f"Error rendering template {template_name}: {e}", exc_info=True)
        return HTMLResponse(content=f"<div class='alert alert-danger m-3'>Error loading step.</div>", status_code=500)


@router.get("/edit/{conversation_id}", response_class=HTMLResponse)
async def get_setup_for_edit(
    request: Request,
    conversation_id: int = Path(..., description="The ID of the conversation to edit"),
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Returns the first step fragment (Goal), pre-filled with existing context."""
    logger.info(f"User {user.user_id}: GET /edit/{conversation_id} - Loading context for editing.")
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
    if not conversation: raise HTTPException(status_code=404, detail="Conversation not found.")

    # Start with empty dict, update with saved, then prepare using helper
    incoming_context = {}
    if isinstance(conversation.context_data, dict):
        incoming_context.update(conversation.context_data)
    incoming_context["conversation_id"] = conversation_id # Ensure ID is passed

    context_to_pass = prepare_context_for_template(incoming_context)

    logger.debug(f"Editing context loaded and prepared for convo {conversation_id}: {context_to_pass}")
    template_name = f"chat_setup/{SETUP_SECTIONS['goal']}" # Always start edit from Goal step
    return templates.TemplateResponse(template_name, {"request": request, "context": context_to_pass})

# --- MODIFIED SAVE ENDPOINT ---
@router.post("/save", status_code=204)
async def save_setup_context(
    request: Request,
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """
    Saves context, generates system prompt, creates/updates Conversation.
    IF CREATING: If key_details exist and user has credit, generates the first
                 User/AI message pair.
    On success, returns 204 No Content with HX-Trigger header.
    """
    form_data = await request.form()
    form_dict = {k: form_data.getlist(k)[-1] for k in form_data.keys()}
    logger.info(f"User {user.user_id}: POST /save context data.")
    logger.debug(f"Received raw form data: {form_dict}")

    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    conversation_id_str = form_dict.pop("conversation_id", None)
    conversation_id = int(conversation_id_str) if conversation_id_str and conversation_id_str.isdigit() else None

    # --- Process Form Data into final_context (Keep Existing Logic) ---
    final_context = {}
    goal = form_dict.get("goal"); goal_other = form_dict.get("goal_other_text", "").strip()
    if goal == "other" and goal_other: final_context["goal"] = goal_other
    elif goal and goal != "other": final_context["goal"] = goal
    genre = form_dict.get("genre_tone"); genre_other = form_dict.get("genre_tone_other_text", "").strip()
    if genre == "other" and genre_other: final_context["genre_tone"] = genre_other
    elif genre and genre != "other": final_context["genre_tone"] = genre
    system = form_dict.get("game_system"); system_other = form_dict.get("game_system_other_text", "").strip()
    if system == "other" and system_other: final_context["game_system"] = system_other
    elif system and system != "other": final_context["game_system"] = system
    key_details = form_dict.get("key_details", "").strip()
    if key_details: final_context["key_details"] = key_details
    logger.debug(f"Processed context data to save: {final_context}")

    # --- Generate System Prompt (Keep Existing Logic) ---
    logger.info("Generating tailored system prompt instructions from context via AI...")
    generated_prompt_instructions = await generate_system_prompt_from_context(final_context)
    effective_system_prompt = BASE_SYSTEM_PROMPT
    if generated_prompt_instructions:
        effective_system_prompt += "\n\n## Session Focus:\n" + generated_prompt_instructions
        logger.info(f"Using combined system prompt. Length: {len(effective_system_prompt)}")
    else:
        logger.warning("AI system prompt generation failed or context insufficient. Using only base system prompt.")

    trigger_payload = {}
    initial_messages_generated = False # Flag for HX-Trigger

    try:
        if conversation_id: # --- Editing ---
            # (Keep existing update logic - no initial message generation on edit)
            logger.info(f"Updating context for existing conversation ID: {conversation_id}")
            conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
            if not conversation: raise HTTPException(status_code=404, detail="Conversation not found for update.")
            conversation.context_data = final_context or None
            conversation.system_prompt_override = effective_system_prompt
            conversation.updated_at = datetime.now(timezone.utc)
            db.add(conversation); db.commit()
            logger.info(f"Successfully updated context/prompt for conversation {conversation_id}.")
            session_info = {"id": conversation.id, "context": final_context}
            trigger_payload = {"chatContextUpdated": session_info, "closeModal": True}

        else: # --- Creating ---
            logger.info(f"Creating new conversation with context for user {db_user.id}")
            title_goal = final_context.get('goal', 'Chat').replace('_', ' ').title()
            genre_part = final_context.get('genre_tone', 'New Session')
            title_genre = genre_part.split(',')[0].strip()[:40]
            new_title = f"{title_goal}: {title_genre}"[:150]

            # Create Conversation FIRST
            new_conversation = Conversation(
                user_id=db_user.id,
                title=new_title,
                context_data=final_context or None,
                system_prompt_override=effective_system_prompt
            )
            db.add(new_conversation)
            db.commit()
            db.refresh(new_conversation)
            new_conversation_id = new_conversation.id # Get the ID
            logger.info(f"Successfully created new conversation {new_conversation_id} with title '{new_title}'.")


                # Check credits BEFORE calling AI
            has_credit, reason = check_credit_status(db_user) # Check the user object from this session
            if has_credit:
                    logger.info(f"User {db_user.id} has credit. Attempting initial AI generation for convo {new_conversation_id}.")

                    user_message_content = INITIAL_PROMPT
                    ai_response_text = ""
                    ai_stream_had_error = False
                    ai_message_saved = False

                    try:
                        # --- Start Transaction Block for User Msg, AI Msg, Credit ---


                        # 2. Call AI (Consume Stream)
                        logger.debug("Calling AI stream for initial message...")
                        ai_stream = call_google_ai_stream(
                            prompt=user_message_content,
                            history=[],
                            system_prompt_override_instructions=effective_system_prompt
                        )

                        # <<<< ****** CORE FIX START ****** >>>>
                        async for chunk in ai_stream:
                            # Check for error chunks yielded by the stream function
                            if chunk.startswith("**Error:**") or chunk.startswith("Error:"):
                                logger.error(f"AI stream reported an error during initial generation: {chunk}")
                                ai_response_text = chunk # Store error text if needed
                                ai_stream_had_error = True
                                break # Stop processing stream on error
                            ai_response_text += chunk
                        # <<<< ****** CORE FIX END ****** >>>>

                        # Check for empty response even if no error chunk received
                        if not ai_stream_had_error and not ai_response_text.strip():
                             logger.warning("Initial AI generation resulted in empty content.")
                             ai_stream_had_error = True # Treat as error for saving

                        # 3. Save AI Response & Decrement Credit (only if stream successful)
                        if not ai_stream_had_error:
                            logger.debug("AI stream finished successfully. Saving AI message and decrementing credit.")
                            # Lock user row for atomic credit update
                            locked_user = db.exec(select(User).where(User.id == db_user.id).with_for_update()).first()

                            if not locked_user:
                                logger.error(f"CRITICAL: User {db_user.id} not found post-stream. Aborting save.")
                                db.rollback() # Rollback user message add
                            elif locked_user.credits <= 0:
                                logger.warning(f"User {db_user.id} credit check failed ({locked_user.credits}) *after* AI call. Rolling back initial message save.")
                                db.rollback() # Rollback user message add
                            else:
                                # Save AI message
                                ai_message = ChatMessage(
                                    conversation_id=new_conversation_id,
                                    role=MessageRole.ASSISTANT,
                                    content=ai_response_text.strip() # Use accumulated text
                                )
                                db.add(ai_message)

                                # Update conversation timestamp (already have new_conversation object)
                                new_conversation.updated_at = datetime.now(timezone.utc)
                                db.add(new_conversation)

                                # Commit User message, AI message, credit update, timestamp update together
                                db.commit()
                                db.refresh(ai_message)
                                db.refresh(locked_user)
                                db.refresh(new_conversation) # Ensure updated_at is refreshed

                                logger.info(f"Successfully generated and saved initial messages. AI:{ai_message.id}. User credits decremented to {locked_user.credits}.")
                                initial_messages_generated = True # Mark success
                                ai_message_saved = True # Flag for cleanup

                        else:
                            # AI stream had an error or was empty. Rollback the user message add.
                            logger.warning("Initial AI generation failed or was empty. Rolling back user message addition.")
                            db.rollback() # Roll back the user_message add
                            db.refresh(new_conversation) # Refresh convo state

                    except Exception as ai_exc:
                        db.rollback() # Rollback any partial changes (user message add)
                        logger.error(f"Error during initial message generation stream processing: {ai_exc}", exc_info=True)
                        initial_messages_generated = False # Ensure flag is false
                        db.refresh(new_conversation) # Refresh convo state

            else: # No credit
                    logger.warning(f"User {db_user.id} does not have enough credits ({db_user.credits}) for initial message generation. Reason: {reason}")
                    # No action needed, conversation created, flag remains false.
                    initial_messages_generated = False


            # --- Prepare Trigger Payload ---
        session_info = {
                "id": new_conversation_id, # Use the obtained ID
                "title": new_conversation.title,
                "context": final_context,
                "initialMessagesGenerated": initial_messages_generated # <<< ADDED FLAG
            }
        trigger_payload = {"newChatCreated": session_info, "closeModal": True}
            # --- End Initial Message Generation ---

        # Return success with appropriate trigger
        headers = {"HX-Trigger": json.dumps(trigger_payload)}
        return Response(status_code=204, headers=headers)

    except HTTPException:
         db.rollback(); raise # Re-raise HTTP exceptions
    except Exception as e:
        db.rollback() # Rollback any ongoing transaction
        logger.error(f"Error saving context/generating initial message for user {user.user_id} (Convo ID: {conversation_id}): {e}", exc_info=True)
        # Return error trigger
        error_payload = {"showError": {"message": "Failed to save context or generate initial message. Please try again."}}
        error_headers = {"HX-Trigger": json.dumps(error_payload)}
        # Use 500 to indicate server error, but HTMX might ignore trigger. 200 OK with error payload might be better.
        return Response(content="Error saving context.", status_code=500, headers=error_headers) # Or 200
    