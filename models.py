# models.py
from sqlmodel import SQLModel, Field
from typing import Optional
# from datetime import datetime # Uncomment if using datetime fields later

# Define the User database model using SQLModel
# 'table=True' makes this class represent a database table
class User(SQLModel, table=True):
    # Optional[int] means it can be None before saving, but will be an int after.
    # default=None is required for primary keys that auto-increment.
    id: Optional[int] = Field(default=None, primary_key=True)

    # Store the unique user ID provided by PropelAuth
    # index=True makes lookups by this field faster
    # unique=True ensures no two users have the same PropelAuth ID
    propelauth_user_id: str = Field(index=True, unique=True)

    # Store the user's email
    # index=True and unique=True are good for emails as well
    email: str = Field(index=True, unique=True)

    # Flag to track payment status from Stripe
    # default=False means new users haven't paid yet
    has_paid: bool = Field(default=False)

    # --- Future fields example (uncomment and import datetime if needed) ---
    # created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    # updated_at: Optional[datetime] = Field(default=None, sa_column_kwargs={"onupdate": datetime.utcnow})

    class Config:
        # Example configuration if needed later
        pass