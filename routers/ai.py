import logging
import json # Add this import
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Request, Form, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, col
from typing import Optional
from datetime import datetime, timezone

from database import get_session, engine
from main import PropelUser
from models import Conversation, ChatMessage, MessageRole, User
from services.ai_service import call_google_ai_stream
from services.auth_service import safe_require_user
from services.db_service import get_or_create_db_user, check_credit_status

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["ai"])

@router.post("/message")
async def chat_message_stream(
    request: Request,
    prompt: str = Form(...),
    conversation_id_form: Optional[int] = Form(None, alias="conversation_id"),
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Handles sending a message, streaming the AI response, saving messages, and decrementing credits."""
    logger.info(f"POST /chat/message User: {user.user_id}, Conversation ID Form: {conversation_id_form}, Prompt: '{prompt[:50]}...'")

    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    user_id = db_user.id

    has_credit, reason = check_credit_status(db_user)
    if not has_credit:
        logger.warning(f"Credit check failed for user {user_id}: {reason}")
        raise HTTPException(status_code=402, detail=f"Payment Required: {reason}")

    conversation_id = conversation_id_form
    conversation = None
    is_new_conversation = False
    response_headers = {}

    try:
        if conversation_id:
            conversation = db.exec(
                select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.user_id == user_id,
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
            conversation = Conversation(user_id=user_id, title=initial_title)
            db.add(conversation)
            db.commit()
            db.refresh(conversation)
            conversation_id = conversation.id
            response_headers["X-Conversation-ID"] = str(conversation_id)
            response_headers["X-Conversation-Title"] = conversation.title
            logger.info(f"Created new conversation {conversation_id} with title '{conversation.title}' for user {user_id}")

        final_conversation_id = conversation_id

        user_message = ChatMessage(
            user_id=user_id,
            conversation_id=final_conversation_id,
            role=MessageRole.USER,
            content=prompt
        )
        db.add(user_message)
        conversation.updated_at = datetime.now(timezone.utc)
        db.add(conversation)
        db.commit()
        db.refresh(user_message) # Refresh to get the ID
        db.refresh(conversation) # Refresh conversation too if needed elsewhere

        user_message_id = user_message.id # Store the user message ID

        logger.debug(f"User message saved (ID: {user_message_id}) for conversation {final_conversation_id}")

        history_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == final_conversation_id
        ).order_by(col(ChatMessage.timestamp).asc()).limit(20)
        history_messages = db.exec(history_statement).all()
        formatted_history = [
            {"role": msg.role.value, "content": msg.content}
            for msg in history_messages
        ]

        # Pass user_message_id to the generator
        async def stream_and_save(user_msg_id: int):
            full_response_content = ""
            ai_had_error = False
            ai_message_id = None # Initialize ai_message_id
            try:
                ai_stream = call_google_ai_stream(prompt, formatted_history[:-1]) # Pass history *without* the latest user message

                async for chunk in ai_stream:
                    if chunk.startswith("Error:"):
                        logger.error(f"AI service returned an error chunk: {chunk}")
                        full_response_content = chunk
                        ai_had_error = True
                        yield chunk
                    else:
                        yield chunk
                        full_response_content += chunk

                if ai_had_error or not full_response_content:
                    logger.error(f"AI stream completed with error or empty response for convo {final_conversation_id}. No DB write performed.")
                    # Optionally yield an error status JSON here if needed by frontend
                    # yield json.dumps({"error": "AI generation failed"})
                    return

                logger.info(f"AI stream completed successfully for convo {final_conversation_id}. Saving response & decrementing credit.")

                # Use a separate session for post-stream operations
                with Session(engine) as post_stream_db:
                    try:
                        current_db_user = post_stream_db.get(User, user_id)

                        if not current_db_user:
                            logger.error(f"CRITICAL: User {user_id} not found in DB during post-stream save for convo {final_conversation_id}.")
                            return
                        if current_db_user.credits <= 0:
                            logger.error(f"User {user_id} has no credits left post-stream ({current_db_user.credits}). Aborting save/decrement for convo {final_conversation_id}.")
                            return

                        ai_message = ChatMessage(
                            user_id=None, # AI messages don't have a user_id in this schema
                            conversation_id=final_conversation_id,
                            role=MessageRole.ASSISTANT,
                            content=full_response_content,
                            prompt_tokens=None, # Placeholder, update if you get token counts
                            completion_tokens=None, # Placeholder
                            total_tokens=None # Placeholder
                        )
                        post_stream_db.add(ai_message)

                        current_db_user.credits -= 1
                        post_stream_db.add(current_db_user)

                        current_conversation = post_stream_db.get(Conversation, final_conversation_id)
                        if current_conversation:
                            ai_message_timestamp = getattr(ai_message, 'timestamp', None) or datetime.now(timezone.utc)
                            current_conversation.updated_at = ai_message_timestamp
                            post_stream_db.add(current_conversation)

                        post_stream_db.commit()
                        post_stream_db.refresh(ai_message) # Refresh to get the AI message ID
                        ai_message_id = ai_message.id # Store the AI message ID

                        logger.info(f"AI Response saved (ID: {ai_message_id}, Convo: {final_conversation_id}), User {user_id} credits decremented to {current_db_user.credits}")
                        response_headers["X-User-Credits"] = str(current_db_user.credits)

                    except Exception as db_exc:
                        logger.error(f"DB Error during post-stream save for convo {final_conversation_id}: {db_exc}", exc_info=True)
                        post_stream_db.rollback()
                        # Optionally yield an error status JSON here
                        # yield json.dumps({"error": "Failed to save AI response"})
                        ai_message_id = None # Ensure ai_message_id is None if save failed

                # Yield the final JSON message if AI message was saved successfully
                if ai_message_id is not None:
                    final_data = {"userMessageId": user_msg_id, "aiMessageId": ai_message_id}
                    yield json.dumps(final_data)
                    logger.debug(f"Yielded final JSON data for convo {final_conversation_id}: {final_data}")
                else:
                     logger.warning(f"Not yielding final JSON data because ai_message_id is None for convo {final_conversation_id}")


            except Exception as e_stream:
                logger.error(f"Error during streaming generation for convo {final_conversation_id}: {e_stream}", exc_info=True)
                yield f"\n\n--- Server Error during response generation ---"
                # Optionally yield an error status JSON here
                # yield json.dumps({"error": "Streaming generation failed"})

        # Call the generator with the user_message_id
        response = StreamingResponse(stream_and_save(user_message_id), media_type="text/plain")
        for k, v in response_headers.items():
            response.headers[k] = v
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in /chat/message endpoint setup for user {user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error processing chat request.")
