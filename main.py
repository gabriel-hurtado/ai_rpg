# main.py

# --- Imports ---
import logging
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from typing import Optional

from fastapi import FastAPI, Request, Depends, APIRouter
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlmodel import Session

# Database imports
from database import get_session, create_db_and_tables

# PropelAuth Imports
from propelauth_fastapi import init_auth, User as PropelUser

# Stripe Import
import stripe



# --- Configuration Constants ---
CREDITS_PER_PURCHASE = 100

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
logger.info(".env file loaded for main app.")

# --- Configure Stripe ---
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")

stripe_configured = False
if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY
    logger.info("Stripe API Key configured.")
    stripe_configured = True
    if not STRIPE_WEBHOOK_SECRET:
        logger.warning("Stripe Webhook Secret not found. Webhook verification will fail.")
    if not STRIPE_PRICE_ID:
        logger.warning("Stripe Price ID not found. Cannot create checkout sessions.")
else:
    logger.warning("Stripe Secret Key not found. Payment features disabled.")

# --- Initialize PropelAuth ---
AUTH_URL = os.getenv("PROPELAUTH_URL")
API_KEY = os.getenv("PROPELAUTH_API_KEY")
VERIFIER_KEY = os.getenv("PROPELAUTH_VERIFIER_KEY", "").replace('\\n', '\n') # Read and handle newlines

auth = None
require_user = None
optional_user = None

try:
    if not AUTH_URL or not API_KEY or not VERIFIER_KEY:
        logger.error("PropelAuth env vars missing! Auth features disabled.")
        # Set dependencies to None to avoid errors if auth fails init
        require_user = lambda: None # Dummy dependency
        optional_user = lambda: None # Dummy dependency
    else:
        auth = init_auth(AUTH_URL, API_KEY, VERIFIER_KEY)
        logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL}")
        require_user = auth.require_user
        optional_user = auth.optional_user
except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)
    require_user = lambda: None
    optional_user = lambda: None


# --- Lifespan Context Manager (for startup/shutdown) ---
@asynccontextmanager
async def lifespan(app_instance: FastAPI): # Pass app instance if needed later
    logger.info("FastAPI application starting up...")
    logger.info("Checking/Creating database tables...")
    try:
        create_db_and_tables() # Function from database.py
    except Exception as db_error:
        logger.error(f"FATAL: Database connection/table creation failed on startup: {db_error}", exc_info=True)
        # Decide if you want the app to fail startup completely here
        # raise db_error # Uncomment to stop app if DB fails
    logger.info("Startup database check complete.")
    yield
    # --- Shutdown logic (if any) ---
    logger.info("FastAPI application shutting down...")


# --- App Setup ---
# Note: Renamed 'app' variable to 'app_instance' inside lifespan to avoid shadowing
app = FastAPI(title="AI RPG Builder", version="0.2.0", lifespan=lifespan)
logger.info("FastAPI app created.")

# --- Static Files and Templates ---
# Use absolute path for reliability, especially in containers
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

if not os.path.isdir(STATIC_DIR):
     logger.warning(f"Static directory not found at: {STATIC_DIR}")
if not os.path.isdir(TEMPLATE_DIR):
     logger.warning(f"Templates directory not found at: {TEMPLATE_DIR}")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)
logger.info(f"Static files mounted from '{STATIC_DIR}'.")
logger.info(f"Jinja2 templates configured from '{TEMPLATE_DIR}'.")


# --- Root Endpoint / Frontend serving ---
@app.get("/", response_class=HTMLResponse)
async def read_root(
    request: Request,
    # Use the optional_user dependency safely, default to None if auth init failed
    user: Optional[PropelUser] = Depends(optional_user or (lambda: None)),
    db: Session = Depends(get_session)
):
    """Serves the main index.html landing/chat page."""
    db_user_data = None
    if user:
        # Use the imported get_or_create_db_user function
        db_user_instance = get_or_create_db_user(user, db) # Make sure this doesn't raise unhandled exceptions
        if db_user_instance:
            db_user_data = {"email": db_user_instance.email, "credits": db_user_instance.credits}
        else:
            logger.warning(f"Could not get/create DB user for PropelAuth user {user.user_id}")

    context = {
        "request": request,
        "app_title": app.title,
        "propel_user": user.to_dict() if user else None,
        "db_user": db_user_data,
        "propelauth_url": AUTH_URL # Pass the Auth URL for frontend JS
    }
    return templates.TemplateResponse("index.html", context)


# --- API Router Setup ---


# --- Project Imports ---
from routers.conversations import router as conversations_router
from routers.user import router as user_router
from routers.payments import router as payments_router
from routers.ai import router as ai_router
from services.db_service import get_or_create_db_user
from routers.chat_setup import router as chat_setup_router
# Remove the problematic import below
# from services.ai_service import ai_model_name # Import model info if needed

# Prefix all API routes under /api/v1
api_router_v1 = APIRouter(prefix="/api/v1")

@api_router_v1.get("/config", tags=["App Config"])
async def get_app_config():
    """Returns basic configuration info for the frontend."""
    logger.info("GET request for '/api/v1/config'")
    # Define google_ai_configured and ai_model_name based on env vars
    google_ai_configured = bool(os.getenv("GOOGLE_API_KEY"))
    ai_model_name = os.getenv("GOOGLE_GENERATIVE_AI_MODEL", "models/gemini-1.5-flash-latest") # Provide a default

    return {
        "ai_model_name": ai_model_name if google_ai_configured else "AI Disabled",
        "stripe_configured": stripe_configured and bool(STRIPE_PRICE_ID),
        "credits_per_purchase": CREDITS_PER_PURCHASE,
        # Add any other non-sensitive config the frontend might need
    }


# --- Include specific API Routers ---
# Assumes you have these files in a 'routers' sub-directory
# Ensure chat_router is defined or replaced if it was a typo for conversations_router
# Assuming chat_router was meant to be conversations_router based on imports
api_router_v1.include_router(conversations_router) # Handles /api/v1/conversations/* and potentially /chat/* if combined
# If ai_router handles /chat/message, it should be included. Check prefixes.
# api_router_v1.include_router(ai_router) # Handles /api/v1/ai/* (or similar) - Check prefix in ai.py
api_router_v1.include_router(user_router) # Handles /api/v1/user/*
api_router_v1.include_router(payments_router) # Handles /api/v1/payments/* (or similar) - Check prefix in payments.py
api_router_v1.include_router(chat_setup_router) # ---> INCLUDE THE NEW ROUTER <--- Handles /api/v1/chat/setup/*

# Mount the main API router to the app
app.include_router(api_router_v1)

logger.info("API routers included.")

# --- Add Stripe Webhook Endpoint Directly (Common practice) ---
# Needs to be defined separately as it often doesn't need the /api/v1 prefix or auth
from routers.payments import stripe_webhook_endpoint # Assuming the handler function is in payments router file

@app.post("/webhook/stripe", tags=["Payments"], include_in_schema=False) # Exclude from OpenAPI docs
async def webhook_received(request: Request, db: Session = Depends(get_session)):
    """Endpoint to receive Stripe webhook events."""
    return await stripe_webhook_endpoint(request, db)

logger.info("Stripe webhook endpoint registered.")

# --- Add any other top-level routes if needed ---

if __name__ == "__main__":
    # This block is generally not used when running with Uvicorn CLI or Docker
    # but can be useful for direct script execution testing.
    import uvicorn
    logger.info("Running directly with Uvicorn (likely for testing)...")
    uvicorn.run(app, host="0.0.0.0", port=8000)