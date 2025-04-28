from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session
from typing import Optional
from models import User
from services.db_service import get_or_create_db_user
from services.auth_service import safe_require_user
from database import get_session
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/user", tags=["user"])

@router.get("/me")
async def get_current_user_info(user = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.debug(f"GET request for '/user/me' by user: {user.user_id}")
    db_user_instance = get_or_create_db_user(user, db)
    if not db_user_instance:
        logger.error(f"Could not find or create DB user for authenticated user {user.user_id}")
        raise HTTPException(status_code=500, detail="User data error.")
    return {
        "propel_user_id": user.user_id,
        "email": db_user_instance.email,
        "credits": db_user_instance.credits,
        "db_id": db_user_instance.id
    }
