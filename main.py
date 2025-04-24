# main.py

from fastapi import FastAPI, Request, Depends, HTTPException, Header, APIRouter
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import asyncio
import os
import logging
from datetime import datetime, timedelta, timezone
import asyncio # Needed for placeholder sleep

# Database imports
# Use create_all for now, comment out/remove if switching to Alembic
from database import create_db_and_tables, get_session, engine
from models import User as DBUser # Import the User model
from sqlmodel import Session, select

# PropelAuth Imports
from propelauth_fastapi import init_auth, User as PropelUser

# Stripe Import
import stripe

# --- Configuration Constants ---
# Define these centrally. Could be loaded from elsewhere too.
MAX_AI_INTERACTIONS = 100
CREDIT_DURATION_DAYS = 7

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
logger.info(".env file loaded for main app.")

# --- Configure Stripe ---
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000") # Default base URL

stripe_configured = False
if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY
    logger.info("Stripe API Key configured.")
    stripe_configured = True
    if not STRIPE_WEBHOOK_SECRET: logger.warning("Stripe Webhook Secret not found.")
    if not STRIPE_PRICE_ID: logger.warning("Stripe Price ID not found.")
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
        logger.error("PropelAuth env vars missing!")
        logger.warning("Auth features will be disabled.")
    else:
        auth = init_auth(AUTH_URL, API_KEY) # Correct initialization
        logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL} (Verifier key fetched automatically)")
        require_user = auth.require_user
        optional_user = auth.optional_user
except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)

# --- Safe Dependency Wrappers ---
async def safe_optional_user(user: PropelUser | None = Depends(optional_user) if optional_user else None):
     return user

async def safe_require_user(user: PropelUser = Depends(require_user) if require_user else None):
    if require_user is None: raise HTTPException(status_code=503, detail="Auth service unavailable")
    if user is None: raise HTTPException(status_code=401, detail="Not authenticated")
    return user

# --- FastAPI App Setup ---
app = FastAPI(title="AI RPG", version="0.1.0")
logger.info("FastAPI app created.")

# --- Startup Event ---
@app.on_event("startup")
def on_startup():
    logger.info("FastAPI application starting up...")
    # Using create_all for simplicity now. Replace with Alembic upgrade later.
    create_db_and_tables()
    logger.info("Startup tasks complete.")

# --- Static Files and Templates ---
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
logger.info("Static files and Jinja2 templates configured.")

# --- Database User Sync Helper ---
async def get_or_create_db_user(propel_user: PropelUser, db: Session = Depends(get_session)) -> DBUser | None:
    if not propel_user or not propel_user.user_id: return None
    logger.info(f"Looking for/creating DB user for PropelAuth ID: {propel_user.user_id}")
    try:
        statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()
        if not db_user:
            logger.info(f"User {propel_user.user_id} not found, creating...")
            user_email = propel_user.email or f"user_{propel_user.user_id}@placeholder.ai"
            db_user = DBUser(propelauth_user_id=propel_user.user_id, email=user_email, credits=0, ai_interactions_used=0)
            db.add(db_user); db.commit(); db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")
        else: logger.info(f"Found existing DB user with ID: {db_user.id}")
        return db_user
    except Exception as e:
        logger.error(f"DB error in get_or_create_db_user: {e}", exc_info=True)
        db.rollback(); return None

# --- Credit Status Check Helper ---
def check_credit_status(db_user: DBUser) -> tuple[bool, str]:
    """Checks if the user has valid, non-expired credit."""
    if not db_user or db_user.credits <= 0:
        return False, "No active credits."
    if db_user.ai_interactions_used >= MAX_AI_INTERACTIONS:
        return False, "Credit interaction limit reached."
    if db_user.credit_activation_time:
        # Ensure comparison uses timezone-aware datetimes (assuming UTC storage)
        now_utc = datetime.now(timezone.utc)
        activation_utc = db_user.credit_activation_time.replace(tzinfo=timezone.utc)
        expiry_time = activation_utc + timedelta(days=CREDIT_DURATION_DAYS)
        if now_utc >= expiry_time:
            logger.info(f"Credit expired for user {db_user.id}. Expiry: {expiry_time}, Now: {now_utc}")
            return False, "Credit has expired."
    else:
        logger.warning(f"User {db_user.id} has credits but no activation time.")
        return False, "Credit activation time missing."
    return True, "Credit valid."

# === ROOT ENDPOINT ===
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: PropelUser | None = Depends(safe_optional_user), db: Session = Depends(get_session)):
    logger.info(f"GET request for '/' - User authenticated: {user is not None}")
    db_user_data = None
    if user:
        db_user_instance = await get_or_create_db_user(user, db)
        if db_user_instance:
             db_user_data = { # Pass all relevant fields needed by JS
                 "email": db_user_instance.email,
                 "credits": db_user_instance.credits,
                 "credit_activation_time": db_user_instance.credit_activation_time,
                 "ai_interactions_used": db_user_instance.ai_interactions_used
             }
    context = {
        "request": request, "app_title": app.title,
        "propel_user": user.to_dict() if user else None,
        "db_user": db_user_data, "propelauth_url": AUTH_URL }
    logger.info(f"Passing propelauth_url to template: {AUTH_URL}")
    return templates.TemplateResponse("index.html", context)

# === API ROUTES ===
api_router = APIRouter(prefix="/api/v1")

# --- Config Endpoint ---
@api_router.get("/config")
async def get_app_config():
    """Returns public application configuration."""
    logger.info("GET request for '/api/v1/config'")
    return {
        "max_ai_interactions": MAX_AI_INTERACTIONS,
        "credit_duration_days": CREDIT_DURATION_DAYS,
        # Add public Stripe key if using Stripe Elements frontend later
        # "stripe_public_key": os.getenv("STRIPE_PUBLIC_KEY")
    }

# --- User Info Endpoint ---
@api_router.get("/user/me")
async def get_current_user_info(request: Request, user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.info(f"GET request for '/api/v1/user/me' by user: {user.user_id}")
    db_user_instance = await get_or_create_db_user(user, db)
    if not db_user_instance:
        logger.error(f"DB sync failed for authenticated user {user.user_id} in /user/me")
        raise HTTPException(status_code=500, detail="User data error after login.")

    return { # Return only DB and PropelAuth user ID info needed by frontend
        "propel_user_id": user.user_id,
        "email": db_user_instance.email,
        # "org_info_map": user.org_id_to_org_member_info, # Only if using orgs
        "credits": db_user_instance.credits,
        "credit_activation_time": db_user_instance.credit_activation_time,
        "ai_interactions_used": db_user_instance.ai_interactions_used,
        "db_id": db_user_instance.id
        # Config is now fetched from /api/v1/config
    }

# --- Stripe Checkout Endpoint ---
@api_router.post("/create-checkout-session")
async def create_checkout_session(user: PropelUser = Depends(safe_require_user)):
    if not stripe_configured or not STRIPE_PRICE_ID:
        logger.error("Stripe not configured for creating checkout session.")
        raise HTTPException(status_code=500, detail="Payment system not configured.")
    logger.info(f"Creating Stripe Checkout session for user: {user.user_id}")
    try:
        checkout_session = stripe.checkout.Session.create(
            line_items=[{'price': STRIPE_PRICE_ID, 'quantity': 1}],
            mode='payment',
            success_url=f'{APP_BASE_URL}/payment/success?session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{APP_BASE_URL}/payment/cancel',
            client_reference_id=user.user_id
        )
        logger.info(f"Stripe session created: {checkout_session.id}")
        return {"checkout_url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Error creating session for user {user.user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Could not initiate payment: {e}")

# --- AI Generation Placeholder Endpoint ---
@api_router.post("/generate")
async def generate_ai_content(
    request: Request, # TODO: Replace with Pydantic model for prompt
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    form_data = await request.form()
    prompt = form_data.get("prompt", "Default Prompt") # TODO: Get from model

    logger.info(f"Received AI generation request from user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error")

    is_valid, reason = check_credit_status(db_user)
    if not is_valid:
        logger.warning(f"Credit check failed for user {user.user_id}: {reason}")
        raise HTTPException(status_code=403, detail=f"Credit Error: {reason}")

    logger.info(f"Credit valid. Simulating AI call. Prompt: {prompt[:50]}...")
    # --- TODO: Replace with actual call to Google AI API ---
    # result = await call_google_ai(prompt)
    await asyncio.sleep(0.5) # Simulate AI processing time
    ai_result = f"AI generated content based on: '{prompt[:100]}...'"

    # --- Consume Credit (Increment interaction count) ---
    try:
        # Reload user to avoid race conditions if needed, or lock row
        db.refresh(db_user) # Refresh before incrementing
        db_user.ai_interactions_used += 1
        # Check if credit expired *during* generation (unlikely but possible)
        is_still_valid, _ = check_credit_status(db_user)
        if not is_still_valid:
             # This is tricky - the generation happened, but credit expired.
             # Maybe allow this one but log it, or try to rollback?
             logger.warning(f"Credit possibly expired during generation for user {user.user_id}. Interaction counted.")
             # For now, count it anyway.

        db.add(db_user)
        db.commit()
        interactions_remaining = MAX_AI_INTERACTIONS - db_user.ai_interactions_used
        logger.info(f"Interaction count updated for user {user.user_id} to {db_user.ai_interactions_used}. Remaining: {interactions_remaining}")
    except Exception as e:
        logger.error(f"Failed to update interaction count for user {user.user_id}: {e}", exc_info=True)
        db.rollback()
        interactions_remaining = "Error updating" # Indicate error
        # Decide if you should still return the result even if count failed

    # Return result
    return {"result": ai_result, "interactions_remaining": interactions_remaining}

# Mount the API router
app.include_router(api_router)


# === STRIPE WEBHOOK ===
@app.post("/webhook/stripe")
async def stripe_webhook_endpoint(request: Request, stripe_signature: str = Header(None)):
     if not STRIPE_WEBHOOK_SECRET:
         logger.error("Stripe webhook secret not configured.")
         raise HTTPException(status_code=500, detail="Webhook not configured")
     payload = await request.body()
     logger.info(f"Received Stripe webhook. Sig: {stripe_signature is not None}, Len: {len(payload)}")
     try:
         event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
         logger.info(f"Stripe event verified: {event['id']}, Type: {event['type']}")
     except Exception as e:
         logger.error(f"Webhook construct_event error: {e}", exc_info=True)
         raise HTTPException(status_code=400, detail=f"Webhook error: {e}")

     if event['type'] == 'checkout.session.completed':
         session_data = event['data']['object']
         propel_user_id = session_data.get('client_reference_id')
         stripe_session_id = session_data.get('id')
         payment_status = session_data.get('payment_status')
         logger.info(f"Processing checkout.session.completed: StripeID={stripe_session_id}, User={propel_user_id}, Status={payment_status}")

         if payment_status == 'paid' and propel_user_id:
             logger.info(f"Payment successful for user: {propel_user_id}")
             try:
                 with Session(engine) as db_session: # Use new session for webhook safety
                      statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user_id)
                      db_user = db_session.exec(statement).first()
                      if db_user:
                          db_user.credits = (db_user.credits or 0) + 1 # Increment credits
                          db_user.credit_activation_time = datetime.now(timezone.utc) # Reset activation time
                          db_user.ai_interactions_used = 0 # Reset interaction count
                          db_session.add(db_user)
                          db_session.commit()
                          logger.info(f"User {propel_user_id} granted credit. Total credits: {db_user.credits}")
                      else: logger.error(f"Webhook Error: User {propel_user_id} not found for completed payment {stripe_session_id}.")
             except Exception as e:
                  logger.error(f"DB error granting credit for user {propel_user_id}: {e}", exc_info=True)
                  raise HTTPException(status_code=500, detail="DB error processing payment")
         elif not propel_user_id: logger.error(f"Webhook Error: client_reference_id missing in session {stripe_session_id}.")
         else: logger.warning(f"Session {stripe_session_id} completed but status '{payment_status}'. No credits granted.")
     else: logger.info(f"Received unhandled Stripe event type: {event['type']}")

     return {"status": "success"}

# === PAYMENT STATUS PAGES ===
@app.get("/payment/success", response_class=HTMLResponse)
async def payment_success(request: Request, session_id: str | None = None):
    logger.info(f"User redirected to payment success page. Session ID: {session_id}")
    return templates.TemplateResponse("payment_status.html", {"request": request, "status": "Success!", "message": "Thank you! Your credit has been applied.", "propelauth_url": AUTH_URL})

@app.get("/payment/cancel", response_class=HTMLResponse)
async def payment_cancel(request: Request):
     logger.info("User redirected to payment cancel page.")
     return templates.TemplateResponse("payment_status.html", {"request": request, "status": "Cancelled", "message": "Your payment process was cancelled.", "propelauth_url": AUTH_URL})

