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
# routers/chat_setup.py

def prepare_context_for_template(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    # Create a new context, initially populated by deep copying DEFAULT_CONTEXT
    # to ensure all keys from DEFAULT_CONTEXT are present.
    context = {k: v for k, v in DEFAULT_CONTEXT.items()}

    # Helper to resolve the actual value and select/other_text for UI
    def _resolve_field(field_key: str, other_text_key: str, predefined_list: list, current_raw_data: dict, default_predefined_value: str):
        actual_value = None
        select_value_for_ui = default_predefined_value # Start with default
        other_text_for_ui = ""

        raw_main_val = current_raw_data.get(field_key)
        raw_other_text = current_raw_data.get(other_text_key)

        # Path 1: 'other' selected in dropdown, and text provided in other_text field
        if raw_main_val == "other" and raw_other_text and raw_other_text.strip():
            actual_value = raw_other_text.strip()
            select_value_for_ui = "other"
            other_text_for_ui = actual_value
        # Path 2: A custom value is directly in the main field (e.g., from DB save)
        elif raw_main_val and raw_main_val not in predefined_list and raw_main_val != "other":
            actual_value = raw_main_val.strip()
            select_value_for_ui = "other"
            other_text_for_ui = actual_value
        # Path 3: A predefined value is in the main field
        elif raw_main_val and raw_main_val in predefined_list:
            actual_value = raw_main_val
            select_value_for_ui = raw_main_val
            other_text_for_ui = ""
        # Path 4: 'other' is in the main field (e.g. from DB save where no custom text was given for 'other'),
        # or 'other' selected in dropdown but no text yet in other_text field.
        elif raw_main_val == "other": 
            actual_value = "other" # Store "other" itself if no custom text was provided for it
            select_value_for_ui = "other"
            other_text_for_ui = "" # No custom text to display
        # Path 5: No relevant value in raw_data, actual_value remains None (will use default_predefined_value)
        
        # If actual_value is still None after checks, it means we should use the default predefined value
        if actual_value is None:
            actual_value = default_predefined_value # This ensures actual_value is never None if a default exists
            # select_value_for_ui is already set to default_predefined_value

        return actual_value, select_value_for_ui, other_text_for_ui

    # Resolve Goal
    goal_actual, goal_select, goal_other = _resolve_field(
        "goal", "goal_other_text", PREDEFINED_GOALS, raw_data, DEFAULT_CONTEXT["goal"]
    )
    context["goal_actual_value"] = goal_actual
    context["goal_select_value"] = goal_select
    context["goal_other_text"] = goal_other
    context["goal"] = goal_actual # For hidden field carry-over

    # Resolve Genre/Tone
    genre_actual, genre_select, genre_other = _resolve_field(
        "genre_tone", "genre_tone_other_text", PREDEFINED_GENRES, raw_data, DEFAULT_CONTEXT["genre_tone"]
    )
    context["genre_tone_actual_value"] = genre_actual
    context["genre_tone_select_value"] = genre_select
    context["genre_tone_other_text"] = genre_other
    context["genre_tone"] = genre_actual # For hidden field carry-over

    # Resolve Game System
    system_actual, system_select, system_other = _resolve_field(
        "game_system", "game_system_other_text", PREDEFINED_SYSTEMS, raw_data, DEFAULT_CONTEXT["game_system"]
    )
    context["game_system_actual_value"] = system_actual
    context["game_system_select_value"] = system_select
    context["game_system_other_text"] = system_other
    context["game_system"] = system_actual # For hidden field carry-over
    
    # Handle key_details and conversation_id directly
    context["key_details"] = raw_data.get("key_details", DEFAULT_CONTEXT["key_details"])
    conv_id_val = raw_data.get("conversation_id")
    context["conversation_id"] = int(conv_id_val) if conv_id_val and str(conv_id_val).isdigit() else None

    # Pass predefined lists
    context["predefined_goals"] = PREDEFINED_GOALS
    context["predefined_genres"] = PREDEFINED_GENRES
    context["predefined_systems"] = PREDEFINED_SYSTEMS
    
    logger.debug(f"Prepared context from raw_data '{raw_data}': {context}")
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
# routers/chat_setup.py

# ... imports ...

@router.post("/save", status_code=204)
async def save_setup_context(
    request: Request,
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    form_data = await request.form()
    # Get the last value if a key appears multiple times (e.g., hidden + select with same name)
    form_dict = {k: form_data.getlist(k)[-1] for k in form_data.keys()}
    logger.info(f"User {user.user_id}: POST /save context data.")
    logger.debug(f"FULL FORM DICT FOR SAVE: {form_dict}")

    db_user = get_or_create_db_user(user, db)
    if not db_user:
        logger.error(f"User {user.user_id}: Could not get or create DB user.")
        raise HTTPException(status_code=500, detail="User data error.")

    conversation_id_str = form_dict.get("conversation_id")
    conversation_id = int(conversation_id_str) if conversation_id_str and conversation_id_str.isdigit() else None

    # --- Process Form Data into final_context ---
    final_context: Dict[str, Any] = {} # Ensure type hint for clarity

    # Goal: Assumed to come from a hidden input name="goal" in _step_context.html
    # This hidden input should contain the resolved goal (e.g., "My Custom Goal" or "create_npc")
    resolved_goal = form_dict.get("goal", "").strip()
    if resolved_goal:
        final_context["goal"] = resolved_goal

    # Genre & Tone: From select name="genre_tone" and input name="genre_tone_other_text"
    genre_select_from_form = form_dict.get("genre_tone")
    genre_other_text_from_form = form_dict.get("genre_tone_other_text", "").strip()
    if genre_select_from_form == "other" and genre_other_text_from_form:
        final_context["genre_tone"] = genre_other_text_from_form
    elif genre_select_from_form == "other": # "other" selected, but no custom text provided
        final_context["genre_tone"] = "other" # Store "other" literally
    elif genre_select_from_form and genre_select_from_form not in ["", "None", None]: # Predefined value selected
        final_context["genre_tone"] = genre_select_from_form
    # If not provided, genre_tone might be omitted or you can set a default if desired.

    # Game System: From select name="game_system" and input name="game_system_other_text"
    system_select_from_form = form_dict.get("game_system")
    system_other_text_from_form = form_dict.get("game_system_other_text", "").strip()
    if system_select_from_form == "other" and system_other_text_from_form:
        final_context["game_system"] = system_other_text_from_form
    elif system_select_from_form == "other": # "other" selected, but no custom text
        final_context["game_system"] = "other" # Store "other" literally
    elif system_select_from_form and system_select_from_form not in ["", "None", None]: # Predefined value selected
        final_context["game_system"] = system_select_from_form
    # If not provided, game_system might be omitted.

    key_details = form_dict.get("key_details", "").strip()
    if key_details:
        final_context["key_details"] = key_details

    logger.debug(f"Processed context data TO SAVE: {final_context}")

    if not final_context.get("goal"): # Basic validation: a goal is usually good to have
        logger.warning("No goal was resolved from the form data. Context might be incomplete.")
        # Optionally, raise HTTPException or set a default goal
        # For now, proceed with potentially missing goal

    # --- Generate System Prompt ---
    logger.info("Generating tailored system prompt instructions from context via AI...")
    generated_prompt_instructions = await generate_system_prompt_from_context(final_context)

    effective_system_prompt = BASE_SYSTEM_PROMPT  # Initialize with base
    if generated_prompt_instructions and not generated_prompt_instructions.startswith("**Error:**"):
        effective_system_prompt += "\n\n## Session Focus:\n" + generated_prompt_instructions
        logger.info(f"Using combined system prompt. Length: {len(effective_system_prompt)}")
    else:
        if generated_prompt_instructions: # It means it was an error string from the AI service
             logger.error(f"AI system prompt generation returned an error: {generated_prompt_instructions}")
        logger.warning("AI system prompt generation failed, context insufficient, or error returned. Using only base system prompt.")

    trigger_payload = {}
    initial_messages_generated = False
    # Variables to hold details of a newly created conversation
    created_conversation_id: Optional[int] = None
    created_conversation_title: str = "Untitled Conversation" # Default
    created_conversation_object: Optional[Conversation] = None


    try:
        if conversation_id:  # --- Editing Existing Conversation ---
            logger.info(f"Updating context for existing conversation ID: {conversation_id}")
            conversation_to_update = db.exec(
                select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.user_id == db_user.id,
                    Conversation.is_active == True
                )
            ).first()
            if not conversation_to_update:
                raise HTTPException(status_code=404, detail="Conversation not found for update.")

            conversation_to_update.context_data = final_context or None # Handle empty dict
            conversation_to_update.system_prompt_override = effective_system_prompt
            conversation_to_update.updated_at = datetime.now(timezone.utc)
            db.add(conversation_to_update)
            db.commit()
            # db.refresh(conversation_to_update) # Refresh if you use its attributes later in this block

            logger.info(f"Successfully updated context/prompt for conversation {conversation_id}.")
            session_info = {"id": conversation_to_update.id, "context": final_context}
            trigger_payload = {"chatContextUpdated": session_info, "closeModal": True}

        else:  # --- Creating New Conversation ---
            logger.info(f"Creating new conversation with context for user {db_user.id}")
            title_goal = final_context.get('goal', 'Chat').replace('_', ' ').title()
            genre_part = final_context.get('genre_tone', 'New Session')
            title_genre = genre_part.split(',')[0].strip()[:40]
            new_title = f"{title_goal}: {title_genre}"[:150]

            # 1. Create and Commit Conversation object FIRST
            new_conversation_obj = Conversation(
                user_id=db_user.id,
                title=new_title,
                context_data=final_context or None, # Handle empty dict
                system_prompt_override=effective_system_prompt
            )
            db.add(new_conversation_obj)
            db.commit()
            db.refresh(new_conversation_obj) # Essential to get ID and other DB-generated fields

            created_conversation_id = new_conversation_obj.id
            created_conversation_title = new_conversation_obj.title
            created_conversation_object = new_conversation_obj
            logger.info(f"Successfully created new conversation {created_conversation_id} with title '{created_conversation_title}'.")

            # 2. Attempt Initial Message Generation
            initial_user_prompt = final_context.get("key_details")
            if initial_user_prompt and created_conversation_object: # Ensure convo object exists
                logger.info(f"Key details provided ('{initial_user_prompt[:50]}...'), attempting initial message generation for convo {created_conversation_id}.")
                has_credit, reason = check_credit_status(db_user) # Check original db_user from this request's session
                
                if has_credit:
                    logger.info(f"User {db_user.id} has credit. Proceeding with initial AI call.")
                    # Use a nested try-except for the message exchange to isolate its potential rollback
                    try:
                        # User Message
                        user_message = ChatMessage(
                            conversation_id=created_conversation_id,
                            role=MessageRole.USER,
                            content=initial_user_prompt
                            # user_id=db_user.id # If your ChatMessage model has user_id
                        )
                        db.add(user_message)
                        created_conversation_object.updated_at = datetime.now(timezone.utc)
                        db.add(created_conversation_object) # Add to session for timestamp update

                        # --- Call the STREAMING function and consume it ---
                        logger.info(f"Calling AI stream for initial response. Prompt: '{initial_user_prompt[:50]}...'")
                        full_ai_response_text = ""
                        ai_stream_error = None
                        try:
                            ai_stream = call_google_ai_stream( # Use the streaming function
                                prompt=initial_user_prompt,
                                history=[], # No history for the first message
                                system_prompt_override_instructions=generated_prompt_instructions # Pass the generated part
                                # Note: call_google_ai_stream will combine this with BASE_SYSTEM_PROMPT
                            )
                            async for chunk in ai_stream:
                                # Check for errors yielded by the stream function itself
                                if chunk.startswith("Error:") or chunk.startswith("**Error:"):
                                    logger.warning(f"AI stream yielded an error chunk: {chunk}")
                                    ai_stream_error = chunk # Store the error message
                                    break # Stop consuming on error
                                full_ai_response_text += chunk
                        except Exception as stream_exc:
                             logger.error(f"Exception while consuming initial AI stream: {stream_exc}", exc_info=True)
                             ai_stream_error = f"**Error:** Exception during initial AI generation ({type(stream_exc).__name__})."

                        # --- Process the consumed response ---
                        logger.info(f"Initial AI stream consumed. Error: {ai_stream_error}. Response length: {len(full_ai_response_text)}")

                        if not ai_stream_error and full_ai_response_text.strip():
                            # Response seems valid
                            logger.info(f"Initial AI response seems valid for convo {created_conversation_id}.")
                            locked_user = db.exec(select(User).where(User.id == db_user.id).with_for_update()).first()
                            if not locked_user or locked_user.credits <= 0:
                                # ... (handle credit failure, rollback) ...
                                db.rollback()
                                initial_messages_generated = False
                            else:
                                # ... (add AI message, decrement credit, commit exchange) ...
                                ai_message = ChatMessage(
                                    conversation_id=created_conversation_id,
                                    role=MessageRole.ASSISTANT,
                                    content=full_ai_response_text.strip() # Use the collected text
                                )
                                db.add(ai_message)
                                locked_user.credits -= 1
                                db.add(locked_user)
                                db.commit() # Commit the whole exchange
                                logger.info(f"Successfully saved initial AI exchange for convo {created_conversation_id}.")
                                initial_messages_generated = True
                        else: # AI call failed (stream error or empty response)
                            logger.warning(f"Initial AI call failed. Stream error: {ai_stream_error}. Empty response: {not full_ai_response_text.strip()}")
                            db.rollback() # Rollback user message/timestamp update
                            initial_messages_generated = False
                    except Exception as ai_exc:
                        db.rollback() # Rollback any partial adds from the AI exchange attempt
                        logger.error(f"Error during initial message generation for convo {created_conversation_id}: {ai_exc}", exc_info=True)
                        initial_messages_generated = False
                else: # No credit for initial message
                    logger.warning(f"User {db_user.id} does not have enough credits ({db_user.credits}) for initial message generation for convo {created_conversation_id}. Reason: {reason}")
                    initial_messages_generated = False
            else: # No key details provided or conversation object missing (should not happen for latter)
                 if not initial_user_prompt:
                    logger.info(f"No key details provided, skipping initial message generation for convo {created_conversation_id}.")
                 initial_messages_generated = False

            # 3. Prepare Trigger Payload for the new chat
            if created_conversation_id is None: # Safety check, should be set if creation was successful
                logger.error("CRITICAL: created_conversation_id is None after attempting new conversation creation path.")
                # This indicates a flaw in logic before this point, as conversation creation should have failed earlier or set the ID.
                raise Exception("Failed to create new conversation or obtain its ID.")

            session_info = {
                "id": created_conversation_id,
                "title": created_conversation_title, # Use the title from the created object
                "context": final_context,
                "initialMessagesGenerated": initial_messages_generated
            }
            trigger_payload = {"newChatCreated": session_info, "closeModal": True}
            # --- End Creating New Conversation ---

        headers = {"HX-Trigger": json.dumps(trigger_payload)}
        return Response(status_code=204, headers=headers)

    except HTTPException: # Re-raise HTTP exceptions that we intentionally throw
         if db.in_transaction(): db.rollback() # Ensure rollback if an HTTP error happens mid-transaction
         raise
    except Exception as e:
        if db.in_transaction(): db.rollback() # General rollback for any other unexpected error
        
        # Construct a more informative error message for the user if possible
        error_message_detail = f"Failed to save context. Error: {str(e)}"
        logger.error(f"Error in /save endpoint for user {user.user_id} (Convo ID: {conversation_id}): {e}", exc_info=True)
        
        error_payload = {"showError": {"message": error_message_detail}}
        error_headers = {"HX-Trigger": json.dumps(error_payload)}
        # Return 500 to indicate server error. HTMX might not process HX-Trigger from 5xx by default,
        # but custom error handling or `htmx.on("htmx:responseError", ...)` can manage this.
        # Alternatively, return 200 OK with the error payload if you want HTMX to *always* process the trigger.
        return Response(content="Error saving context.", status_code=500, headers=error_headers)