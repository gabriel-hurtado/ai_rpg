from datetime import datetime, timezone
from logging import getLogger
from sqlmodel import Session, select
from models import User

logger = getLogger(__name__)

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
                credits=0,
            )
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")

            # Create playground conversation for new users
            try:
                from routers.conversations import create_playground_conversation
                create_playground_conversation(db_user, db)
                logger.info(f"Created playground conversation for new user {db_user.id}")
            except Exception as e:
                logger.error(f"Failed to create playground conversation for new user {db_user.id}: {e}", exc_info=True)

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
