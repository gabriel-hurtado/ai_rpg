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
def prepare_context_for_template(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    context = DEFAULT_CONTEXT.copy() # Start with global defaults

    # Helper to resolve the actual value and select/other_text for UI
    def _resolve_field(field_name: str, other_text_field_name: str, predefined_list: list, current_raw_data: dict):
        actual_value = None
        select_value_for_ui = None
        other_text_for_ui = ""

        raw_main_val = current_raw_data.get(field_name)
        raw_other_text = current_raw_data.get(other_text_field_name)

        if raw_main_val == "other" and raw_other_text: # 'other' selected, and text provided
            actual_value = raw_other_text.strip()
            select_value_for_ui = "other"
            other_text_for_ui = actual_value
        elif raw_main_val and raw_main_val not in predefined_list and raw_main_val != "other": # Custom value directly in main field
            actual_value = raw_main_val.strip()
            select_value_for_ui = "other"
            other_text_for_ui = actual_value
        elif raw_main_val in predefined_list: # Predefined value
            actual_value = raw_main_val
            select_value_for_ui = raw_main_val
            other_text_for_ui = ""
        elif raw_main_val == "other" and not raw_other_text: # 'other' selected, but no text yet
            actual_value = None # Or "" - decide how to handle this for saving. Let's say None.
            select_value_for_ui = "other"
            other_text_for_ui = ""
        # If raw_main_val is None or empty, actual_value will remain None (or default from DEFAULT_CONTEXT later)

        return actual_value, select_value_for_ui, other_text_for_ui

    # Resolve Goal
    goal_actual, goal_select, goal_other = _resolve_field(
        "goal", "goal_other_text", PREDEFINED_GOALS, raw_data
    )
    if goal_actual is not None: context["goal_actual_value"] = goal_actual
    context["goal_select_value"] = goal_select if goal_select is not None else context.get("goal", PREDEFINED_GOALS[0]) # Fallback to default context or first predefined
    context["goal_other_text"] = goal_other

    # Resolve Genre/Tone
    genre_actual, genre_select, genre_other = _resolve_field(
        "genre_tone", "genre_tone_other_text", PREDEFINED_GENRES, raw_data
    )
    if genre_actual is not None: context["genre_tone_actual_value"] = genre_actual
    context["genre_tone_select_value"] = genre_select if genre_select is not None else context.get("genre_tone", PREDEFINED_GENRES[0])
    context["genre_tone_other_text"] = genre_other
    
    # Resolve Game System
    system_actual, system_select, system_other = _resolve_field(
        "game_system", "game_system_other_text", PREDEFINED_SYSTEMS, raw_data
    )
    if system_actual is not None: context["game_system_actual_value"] = system_actual
    context["game_system_select_value"] = system_select if system_select is not None else context.get("game_system", PREDEFINED_SYSTEMS[0])
    context["game_system_other_text"] = system_other

    # Apply resolved actual values to the main keys if they were resolved
    # These are what will be used by hidden fields to carry state if the field isn't editable in current step
    if "goal_actual_value" in context: context["goal"] = context["goal_actual_value"]
    if "genre_tone_actual_value" in context: context["genre_tone"] = context["genre_tone_actual_value"]
    if "game_system_actual_value" in context: context["game_system"] = context["game_system_actual_value"]
    
    # Handle key_details and conversation_id directly
    context["key_details"] = raw_data.get("key_details", context.get("key_details", ""))
    conv_id_val = raw_data.get("conversation_id")
    context["conversation_id"] = int(conv_id_val) if conv_id_val and str(conv_id_val).isdigit() else None

    # Pass predefined lists
    context["predefined_goals"] = PREDEFINED_GOALS
    context["predefined_genres"] = PREDEFINED_GENRES
    context["predefined_systems"] = PREDEFINED_SYSTEMS
    
    logger.debug(f"Prepared context for template from raw_data {raw_data}: {context}")
    return context

# In your get_setup_for_edit endpoint:
# incoming_context_from_db = conversation.context_data or {}
# incoming_context_from_db["conversation_id"] = conversation_id
# context_to_pass = prepare_context_for_template(incoming_context_from_db)

# In your get_setup_fragment endpoint:
# incoming_context_from_query = dict(request.query_params)
# incoming_context_from_query.pop("section", None)
# context_to_pass = prepare_context_for_template(incoming_context_from_query)
# --- Endpoints ---

@router.get("/start", response_class=HTMLResponse)
async def get_setup_start(request: Request, user: PropelUser = Depends(safe_require_user)):
    """Returns the initial HTML fragment for Step 1 (Goal)."""
    logger.info(f"User {user.user_id}: GET /start - New chat context setup.")
    # Start fresh with defaults. prepare_context_for_template will use DEFAULT_CONTEXT
    # as its base and then apply the empty dict, essentially returning defaults.
    # Crucially, it will also set the *_select_value, *_other_text, and *_actual_value fields.
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

    # Start with empty dict, update with saved context_data
    # The context_data from DB should contain the *actual* custom values if 'other' was used.
    incoming_context_from_db = {}
    if isinstance(conversation.context_data, dict):
        incoming_context_from_db.update(conversation.context_data)
    
    # IMPORTANT: Ensure conversation_id is part of the context being passed to prepare_context_for_template
    incoming_context_from_db["conversation_id"] = conversation_id 

    # The prepare_context_for_template function will then correctly identify
    # if the values in goal, genre_tone, game_system are custom (not in predefined)
    # and set the 'other_text' fields and select 'other' for the dropdown.
    context_to_pass = prepare_context_for_template(incoming_context_from_db)

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
    form_data = await request.form()
    form_dict = {k: form_data.getlist(k)[-1] for k in form_data.keys()}
    logger.info(f"User {user.user_id}: POST /save context data.")
    logger.debug(f"Received raw form data for save: {form_dict}")

    db_user = get_or_create_db_user(user, db) # ... error check ...

    conversation_id_str = form_dict.get("conversation_id") # Corrected: use .get()
    conversation_id = int(conversation_id_str) if conversation_id_str and conversation_id_str.isdigit() else None

    final_context = {}

    # Process Goal
    goal_select_val = form_dict.get("goal") # This is from the <select> name="goal"
    goal_other_text_val = form_dict.get("goal_other_text", "").strip()
    if goal_select_val == "other" and goal_other_text_val:
        final_context["goal"] = goal_other_text_val
    elif goal_select_val and goal_select_val != "other":
        final_context["goal"] = goal_select_val
    # If goal_select_val is "other" but goal_other_text_val is empty, goal is effectively not set from this step
    # However, _step_context.html has a hidden input: <input type="hidden" name="goal" value="{{ context.get('goal_actual_value', ...) }}">
    # This hidden input will provide the actual goal if it was set in the previous step.
    # The `form_dict` logic `{k: form_data.getlist(k)[-1] ...}` takes the LAST value.
    # So, if both a select `name="goal"` and hidden `name="goal"` exist, the hidden one might be ignored if it's not last.
    # This is why the hidden input in _step_context.html for goal is crucial and must be named `goal`.

    # Revised processing for final_context:
    # The hidden input `name="goal"` in `_step_context.html` should provide the resolved goal.
    # The select/other_text for genre/system are directly on `_step_context.html`.
    
    resolved_goal = form_dict.get("goal") # This should be the actual_value from the hidden field in _step_context
    if resolved_goal:
        final_context["goal"] = resolved_goal

    # Process Genre & Tone (editable in _step_context)
    genre_select_val = form_dict.get("genre_tone")
    genre_other_text_val = form_dict.get("genre_tone_other_text", "").strip()
    if genre_select_val == "other" and genre_other_text_val:
        final_context["genre_tone"] = genre_other_text_val
    elif genre_select_val and genre_select_val != "other":
        final_context["genre_tone"] = genre_select_val

    # Process Game System (editable in _step_context)
    system_select_val = form_dict.get("game_system")
    system_other_text_val = form_dict.get("game_system_other_text", "").strip()
    if system_select_val == "other" and system_other_text_val:
        final_context["game_system"] = system_other_text_val
    elif system_select_val and system_select_val != "other":
        final_context["game_system"] = system_select_val
        
    key_details = form_dict.get("key_details", "").strip()
    if key_details:
        final_context["key_details"] = key_details

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
    