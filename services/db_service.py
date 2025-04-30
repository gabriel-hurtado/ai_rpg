from datetime import datetime, timezone
from logging import getLogger
from sqlmodel import Session, select
# Import necessary models directly
from models import User, Conversation, ChatMessage, MessageRole

logger = getLogger(__name__)

# Define the start message here or import from a config file
START_MESSAGE = """Ready to forge your next legend? ... (rest of message)""" # Keep the full message

def _create_playground_conversation_internal(db_user: User, db: Session) -> None:
    """Internal helper to create playground conversation and message."""
    try:
        new_conversation = Conversation(user_id=db_user.id, title="New Adventure")
        db.add(new_conversation)
        # Commit conversation first to get its ID
        db.commit()
        db.refresh(new_conversation)

        welcome_message = ChatMessage(
            # user_id=db_user.id, # Optional: Link welcome message to user?
            conversation_id=new_conversation.id,
            role=MessageRole.ASSISTANT,
            content=START_MESSAGE,
        )
        db.add(welcome_message)
        db.commit()
        # No need to refresh welcome_message unless you need its ID immediately after
        logger.info(f"Created playground conversation {new_conversation.id} for user {db_user.id}")
    except Exception as e:
        logger.error(f"Failed to create playground conversation for user {db_user.id}: {e}", exc_info=True)
        db.rollback() # Rollback if creation fails


def get_or_create_db_user(propel_user, db: Session) -> User | None:
    if not propel_user or not propel_user.user_id:
        logger.warning("Attempted get_or_create_db_user with invalid PropelUser")
        return None

    try:
        statement = select(User).where(User.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()

        if not db_user:
            logger.info(f"Creating new DB User for PropelAuth ID: {propel_user.user_id}")
            user_email = propel_user.email or f"user_{propel_user.user_id}@placeholder.ai"
            db_user = User(
                propelauth_user_id=propel_user.user_id,
                email=user_email,
                credits=0, # Start new users with 0 credits
            )
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")

            # Create playground conversation for new users using the internal function
            _create_playground_conversation_internal(db_user, db)

        return db_user

    except Exception as e:
        logger.error(f"DB error in get_or_create_db_user for {propel_user.user_id}: {e}", exc_info=True)
        db.rollback()
        return None


def check_credit_status(db_user: User) -> tuple[bool, str]:
    """Checks if the user has any credits."""
    if not db_user:
        return False, "User not found."
    if db_user.credits <= 0:
        return False, "Insufficient credits."
    return True, "Credit available."
