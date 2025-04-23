# main.py

from fastapi import FastAPI, Request, Depends, HTTPException # Added Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import os
import logging

# Database imports
from database import create_db_and_tables, get_session, engine # Added engine
from models import User as DBUser # Rename local User model
from sqlmodel import Session, select # Added select

# ---> ADD PropelAuth Imports <---
from propelauth_fastapi import init_auth, User as PropelUser # Rename PropelUser

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
logger.info(".env file loaded for main app.")

# ---> Initialize PropelAuth <---
try:
    AUTH_URL = os.getenv("PROPELAUTH_URL")
    API_KEY = os.getenv("PROPELAUTH_API_KEY")
    VERIFIER_KEY = os.getenv("PROPELAUTH_VERIFIER_KEY","").replace('\\n', '\n') # Read and replace \n

    if not AUTH_URL or not API_KEY or not VERIFIER_KEY:
        logger.error("PropelAuth environment variables not fully set!")
        raise ValueError("Missing PropelAuth configuration in .env file")

    auth = init_auth(AUTH_URL, API_KEY, VERIFIER_KEY)
    logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL}")

    # ---> Define Auth Dependencies <---
    require_user = auth.require_user # Enforces login
    optional_user = auth.optional_user # Allows logged-out users

except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)
    # Decide how to handle this - maybe raise error or disable auth features
    auth = None # Indicate auth failed
    require_user = None
    optional_user = None


# Create the FastAPI application instance
app = FastAPI(title="AI RPG", version="0.1.0")
logger.info("FastAPI app created.")

# Startup event handler (already here)
@app.on_event("startup")
def on_startup():
    logger.info("FastAPI application starting up...")
    create_db_and_tables()
    logger.info("Startup tasks complete.")

# Mount static files (already here)
app.mount("/static", StaticFiles(directory="static"), name="static")
logger.info("Static files mounted from 'static' directory.")

# Configure Jinja2 templates (already here)
templates = Jinja2Templates(directory="templates")
logger.info("Jinja2 templates configured from 'templates' directory.")

# ---> Helper Function: Sync PropelAuth user to DB <---
async def get_or_create_db_user(propel_user: PropelUser, db: Session = Depends(get_session)) -> DBUser:
    """
    Finds a user in the local DB by propelauth_user_id or creates one if not found.
    Uses FastAPI Depends to inject the database session.
    """
    if not propel_user or not propel_user.user_id:
         # Should not happen if called correctly, but good safeguard
        logger.warning("get_or_create_db_user called with invalid PropelUser")
        return None

    logger.info(f"Looking for/creating DB user for PropelAuth ID: {propel_user.user_id}")
    try:
        # Use the injected session 'db'
        statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()

        if not db_user:
            logger.info(f"User {propel_user.user_id} not found in DB, creating new entry.")
            # Attempt to get email - might not always be present depending on signup method
            user_email = propel_user.email or f"user_{propel_user.user_id}@placeholder.ai" # Fallback email

            db_user = DBUser(
                propelauth_user_id=propel_user.user_id,
                email=user_email
                # has_paid defaults to False
            )
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")
        else:
            logger.info(f"Found existing DB user with ID: {db_user.id}")

        return db_user
    except Exception as e:
        logger.error(f"Database error in get_or_create_db_user for {propel_user.user_id}: {e}", exc_info=True)
        db.rollback() # Rollback transaction on error
        raise HTTPException(status_code=500, detail="Database operation failed")


# ---> Modify Root Endpoint for Auth <---
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: PropelUser | None = Depends(optional_user), db: Session = Depends(get_session)): # Inject DB session
    logger.info(f"GET request for '/' - User authenticated: {user is not None}")
    db_user_data = None
    if user:
        # Sync user to DB if logged in
        db_user_instance = await get_or_create_db_user(user, db) # Pass the DB session
        if db_user_instance:
             # Prepare data to pass to template (don't pass the whole ORM object)
             db_user_data = {
                 "email": db_user_instance.email,
                 "has_paid": db_user_instance.has_paid
             }

    context = {
        "request": request,
        "app_title": app.title,
        "propel_user": user.to_dict() if user else None, # Pass Propel user info as dict
        "db_user": db_user_data, # Pass our DB user info
        "propelauth_url": AUTH_URL # Pass Auth URL for frontend JS
    }
    return templates.TemplateResponse("index.html", context)


# ---> ADD Protected Endpoint Example <---
# Prefix API routes for clarity
from fastapi import APIRouter
api_router = APIRouter(prefix="/api/v1")

@api_router.get("/user/me")
async def get_current_user_info(
    request: Request,
    user: PropelUser = Depends(require_user), # Enforce login
    db: Session = Depends(get_session)
):
    """Returns information about the currently logged-in user."""
    logger.info(f"GET request for '/api/v1/user/me' by user: {user.user_id}")
    # Get potentially updated info from our DB
    db_user_instance = await get_or_create_db_user(user, db)
    if not db_user_instance:
         # This shouldn't normally happen if require_user worked
         raise HTTPException(status_code=404, detail="User not found in database after login.")

    return {
        "propel_user_id": user.user_id,
        "email": db_user_instance.email, # Use email from our DB (could be updated)
        "org_member_info": user.org_member_info, # Pass org info if using PropelAuth orgs
        # Add info from our DB:
        "has_paid": db_user_instance.has_paid,
        "db_id": db_user_instance.id
    }

# Mount the API router
app.include_router(api_router)