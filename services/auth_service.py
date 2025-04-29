from fastapi import Depends, HTTPException
from main import PropelUser, require_user, optional_user
from typing import Optional

async def safe_require_user(user: Optional[PropelUser] = Depends(require_user)) -> PropelUser:
    if not require_user:
        raise HTTPException(status_code=503, detail="Auth service unavailable")
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user

async def safe_optional_user(user: Optional[PropelUser] = Depends(optional_user)) -> Optional[PropelUser]:
    return user
