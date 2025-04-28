# models.py
import enum
from sqlmodel import SQLModel, Field, Relationship, Column, TEXT
# Add CheckConstraint import
from sqlalchemy import CheckConstraint
from sqlalchemy.sql import func
from typing import Optional, List
from datetime import datetime, timezone

# Forward references (keep these)
class ChatMessage(SQLModel):
    pass

class Conversation(SQLModel):
    pass

# Corrected User Model
class User(SQLModel, table=True):
    id: int = Field(default=None, primary_key=True)
    propelauth_user_id: str = Field(index=True, unique=True, sa_column_kwargs={"unique": True})
    email: str = Field(index=True, unique=True, sa_column_kwargs={"unique": True})

    # --- Credit System Fields ---
    # Remove sa_column_kwargs from here
    credits: int = Field(default=0)

    # --- Relationship to Chat Messages and Conversations ---
    chat_messages: List["ChatMessage"] = Relationship(back_populates="user")
    conversations: List["Conversation"] = Relationship(back_populates="user")

    # --- Table Arguments for Constraints ---
    # Define the check constraint at the table level
    __table_args__ = (
        CheckConstraint("credits >= 0", name="user_credits_check"),
        # Add other table-level constraints here if needed (e.g., multi-column unique)
    )


# Conversation Model (No changes needed here based on the error)
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

# MessageRole Enum (No changes needed)
class MessageRole(str, enum.Enum):
    USER = "user"
    ASSISTANT = "assistant"

# ChatMessage Model (No changes needed here based on the error)
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