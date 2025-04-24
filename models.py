# models.py
from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime, timezone # Import datetime, timezone

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    propelauth_user_id: str = Field(index=True, unique=True)
    email: str = Field(index=True, unique=True)

    # --- Credit System Fields ---
    credits: int = Field(default=0)
    # Store timezone-aware datetime (e.g., UTC)
    credit_activation_time: Optional[datetime] = Field(default=None)
    ai_interactions_used: int = Field(default=0)

    class Config:
        # May be needed if using timezone-aware datetimes directly
        # arbitrary_types_allowed = True
        pass