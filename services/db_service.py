from models import User
from sqlmodel import Session, select
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)

def get_or_create_db_user(propel_user, db: Session):
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
                credits=0
            )
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")
        return db_user
    except Exception as e:
        logger.error(f"DB error in get_or_create_db_user for {propel_user.user_id}: {e}", exc_info=True)
        db.rollback()
        return None

def check_credit_status(db_user: "User") -> tuple[bool, str]:
    """Checks if the user has any credits."""
    if not db_user:
        return False, "User not found."
    if db_user.credits <= 0:
        return False, "Insufficient credits."
    return True, "Credit available."
