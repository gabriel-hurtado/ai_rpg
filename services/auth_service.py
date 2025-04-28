from fastapi import Depends, HTTPException
from typing import Optional
from main import PropelUser, require_user, optional_user

async def safe_require_user(user: Optional[PropelUser] = Depends(require_user) if require_user else None):
    if require_user is None:
        raise HTTPException(status_code=503, detail="Auth service unavailable")
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user

async def safe_optional_user(user: Optional[PropelUser] = Depends(optional_user) if optional_user else None):
    return user
