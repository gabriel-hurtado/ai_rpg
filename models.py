# models.py
from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime, timedelta # Import datetime stuff

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    propelauth_user_id: str = Field(index=True, unique=True)
    email: str = Field(index=True, unique=True)

    # Number of active credits the user has
    credits: int = Field(default=0)

    # Timestamp when the current credit batch was activated (e.g., after payment)
    # Optional because a user might have 0 credits.
    credit_activation_time: Optional[datetime] = Field(default=None)

    # Counter for AI interactions within the current credit period
    ai_interactions_used: int = Field(default=0)

    # --- Optional: Timestamps for user record ---
    # created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    # updated_at: Optional[datetime] = Field(default=None, sa_column_kwargs={"onupdate": datetime.utcnow})

    class Config:
        pass
        # potentially add arbitrary_types_allowed = True if needed for datetime with older Pydantic/SQLModel