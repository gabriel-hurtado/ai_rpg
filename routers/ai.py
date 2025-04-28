import logging
from fastapi import APIRouter, Request, Form, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, col
from typing import Optional
from services.auth_service import safe_require_user
from services.db_service import get_or_create_db_user, check_credit_status
from services.ai_service import call_google_ai_stream
from database import get_session, engine
from models import Conversation, ChatMessage, MessageRole, User
from datetime import datetime, timezone
from main import PropelUser

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["ai"])

@router.post("/message")
async def chat_message_stream(
    request: Request, # Need request to get db session via Depends
    prompt: str = Form(...),
    conversation_id_form: Optional[int] = Form(None, alias="conversation_id"), # Use alias if needed
    user: PropelUser = Depends(safe_require_user),
    # Use the original session for initial checks and setup
    db: Session = Depends(get_session)
):
    """Handles sending a message, streaming the AI response, saving messages, and decrementing credits."""
    logger.info(f"POST /chat/message User: {user.user_id}, Conversation ID Form: {conversation_id_form}, Prompt: '{prompt[:50]}...'")

    # 1. Get DB User (using original session)
    db_user = get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    # --- CAPTURE USER ID ---
    user_id = db_user.id # Capture the primitive ID

    # 2. Check Credits
    has_credit, reason = check_credit_status(db_user)
    if not has_credit:
        logger.warning(f"Credit check failed for user {user_id}: {reason}")
        raise HTTPException(status_code=402, detail=f"Payment Required: {reason}")

    # 3. Get or Create Conversation (using original session)
    conversation: Optional[Conversation] = None
    is_new_conversation = False
    response_headers = {}
    conversation_id = conversation_id_form # Use the ID from the form

    try:
        if conversation_id:
            conversation = db.exec(
                select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.user_id == user_id, # Use captured user_id
                    Conversation.is_active == True
                )
            ).first()
            if not conversation:
                logger.warning(f"Chat attempt failed: Conversation {conversation_id} not found or access denied for user {user_id}")
                raise HTTPException(status_code=404, detail="Conversation not found or not accessible")
            logger.debug(f"Using existing conversation {conversation.id}")
        else:
            is_new_conversation = True
            max_title_length = 50
            initial_title = prompt[:max_title_length] + ("..." if len(prompt) > max_title_length else "")
            conversation = Conversation(user_id=user_id, title=initial_title) # Use captured user_id
            db.add(conversation)
            db.commit() # Commit to get the ID
            db.refresh(conversation)
            conversation_id = conversation.id # Get the new ID (This is now the final ID)
            response_headers["X-Conversation-ID"] = str(conversation_id)
            response_headers["X-Conversation-Title"] = conversation.title
            logger.info(f"Created new conversation {conversation_id} with title '{conversation.title}' for user {user_id}")

        # --- CAPTURE FINAL CONVERSATION ID ---
        final_conversation_id = conversation_id # Capture the definitive ID

        # 4. Save User Message (using original session)
        user_message = ChatMessage(
            user_id=user_id, # Set user_id for user messages
            conversation_id=final_conversation_id,
            role=MessageRole.USER,
            content=prompt
        )
        db.add(user_message)
        conversation.updated_at = datetime.now(timezone.utc) # Update timestamp explicitly
        db.add(conversation) # Add conversation again to stage the updated_at change
        db.commit() # Commit user message and timestamp update BEFORE streaming
        # db.refresh(user_message) # Refresh is optional here

        logger.debug(f"User message saved for conversation {final_conversation_id}")

        # 5. Prepare History for AI (using original session)
        history_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == final_conversation_id
        ).order_by(col(ChatMessage.timestamp).asc()).limit(20) # Limit history depth
        history_messages = db.exec(history_statement).all()
        formatted_history = [
            {"role": msg.role.value, "content": msg.content}
            for msg in history_messages
        ]

        # 6. Define the Streaming Generator with Post-Stream Actions
        #    It now implicitly uses the captured user_id and final_conversation_id from the outer scope
        async def stream_and_save():
            full_response_content = ""
            ai_had_error = False
            try:
                # Call the streaming AI function
                ai_stream = call_google_ai_stream(prompt, formatted_history[:-1]) # History before current prompt

                async for chunk in ai_stream:
                    if chunk.startswith("Error:"): # Check for errors from the AI helper itself
                         logger.error(f"AI service returned an error chunk: {chunk}")
                         full_response_content = chunk # Store the error message
                         ai_had_error = True
                         yield chunk # Yield the error to the client
                         # Optionally break here if you don't want to yield anything after an error chunk
                         # break
                    else:
                         yield chunk
                         full_response_content += chunk # Accumulate the valid response

                # ---- Stream finished ----
                if ai_had_error or not full_response_content:
                    logger.error(f"AI stream completed with error or empty response for convo {final_conversation_id}. No DB write performed.")
                    return # Exit the generator, do not proceed to DB operations

                logger.info(f"AI stream completed successfully for convo {final_conversation_id}. Saving response & decrementing credit.")

                # --- Use a NEW SESSION for post-stream DB operations ---
                with Session(engine) as post_stream_db:
                    try:
                        # Re-fetch user using the new session and the captured ID
                        current_db_user = post_stream_db.get(User, user_id)

                        if not current_db_user:
                             logger.error(f"CRITICAL: User {user_id} not found in DB during post-stream save for convo {final_conversation_id}.")
                             return
                        if current_db_user.credits <= 0:
                             logger.error(f"User {user_id} has no credits left post-stream ({current_db_user.credits}). Aborting save/decrement for convo {final_conversation_id}.")
                             return

                        # Save the AI message (using new session)
                        ai_message = ChatMessage(
                            user_id=None, # AI messages have no user_id
                            conversation_id=final_conversation_id, # Use captured ID
                            role=MessageRole.ASSISTANT,
                            content=full_response_content,
                            prompt_tokens=None, completion_tokens=None, total_tokens=None
                        )
                        post_stream_db.add(ai_message)

                        # Decrement user credit (using new session)
                        current_db_user.credits -= 1
                        post_stream_db.add(current_db_user)

                        # Update conversation timestamp (using new session)
                        current_conversation = post_stream_db.get(Conversation, final_conversation_id)
                        if current_conversation:
                            ai_message_timestamp = getattr(ai_message, 'timestamp', None) or datetime.now(timezone.utc)
                            current_conversation.updated_at = ai_message_timestamp
                            post_stream_db.add(current_conversation)

                        post_stream_db.commit()
                        logger.info(f"AI Response saved (Convo: {final_conversation_id}), User {user_id} credits decremented to {current_db_user.credits}")
                        # Add updated credits to response headers for frontend
                        response_headers["X-User-Credits"] = str(current_db_user.credits)

                    except Exception as db_exc:
                        logger.error(f"DB Error during post-stream save for convo {final_conversation_id}: {db_exc}", exc_info=True)
                        post_stream_db.rollback()
                        # Don't yield error, stream already finished. Log for monitoring.

            except Exception as e_stream:
                logger.error(f"Error during streaming generation for convo {final_conversation_id}: {e_stream}", exc_info=True)
                # Yield a final error message chunk if streaming itself failed
                yield f"\n\n--- Server Error during response generation ---"
            finally:
                # The 'with Session(engine)' block handles session closure automatically
                pass

        # --- StreamingResponse with updated headers ---
        response = StreamingResponse(stream_and_save(), media_type="text/plain")
        for k, v in response_headers.items():
            response.headers[k] = v
        return response

    except HTTPException:
        # db.rollback() # Rollback original session if needed (Depends context usually handles it)
        raise
    except Exception as e:
        # db.rollback() # Rollback original session on unexpected errors
        logger.error(f"Unexpected error in /chat/message endpoint setup for user {user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error processing chat request.")
