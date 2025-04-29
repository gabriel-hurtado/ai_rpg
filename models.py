# models.py
import enum
from datetime import datetime, timezone
from sqlalchemy import CheckConstraint
from sqlalchemy.sql import func
from sqlmodel import Column, Field, Relationship, SQLModel, TEXT
from typing import List, Optional

class ChatMessage(SQLModel):
    pass

class Conversation(SQLModel):
    pass

class User(SQLModel, table=True):
    id: int = Field(default=None, primary_key=True)
    propelauth_user_id: str = Field(index=True, unique=True)
    email: str = Field(index=True, unique=True)
    credits: int = Field(default=0)

    chat_messages: List["ChatMessage"] = Relationship(back_populates="user")
    conversations: List["Conversation"] = Relationship(back_populates="user")

    __table_args__ = (
        CheckConstraint("credits >= 0", name="user_credits_check"),
    )


class Conversation(SQLModel, table=True):
    id: int = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    title: str = Field(default="New Conversation")
    created_at: datetime = Field(
        default=None,
        sa_column_kwargs={"server_default": func.now()},
        nullable=False
    )
    updated_at: datetime = Field(
        default=None,
        sa_column_kwargs={"server_default": func.now(), "onupdate": func.now()},
        nullable=False
    )
    is_active: bool = Field(default=True, index=True)

    user: User = Relationship(back_populates="conversations")
    messages: List["ChatMessage"] = Relationship(
        back_populates="conversation",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


class MessageRole(str, enum.Enum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(SQLModel, table=True):
    id: int = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, foreign_key="user.id", index=True)
    conversation_id: int = Field(foreign_key="conversation.id", index=True)
    role: MessageRole = Field(index=True)
    content: str = Field(sa_column=Column(TEXT, nullable=False))
    timestamp: datetime = Field(
        default=None,
        sa_column_kwargs={"server_default": func.now()},
        index=True,
        nullable=False
    )
    prompt_tokens: Optional[int] = Field(default=None)
    completion_tokens: Optional[int] = Field(default=None)
    total_tokens: Optional[int] = Field(default=None)

    user: Optional[User] = Relationship(back_populates="chat_messages")
    conversation: Conversation = Relationship(back_populates="messages")