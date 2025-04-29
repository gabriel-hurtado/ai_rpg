import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Form, Response
from sqlmodel import Session, select, col
from models import Conversation, ChatMessage, MessageRole
from services.auth_service import safe_require_user
from services.db_service import get_or_create_db_user, check_credit_status
from database import get_session

START_MESSAGE = """Ready to forge your next legend? Let's design an unforgettable TTRPG adventure together!
Tell me about the story you want to tell. What's the genre (fantasy, sci-fi, horror, mystery?), the mood, or the central theme?
Do you have a starting spark – a cool location, a compelling villain, a unique monster, or just a general idea?
Most importantly: Where do you need your AI co-creator the most? Are we brainstorming plot hooks, fleshing out NPCs, designing challenging encounters, mapping dungeons, creating unique items, or something else entirely?"""

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


def create_playground_conversation(db_user, db):
    """
    Helper to create a new playground conversation and welcome message for a user.
    Returns the new conversation and welcome message.
    """
    new_conversation = Conversation(user_id=db_user.id, title="New Adventure")
    db.add(new_conversation)
    db.commit()
    db.refresh(new_conversation)

    welcome_message = ChatMessage(
        user_id=db_user.id,
        conversation_id=new_conversation.id,
        role=MessageRole.ASSISTANT,
        content=START_MESSAGE,
    )
    db.add(welcome_message)
    db.commit()
    db.refresh(welcome_message)
    return new_conversation, welcome_message


@router.get("/", response_model=List[dict])
async def get_conversations(
    user=Depends(safe_require_user), db: Session = Depends(get_session)
):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        statement = select(Conversation).where(
            Conversation.user_id == db_user.id, Conversation.is_active == True
        ).order_by(col(Conversation.updated_at).desc())
        conversations = db.exec(statement).all()
        logger.info(f"Found {len(conversations)} active conversations for user {user.user_id}")
        return [
            {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at.isoformat(),
                "updated_at": conv.updated_at.isoformat(),
            }
            for conv in conversations
        ]
    except Exception as e:
        logger.error(
            f"Error fetching conversations for user {user.user_id}: {e}", exc_info=True
        )
        raise HTTPException(status_code=500, detail="Database error fetching conversations.")


@router.post("/", response_model=dict, status_code=201)
async def create_conversation(
    user=Depends(safe_require_user), db: Session = Depends(get_session)
):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        new_conversation = Conversation(user_id=db_user.id, title="New Chat")
        db.add(new_conversation)
        db.commit()
        db.refresh(new_conversation)
        logger.info(f"New conversation created with ID {new_conversation.id} for user {user.user_id}")
        return {
            "id": new_conversation.id,
            "title": new_conversation.title,
            "created_at": new_conversation.created_at.isoformat(),
            "updated_at": new_conversation.updated_at.isoformat(),
        }
    except Exception as e:
        logger.error(
            f"Error creating conversation for user {user.user_id}: {e}", exc_info=True
        )
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error creating conversation.")


@router.get("/{conversation_id}", response_model=dict)
async def get_conversation_details(
    conversation_id: int, user=Depends(safe_require_user), db: Session = Depends(get_session)
):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True,
            )
        ).first()
        if not conversation:
            logger.warning(
                f"Conversation {conversation_id} not found or access denied for user {user.user_id}"
            )
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        messages_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.is_active == True
        ).order_by(col(ChatMessage.timestamp).asc())
        messages = db.exec(messages_statement).all()
        logger.info(f"Found {len(messages)} messages for conversation {conversation_id}")
        formatted_messages = [
            {
                "id": msg.id,
                "role": msg.role.value,
                "content": msg.content,
                "timestamp": msg.timestamp.isoformat(),
                "prompt_tokens": msg.prompt_tokens,
                "completion_tokens": msg.completion_tokens,
                "total_tokens": msg.total_tokens,
            }
            for msg in messages
        ]
        return {
            "conversation": {
                "id": conversation.id,
                "title": conversation.title,
                "created_at": conversation.created_at.isoformat(),
                "updated_at": conversation.updated_at.isoformat(),
            },
            "messages": formatted_messages,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error retrieving conversation {conversation_id} for user {user.user_id}: {e}",
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Database error retrieving conversation.")


@router.put("/{conversation_id}", response_model=dict)
async def update_conversation_title(
    conversation_id: int, payload: dict = None, user=Depends(safe_require_user), db: Session = Depends(get_session)
):
    if not payload or "title" not in payload or not isinstance(payload["title"], str):
        raise HTTPException(status_code=400, detail="Invalid payload. 'title' field (string) is required.")
    new_title = payload["title"].strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="Title cannot be empty.")

    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True,
            )
        ).first()
        if not conversation:
            logger.warning(
                f"Update failed: Conversation {conversation_id} not found or access denied for user {user.user_id}"
            )
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        conversation.title = new_title
        conversation.updated_at = datetime.now(timezone.utc)
        db.add(conversation)
        db.commit()
        db.refresh(conversation)
        logger.info(f"Conversation {conversation_id} title updated successfully.")
        return {
            "id": conversation.id,
            "title": conversation.title,
            "created_at": conversation.created_at.isoformat(),
            "updated_at": conversation.updated_at.isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error updating conversation {conversation_id} for user {user.user_id}: {e}",
            exc_info=True,
        )
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error updating conversation.")


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: int, user=Depends(safe_require_user), db: Session = Depends(get_session)
):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True,
            )
        ).first()
        if not conversation:
            logger.warning(
                f"Delete failed: Conversation {conversation_id} not found, already deleted, or access denied for user {user.user_id}"
            )
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        conversation.is_active = False
        conversation.updated_at = datetime.now(timezone.utc)
        db.add(conversation)
        db.commit()
        logger.info(f"Conversation {conversation_id} soft deleted successfully for user {user.user_id}")

        # Check if user has any active conversations left
        remaining = db.exec(
            select(Conversation).where(
                Conversation.user_id == db_user.id,
                Conversation.is_active == True,
            )
        ).all()
        if not remaining:
            create_playground_conversation(db_user, db)
            logger.info(f"Created playground conversation for user {user.user_id} after deleting last conversation.")
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error deleting conversation {conversation_id} for user {user.user_id}: {e}",
            exc_info=True,
        )
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error deleting conversation.")


@router.delete("/{conversation_id}/messages/{message_id}", status_code=204)
async def delete_user_message(
    conversation_id: int,
    message_id: int,
    user=Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    # Fetch the message, ensure it's a user message and belongs to the user
    message = db.exec(
        select(ChatMessage).where(
            ChatMessage.id == message_id,
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.role == MessageRole.USER,
            ChatMessage.is_active == True
        )
    ).first()
    if not message:
        raise HTTPException(status_code=404, detail="User message not found or not deletable.")

    # Confirm conversation ownership
    conversation = db.exec(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == db_user.id,
            Conversation.is_active == True
        )
    ).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found or not accessible.")

    # Recursive soft delete (is_active = False) for this message and all descendants
    def soft_delete_descendants(msg_id):
        stack = [msg_id]
        while stack:
            current_id = stack.pop()
            msg = db.exec(
                select(ChatMessage).where(
                    ChatMessage.id == current_id,
                    ChatMessage.is_active == True
                )
            ).first()
            if msg:
                msg.is_active = False
                db.add(msg)
                # Find children
                children = db.exec(
                    select(ChatMessage.id).where(
                        ChatMessage.parent_id == current_id,
                        ChatMessage.is_active == True
                    )
                ).all()
                stack.extend([child.id for child in children])
    try:
        soft_delete_descendants(message.id)
        db.commit()
        return Response(status_code=204)
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting user message {message_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Database error deleting message.")


@router.post("/playground_start", response_model=dict, status_code=201)
async def playground_start(user=Depends(safe_require_user), db: Session = Depends(get_session)):
    db_user = get_or_create_db_user(user, db)
    if not db_user:
        raise HTTPException(status_code=500, detail="User data error.")

    try:
        # 1. Create conversation
        new_conversation, welcome_message = create_playground_conversation(db_user, db)

        return {
            "conversation": {
                "id": new_conversation.id,
                "title": new_conversation.title,
                "created_at": new_conversation.created_at.isoformat(),
                "updated_at": new_conversation.updated_at.isoformat(),
            },
            "initial_message": {
                "id": welcome_message.id,
                "role": welcome_message.role,
                "content": welcome_message.content,
                "timestamp": welcome_message.timestamp.isoformat()
            }
        }
    except Exception as e:
        logger.error(f"Error starting playground chat for user {user.user_id}: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error starting playground chat.")
