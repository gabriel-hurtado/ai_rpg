# --- Imports ---
import logging
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Depends, APIRouter
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlmodel import Session
from typing import Optional

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

auth = None
require_user = None
optional_user = None

try:
    if not AUTH_URL or not API_KEY:
        logger.error("PropelAuth env vars missing! Auth features disabled.")
    else:
        auth = init_auth(AUTH_URL, API_KEY)
        logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL}")
        require_user = auth.require_user
        optional_user = auth.optional_user
except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)

# --- Import AI Service ---
from services.ai_service import ai_model

# --- Lifespan Context Manager ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("FastAPI application starting up...")
    logger.info("Creating database tables if they don't exist...")
    create_db_and_tables()
    logger.info("Startup tasks complete.")
    yield
    logger.info("FastAPI application shutting down...")

# --- App Setup ---
app = FastAPI(title="AI RPG Builder", version="0.2.0", lifespan=lifespan)
logger.info("FastAPI app created.")

# --- Static Files and Templates ---
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
logger.info("Static files and Jinja2 templates configured.")

# --- Root Endpoint ---
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: Optional[PropelUser] = Depends(optional_user) if optional_user else None, db: Session = Depends(get_session)):
    db_user_data = None
    if user:
        db_user_instance = await get_or_create_db_user(user, db)
        if db_user_instance:
            db_user_data = {"email": db_user_instance.email, "credits": db_user_instance.credits}
    context = {
        "request": request,
        "app_title": app.title,
        "propel_user": user.to_dict() if user else None,
        "db_user": db_user_data,
        "propelauth_url": AUTH_URL
    }
    return templates.TemplateResponse("index.html", context)

# --- API Router and Config Endpoint ---
from routers.conversations import router as conversations_router
from routers.user import router as user_router
from routers.payments import router as payments_router
from routers.ai import router as ai_router
from services.db_service import get_or_create_db_user

api_router = APIRouter(prefix="/api/v1")

@api_router.get("/config")
async def get_app_config():
    logger.info("GET request for '/api/v1/config'")
    return {
        "ai_model_name": ai_model.model_name if ai_model else "N/A",
        "stripe_configured": stripe_configured and bool(STRIPE_PRICE_ID),
        "credits_per_purchase": CREDITS_PER_PURCHASE
    }

# --- Router Registration ---
api_router.include_router(conversations_router)
api_router.include_router(user_router)
api_router.include_router(payments_router)
api_router.include_router(ai_router)
app.include_router(api_router)