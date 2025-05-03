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
from models import User, Conversation
from main import PropelUser
from services.auth_service import safe_require_user
from services.db_service import get_or_create_db_user
# Import AI service function and base prompt
from services.ai_service import generate_system_prompt_from_context, BASE_SYSTEM_PROMPT
from main import templates

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/chat/setup",
    tags=["Chat Context Setup"],
    dependencies=[Depends(safe_require_user)] # Protect all setup routes
)

# Define the simplified setup sections and their templates
SETUP_SECTIONS = {
    "goal": "_step_goal.html",        # Step 1
    "context": "_step_context.html", # Step 2 (Genre, System, Details)
}

# Define default values for new chats
DEFAULT_CONTEXT = {
    "goal": "describe_location",
    "genre_tone": "High Fantasy, Adventurous",
    "game_system": "System-Agnostic",
    "key_details": "",
    "conversation_id": None, # Will be None for new chats
}

# --- Endpoints ---

# ... (get_setup_start, get_setup_fragment, get_setup_for_edit remain the same) ...
@router.get("/start", response_class=HTMLResponse)
async def get_setup_start(request: Request, user: PropelUser = Depends(safe_require_user)):
    """Returns the initial HTML fragment for Step 1 (Goal)."""
    logger.info(f"User {user.user_id}: GET /start - New chat context setup.")
    context_to_pass = DEFAULT_CONTEXT.copy() # Use a fresh copy
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
    current_context = dict(request.query_params)
    current_context.pop("section", None)

    # --- Handle 'other' goal ---
    # If goal is 'other', use goal_other_text if present, otherwise keep 'other'
    if current_context.get("goal") == "other":
        other_text = current_context.pop("goal_other_text", "").strip()
        if other_text:
            current_context["goal"] = other_text # Replace 'other' with actual text
        # else: keep goal='other' (maybe show validation later?)
    else:
        # Ensure goal_other_text is not passed if goal isn't 'other'
        current_context.pop("goal_other_text", None)
    # -------------------------

    # Merge with defaults to ensure all keys exist for the template
    context_to_pass = DEFAULT_CONTEXT.copy()
    context_to_pass.update(current_context)

    # Coerce conversation_id
    conv_id_val = context_to_pass.get("conversation_id")
    if conv_id_val in [None, 'None', 'null', '']: context_to_pass["conversation_id"] = None
    else:
        try: context_to_pass["conversation_id"] = int(conv_id_val)
        except (ValueError, TypeError): context_to_pass["conversation_id"] = None

    logger.debug(f"Rendering fragment '{section}' with context: {context_to_pass}")
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

    # Start with defaults, update with saved, ensure ID is set
    context_to_pass = DEFAULT_CONTEXT.copy()
    if isinstance(conversation.context_data, dict):
        context_to_pass.update(conversation.context_data)
    context_to_pass["conversation_id"] = conversation_id

    logger.debug(f"Editing context loaded for convo {conversation_id}: {context_to_pass}")
    template_name = f"chat_setup/{SETUP_SECTIONS['goal']}"
    return templates.TemplateResponse(template_name, {"request": request, "context": context_to_pass})


@router.post("/save", status_code=204) # Keep 204 No Content
async def save_setup_context(
    request: Request,
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """
    Saves context, generates system prompt via AI, creates/updates Conversation.
    On success, returns 204 No Content with HX-Trigger header to update UI
    and close the modal.
    """
    form_data = await request.form()
    form_dict = {k: form_data.getlist(k)[-1] for k in form_data.keys()}
    logger.info(f"User {user.user_id}: POST /save context data.")
    logger.debug(f"Received form data: {form_dict}")

    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    conversation_id_str = form_dict.pop("conversation_id", None)
    conversation_id = int(conversation_id_str) if conversation_id_str and conversation_id_str.isdigit() else None

    # --- Handle 'other' goal text ---
    goal = form_dict.get("goal")
    if goal == "other":
        other_goal_text = form_dict.pop("goal_other_text", "").strip()
        if other_goal_text:
            form_dict["goal"] = other_goal_text # Use the text as the actual goal
        else:
            # Decide how to handle empty 'other' text.
            # Option 1: Default to something generic
            # form_dict["goal"] = "General Chat"
            # Option 2: Raise validation error (requires changing status code/response)
            # raise HTTPException(status_code=400, detail="Please specify your goal when selecting 'Other'.")
            # Option 3: Remove goal if empty (might cause issues downstream)
            form_dict.pop("goal", None)
            logger.warning("Goal was 'other' but no text provided. Goal not saved.")
    else:
        # Ensure goal_other_text is removed if goal wasn't 'other'
        form_dict.pop("goal_other_text", None)
    # --------------------------------

    # Define the keys we expect and want to save
    context_keys = ["goal", "genre_tone", "game_system", "key_details"]
    saved_context = {k: v for k, v in form_dict.items() if k in context_keys and v is not None and v != ""}
    logger.debug(f"Processed context data to save: {saved_context}")

    # --- Generate System Prompt via AI ---
    logger.info("Generating tailored system prompt instructions from context via AI...")
    generated_prompt_instructions = await generate_system_prompt_from_context(saved_context)

    # Combine with base prompt IF instructions were generated
    if generated_prompt_instructions:
        effective_system_prompt = BASE_SYSTEM_PROMPT + "\n\n" + generated_prompt_instructions
        logger.info(f"Using combined system prompt (Base + AI Generated Override). Length: {len(effective_system_prompt)}")
    else:
        effective_system_prompt = BASE_SYSTEM_PROMPT # Fallback
        logger.warning("AI system prompt generation failed or context was empty. Using only base system prompt.")

    trigger_payload = {} # Initialize empty dictionary for HX-Trigger

    try:
        if conversation_id: # --- Editing ---
            logger.info(f"Updating context for existing conversation ID: {conversation_id}")
            conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
            if not conversation: raise HTTPException(status_code=404, detail="Conversation not found for update.")

            conversation.context_data = saved_context or None
            conversation.system_prompt_override = effective_system_prompt # Save combined prompt
            conversation.updated_at = datetime.now(timezone.utc)
            db.add(conversation)
            db.commit()
            logger.info(f"Successfully updated context/prompt for conversation {conversation_id}.")
            session_info = {"id": conversation.id, "context": saved_context}
            # Prepare trigger data
            trigger_payload = {
                "chatContextUpdated": session_info,
                "closeModal": True # Add the close trigger
            }

        else: # --- Creating ---
            logger.info(f"Creating new conversation with context for user {db_user.id}")
            title_goal = saved_context.get('goal', 'chat').replace('_', ' ').title()
            title_genre = saved_context.get('genre_tone', 'New').split(',')[0].strip()[:30] # Short title part
            new_title = f"{title_goal}: {title_genre}"[:150]

            new_conversation = Conversation(
                user_id=db_user.id,
                title=new_title,
                context_data=saved_context or None,
                system_prompt_override=effective_system_prompt # Save combined prompt
            )
            db.add(new_conversation)
            db.commit()
            db.refresh(new_conversation)
            logger.info(f"Successfully created new conversation {new_conversation.id} with title '{new_title}'.")
            session_info = {"id": new_conversation.id, "title": new_conversation.title, "context": saved_context}
            # Prepare trigger data
            trigger_payload = {
                "newChatCreated": session_info,
                "closeModal": True # Add the close trigger
            }

        # Set headers AFTER potentially modifying trigger_payload
        headers = {"HX-Trigger": json.dumps(trigger_payload)}
        return Response(status_code=204, headers=headers) # Return 204 with headers

    except HTTPException:
         db.rollback(); raise # Re-raise known HTTP errors
    except Exception as e:
        db.rollback()
        logger.error(f"Error saving context for user {user.user_id} (Convo ID: {conversation_id}): {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save chat context.")