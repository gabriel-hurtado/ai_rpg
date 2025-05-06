# routers/conversations.py
import logging
import json
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Request, Form, Depends, HTTPException, Response, Path, Body 
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, col

# Core Imports
from database import get_session, engine 
from models import Conversation, ChatMessage, MessageRole, User
# Corrected Auth Imports
from services.auth_service import safe_require_user 
from main import PropelUser 
# --- End Corrected Auth Imports ---
from services.db_service import get_or_create_db_user, check_credit_status, START_MESSAGE # Use START_MESSAGE from db_service
# Import AI Service and Base Prompt
from services.ai_service import call_google_ai_stream, BASE_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

# Combine routers conceptually - prefix covers both /conversations and /chat
router = APIRouter(
    tags=["Chat & Conversations"],
    dependencies=[Depends(safe_require_user)] # Protect most routes by default
)

# --- Conversation Management Endpoints ---

@router.get("/conversations", response_model=List[Dict[str, Any]])
async def get_conversations(user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    """Gets the list of active conversations for the logged-in user."""
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        statement = select(Conversation).where(
            Conversation.user_id == db_user.id, Conversation.is_active == True
        ).order_by(col(Conversation.updated_at).desc())
        conversations = db.exec(statement).all()
        logger.info(f"Found {len(conversations)} active conversations for user {db_user.id}")
        # Return only essential list data
        return [{"id": conv.id, "title": conv.title} for conv in conversations]
    except Exception as e:
        logger.error(f"Error fetching conversations for user {db_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch conversations.")

@router.get("/conversations/{conversation_id}", response_model=Dict[str, Any])
async def get_conversation_details(
    conversation_id: int = Path(..., description="ID of the conversation"),
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Gets details and messages for a specific conversation."""
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
        if not conversation: raise HTTPException(status_code=404, detail="Conversation not found.")

        messages_statement = select(ChatMessage).where(ChatMessage.conversation_id == conversation_id, ChatMessage.is_active == True).order_by(col(ChatMessage.timestamp).asc())
        messages = db.exec(messages_statement).all()
        logger.info(f"Found {len(messages)} messages for conversation {conversation_id}")

        formatted_messages = [
            {"id": msg.id, "role": msg.role.value, "content": msg.content, "timestamp": msg.timestamp.isoformat()}
            for msg in messages
        ]
        return {
            "conversation": {"id": conversation.id, "title": conversation.title, "context": conversation.context_data or {}},
            "messages": formatted_messages
        }
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error retrieving conversation {conversation_id} for user {db_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve conversation details.")


@router.put("/conversations/{conversation_id}", response_model=Dict[str, Any])
async def update_conversation_title(
    conversation_id: int = Path(..., description="ID of the conversation"),
    payload: Dict[str, str] = Body(...), # Expect {"title": "New Title"}
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Updates the title of a specific conversation."""
    new_title = payload.get("title", "").strip()
    if not new_title: raise HTTPException(status_code=400, detail="Title cannot be empty.")

    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
        if not conversation: raise HTTPException(status_code=404, detail="Conversation not found.")

        conversation.title = new_title[:150] # Apply max length
        conversation.updated_at = datetime.now(timezone.utc)
        db.add(conversation); db.commit(); db.refresh(conversation)
        logger.info(f"Conversation {conversation_id} title updated for user {db_user.id}.")
        return {"id": conversation.id, "title": conversation.title}
    except HTTPException: raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error updating conversation title {conversation_id} for user {db_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update conversation title.")


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: int = Path(..., description="ID of the conversation"),
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Soft deletes a conversation."""
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
        if not conversation: raise HTTPException(status_code=404, detail="Conversation not found.")

        conversation.is_active = False
        conversation.updated_at = datetime.now(timezone.utc)
        # Mark associated messages inactive? Optional, depends on desired behavior.
        # update_stmt = update(ChatMessage).where(ChatMessage.conversation_id == conversation_id).values(is_active=False)
        # db.exec(update_stmt)
        db.add(conversation)
        db.commit()
        logger.info(f"Conversation {conversation_id} soft deleted for user {db_user.id}")
        return Response(status_code=204)
    except HTTPException: raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting conversation {conversation_id} for user {db_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete conversation.")

# --- Chat Message Endpoints ---

@router.post("/chat/message")
async def chat_message_stream(
    request: Request, # Keep request if needed for other things
    prompt: str = Form(...),
    conversation_id: Optional[int] = Form(None), # Allow explicit ID passing
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Handles sending a message, streaming AI response, saving, and credit use."""
    logger.info(f"POST /chat/message User: {user.user_id}, ConvoID: {conversation_id}, Prompt: '{prompt[:50]}...'")

    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")
    
    # Pass db_user.id instead of the db_user object to stream_and_save
    current_db_user_id = db_user.id # <<< STORE THE ID
    has_credit, reason = check_credit_status(db_user)
    if not has_credit:
        logger.warning(f"Credit check failed for user {current_db_user_id}: {reason}")
        raise HTTPException(status_code=402, detail=f"Payment Required: {reason}")

    conversation = None
    response_headers = {}

    try:
        if not conversation_id:
            # If no conversation ID is provided, we assume the user MUST have gone
            # through the setup process which would create one.
            # Alternatively, find the *most recent* active conversation for the user.
            logger.warning(f"User {db_user.id} sent message without explicit conversation_id. Finding most recent.")
            conversation = db.exec(select(Conversation).where(Conversation.user_id == db_user.id, Conversation.is_active == True).order_by(col(Conversation.updated_at).desc())).first()
            if not conversation:
                # If still no conversation, maybe create a default one here,
                # or force user through setup via an error.
                logger.error(f"User {db_user.id} has no active conversations. Cannot process message.")
                raise HTTPException(status_code=400, detail="No active chat session found. Please start a new chat via setup.")
            conversation_id = conversation.id
            logger.info(f"Using most recent conversation {conversation_id} for user {db_user.id}")
        else:
            # Fetch the specified conversation, ensuring ownership
            conversation = db.exec(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == db_user.id, Conversation.is_active == True)).first()
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found or not accessible.")

        final_conversation_id = conversation.id

        # --- Save User Message ---
        user_message = ChatMessage(
            conversation_id=final_conversation_id,
            role=MessageRole.USER,
            content=prompt
        )
        db.add(user_message)
        conversation.updated_at = datetime.now(timezone.utc)
        db.add(conversation)
        db.commit(); db.refresh(user_message); db.refresh(conversation)
        user_message_id = user_message.id
        logger.debug(f"User message saved (ID: {user_message_id}) for convo {final_conversation_id}")

        # --- Prepare History and System Prompt ---
        history_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == final_conversation_id,
            ChatMessage.id != user_message_id, # Exclude just added message
            ChatMessage.is_active == True
        ).order_by(col(ChatMessage.timestamp).asc()).limit(20) # Limit history size
        history_messages = db.exec(history_statement).all()

        # Use saved override or base prompt
        effective_system_prompt = conversation.system_prompt_override or BASE_SYSTEM_PROMPT
        logger.debug(f"Using effective system prompt (len {len(effective_system_prompt)}) for convo {final_conversation_id}")

        formatted_history = []
        for msg in history_messages:
            # Ensure role is 'user' or 'model' as expected by the SDK
            sdk_role = "user" if msg.role == MessageRole.USER else "model"
            formatted_history.append({
                "role": sdk_role,
                "parts": [{"text": msg.content}] # Wrap content in 'parts' list with 'text' key
            })

        # --- Stream Response and Save AI Message ---
        async def stream_and_save(user_msg_id: int):
            full_response_content = ""
            ai_had_error = False
            ai_message_id = None
            try:
                ai_stream = call_google_ai_stream(
                    prompt=prompt, # The current prompt is just text, which is handled correctly
                    history=formatted_history, # Pass the correctly formatted history
                    system_prompt_override_instructions=effective_system_prompt
                )

                async for chunk in ai_stream:
                    # Check for internal error messages from the stream function itself
                    if chunk.startswith("**Error:**") or chunk.startswith("Error:"):
                        logger.error(f"AI service stream returned an error chunk: {chunk}")
                        full_response_content = chunk # Store error message
                        ai_had_error = True
                        yield chunk # Yield error to client
                        # Stop processing this stream on error
                        return
                    else:
                        yield chunk
                        full_response_content += chunk

                if not full_response_content: # Handle case where stream finishes with no text and no error flag
                    logger.warning(f"AI stream completed with empty response for convo {final_conversation_id}.")
                    ai_had_error = True # Treat as error for saving logic

            except Exception as stream_exc:
                logger.error(f"Error during streaming generation for convo {final_conversation_id}: {stream_exc}", exc_info=True)
                yield f"\n\n**Error:** Server error during response generation.**"
                ai_had_error = True

            # --- Save AI Message & Decrement Credit (only if no error and content exists) ---
            if not ai_had_error and full_response_content:
                with Session(engine) as post_stream_db: # Use separate session
                    try:
                        # Re-fetch user for current credit count and lock row potentially
                        locked_user = post_stream_db.exec(select(User).where(User.id == db_user.id).with_for_update()).first()

                        if not locked_user:
                            logger.error(f"CRITICAL: User {db_user.id} not found post-stream for convo {final_conversation_id}.")
                            return
                        if locked_user.credits <= 0:
                            logger.error(f"User {db_user.id} has no credits ({locked_user.credits}) post-stream. Aborting save/decrement for convo {final_conversation_id}.")
                            # Yield a message indicating credit issue?
                            # yield json.dumps({"error": "Insufficient credits after generation."})
                            return

                        ai_message = ChatMessage(
                            conversation_id=final_conversation_id,
                            role=MessageRole.ASSISTANT,
                            content=full_response_content.strip(),
                            # Add token counts here later if available
                        )
                        post_stream_db.add(ai_message)

                        # Decrement credits
                        locked_user.credits -= 1
                        post_stream_db.add(locked_user)

                        # Update conversation timestamp
                        convo_to_update = post_stream_db.get(Conversation, final_conversation_id)
                        if convo_to_update:
                            convo_to_update.updated_at = datetime.now(timezone.utc)
                            post_stream_db.add(convo_to_update)

                        post_stream_db.commit()
                        post_stream_db.refresh(ai_message)
                        ai_message_id = ai_message.id
                        logger.info(f"AI Response saved (ID: {ai_message_id}, Convo: {final_conversation_id}), User {db_user.id} credits decremented to {locked_user.credits}")
                        # Set header for frontend JS to update display
                        response_headers["X-User-Credits"] = str(locked_user.credits)

                    except Exception as db_exc:
                        logger.error(f"DB Error during post-stream save for convo {final_conversation_id}: {db_exc}", exc_info=True)
                        post_stream_db.rollback()
                        ai_message_id = None # Ensure ID is None if save failed

            # --- Yield Final JSON with IDs (only if AI message saved) ---
            if ai_message_id is not None:
                try:
                    final_data = {"userMessageId": user_msg_id, "aiMessageId": ai_message_id}
                    # Add a marker to distinguish JSON from text chunks (e.g., prefix/suffix)
                    yield f"\n<!-- FINAL_PAYLOAD:{json.dumps(final_data)} -->"
                    logger.debug(f"Yielded final JSON payload for convo {final_conversation_id}")
                except Exception as json_err:
                    logger.error(f"Error JSON encoding final payload: {json_err}")
            else:
                 logger.warning(f"Not yielding final JSON data because ai_message_id is None for convo {final_conversation_id}")


        # --- Return Streaming Response ---
        response = StreamingResponse(stream_and_save(user_message_id, current_db_user_id), media_type="text/plain") # <<< PASS current_db_user_id# Set headers collected during processing
        for k, v in response_headers.items(): response.headers[k] = v
        return response

    except HTTPException:
        raise # Re-raise specific HTTP errors
    except Exception as e:
        logger.error(f"Unexpected error in /chat/message endpoint for user {db_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error processing chat request.")

@router.delete("/conversations/{conversation_id}/messages/{message_id}", status_code=204)
async def delete_message_and_after( # Renamed to match call site
    conversation_id: int = Path(..., description="Conversation ID"),
    message_id: int = Path(..., description="ID of the message to delete from"),
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Soft deletes a message and all subsequent messages in the conversation."""
    logger.info(f"DELETE /messages: User {user.user_id}, Convo {conversation_id}, From Msg {message_id}")
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    # Fetch the target message first to get its timestamp and check ownership via conversation
    message = db.exec(
        select(ChatMessage)
        .join(Conversation) # Join to check ownership easily
        .where(
            ChatMessage.id == message_id,
            ChatMessage.conversation_id == conversation_id,
            Conversation.user_id == db_user.id, # Check ownership here
            Conversation.is_active == True,
            ChatMessage.is_active == True
        )
    ).first()

    if not message:
        raise HTTPException(status_code=404, detail="Message not found or not accessible.")

    try:
        target_time = message.timestamp
        # Find IDs of messages to delete (more efficient potentially)
        messages_to_delete_stmt = select(ChatMessage.id).where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.timestamp >= target_time,
            ChatMessage.is_active == True
        )
        message_ids_to_delete = db.exec(messages_to_delete_stmt).all()

        if not message_ids_to_delete:
            logger.info("No messages found at or after the target timestamp to delete.")
            return Response(status_code=204)

        # Perform bulk update if possible (check SQLModel/SQLAlchemy specifics)
        # Using iterative for clarity, can optimize later if needed
        count = 0
        for msg_id in message_ids_to_delete:
             msg = db.get(ChatMessage, msg_id)
             if msg:
                 msg.is_active = False
                 db.add(msg)
                 count += 1

        # Update conversation timestamp
        conversation = db.get(Conversation, conversation_id) # Get conversation directly
        if conversation:
             conversation.updated_at = datetime.now(timezone.utc)
             db.add(conversation)

        db.commit()
        logger.info(f"Soft deleted {count} messages starting from ID {message_id} in conversation {conversation_id}.")
        return Response(status_code=204)

    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting messages from ID {message_id} in convo {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Database error deleting messages.")
