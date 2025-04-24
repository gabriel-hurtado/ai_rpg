# models.py
from sqlmodel import SQLModel, Field, Relationship
from typing import Optional, List
from datetime import datetime, timezone

# Forward reference for relationship
class ChatMessage(SQLModel):
    pass

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    propelauth_user_id: str = Field(index=True, unique=True)
    email: str = Field(index=True, unique=True)

    # --- Credit System Fields ---
    credits: int = Field(default=0)
    # Store timezone-aware datetime (e.g., UTC)
    credit_activation_time: Optional[datetime] = Field(default=None)
    ai_interactions_used: int = Field(default=0)

    # --- Relationship to Chat Messages ---
    chat_messages: List["ChatMessage"] = Relationship(back_populates="user")

    class Config:
        # May be needed if using timezone-aware datetimes directly
        # arbitrary_types_allowed = True
        pass

class ChatMessage(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True) # Link to User
    role: str = Field(index=True) # 'user' or 'model' (Gemini uses 'model')
    content: str # The actual message text (use TEXT type in DB)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)

    # --- Relationship back to User ---
    user: Optional[User] = Relationship(back_populates="chat_messages")