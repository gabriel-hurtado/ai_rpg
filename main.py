# main.py - Incorporating Phase 4: AI Integration

from fastapi import FastAPI, Request, Depends, HTTPException, Header, APIRouter, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import os
import logging
from datetime import datetime, timedelta, timezone
import asyncio # Needed for placeholder sleep

# Pydantic for request body validation
from pydantic import BaseModel

# Database imports
# Use create_all for now, comment out/remove if switching to Alembic
from database import create_db_and_tables, get_session, engine
from models import User as DBUser # Import the User model
from sqlmodel import Session, select

# PropelAuth Imports
from propelauth_fastapi import init_auth, User as PropelUser

# Stripe Import
import stripe

# Google AI Import
import google.generativeai as genai

# --- Configuration Constants ---
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
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")

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
        logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL}")
        require_user = auth.require_user
        optional_user = auth.optional_user
except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)

# --- Configure Google AI ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model = None

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        ai_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        google_ai_configured = True
        logger.info("Google AI Client Configured successfully.")
    except Exception as e:
        logger.error(f"Failed to configure Google AI: {e}", exc_info=True)
else:
    logger.warning("GOOGLE_API_KEY not found in .env. AI features disabled.")


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
    create_db_and_tables() # Using create_all for now
    logger.info("Startup tasks complete.")

# --- Static Files and Templates ---
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
logger.info("Static files and Jinja2 templates configured.")

# --- Database User Sync Helper ---
async def get_or_create_db_user(propel_user: PropelUser, db: Session = Depends(get_session)) -> DBUser | None:
    if not propel_user or not propel_user.user_id: return None
    logger.info(f"DB Check/Create for PropelAuth ID: {propel_user.user_id}")
    try:
        statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()
        if not db_user:
            logger.info(f"Creating DB User {propel_user.user_id}...")
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
    if not db_user or db_user.credits <= 0: return False, "No active credits."
    if db_user.ai_interactions_used >= MAX_AI_INTERACTIONS: return False, "Credit interaction limit reached."
    if db_user.credit_activation_time:
        now_utc = datetime.now(timezone.utc)
        activation_utc = db_user.credit_activation_time if db_user.credit_activation_time.tzinfo else db_user.credit_activation_time.replace(tzinfo=timezone.utc)
        expiry_time = activation_utc + timedelta(days=CREDIT_DURATION_DAYS)
        if now_utc >= expiry_time:
            logger.info(f"Credit expired for user {db_user.id}.")
            return False, "Credit has expired."
    else:
        logger.warning(f"User {db_user.id} has credits but no activation time.")
        return False, "Credit activation time missing."
    return True, "Credit valid."

# --- Google AI Helper Function ---
async def call_google_ai(prompt: str) -> str | None:
    if not google_ai_configured or not ai_model:
        logger.error("Google AI not configured.")
        return "Error: AI service is not configured."
    logger.info(f"Sending prompt to Google AI: {prompt[:80]}...")
    try:
        response = await ai_model.generate_content_async(prompt)
        if not response.candidates:
             safety_info = response.prompt_feedback if hasattr(response, 'prompt_feedback') else 'Unknown reason'
             logger.warning(f"Google AI returned no candidates. Safety: {safety_info}")
             reason = f"({response.prompt_feedback.block_reason.name})" if hasattr(response, 'prompt_feedback') and response.prompt_feedback.block_reason else ""
             return f"Error: Content blocked due to safety settings {reason}. Please revise prompt."
        if hasattr(response, 'text'):
             logger.info("Google AI response received.")
             return response.text
        else:
             logger.warning("Google AI response candidate missing 'text'.")
             return "Error: AI model returned unexpected format."
    except Exception as e:
        logger.error(f"Error calling Google AI API: {e}", exc_info=True)
        return f"Error: Could not connect to AI service ({type(e).__name__})."


# === ROOT ENDPOINT ===
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: PropelUser | None = Depends(safe_optional_user), db: Session = Depends(get_session)):
    logger.info(f"GET request for '/' - User authenticated: {user is not None}")
    db_user_data = None
    if user:
        db_user_instance = await get_or_create_db_user(user, db)
        if db_user_instance:
             db_user_data = { "email": db_user_instance.email, "credits": db_user_instance.credits, "credit_activation_time": db_user_instance.credit_activation_time, "ai_interactions_used": db_user_instance.ai_interactions_used }
    context = {
        "request": request, "app_title": app.title,
        "propel_user": user.to_dict() if user else None,
        "db_user": db_user_data, "propelauth_url": AUTH_URL }
    # logger.debug(f"Passing propelauth_url to template: {AUTH_URL}")
    return templates.TemplateResponse("index.html", context)

# === API ROUTES ===
api_router = APIRouter(prefix="/api/v1")

# --- Config Endpoint ---
@api_router.get("/config")
async def get_app_config():
    logger.info("GET request for '/api/v1/config'")
    return { "max_ai_interactions": MAX_AI_INTERACTIONS, "credit_duration_days": CREDIT_DURATION_DAYS }

# --- User Info Endpoint ---
@api_router.get("/user/me")
async def get_current_user_info(request: Request, user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.info(f"GET request for '/api/v1/user/me' by user: {user.user_id}")
    db_user_instance = await get_or_create_db_user(user, db)
    if not db_user_instance: raise HTTPException(status_code=500, detail="User data error.")
    return {
        "propel_user_id": user.user_id, "email": db_user_instance.email,
        "credits": db_user_instance.credits,
        "credit_activation_time": db_user_instance.credit_activation_time,
        "ai_interactions_used": db_user_instance.ai_interactions_used,
        "db_id": db_user_instance.id
    }

# --- Stripe Checkout Endpoint ---
@api_router.post("/create-checkout-session")
async def create_checkout_session(user: PropelUser = Depends(safe_require_user)):
    if not stripe_configured or not STRIPE_PRICE_ID: raise HTTPException(status_code=500, detail="Payment not configured.")
    logger.info(f"Creating Stripe Checkout session for user: {user.user_id}")
    try:
        checkout_session = stripe.checkout.Session.create(
            line_items=[{'price': STRIPE_PRICE_ID, 'quantity': 1}], mode='payment',
            success_url=f'{APP_BASE_URL}/payment/success?session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{APP_BASE_URL}/payment/cancel', client_reference_id=user.user_id )
        logger.info(f"Stripe session created: {checkout_session.id}")
        return {"checkout_url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Error creating session: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Payment error: {e}")

# --- AI Generation Endpoint ---
@api_router.post("/generate", response_class=HTMLResponse)
async def generate_ai_content_endpoint(prompt: str = Form(...), user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.info(f"AI generation request from user {user.user_id}")
    # Re-fetch user fresh within the transaction scope potentially
    db_user = await get_or_create_db_user(user, db) # Use the standard dependency session
    if not db_user: raise HTTPException(status_code=500, detail="User data error")

    is_valid, reason = check_credit_status(db_user)
    if not is_valid:
        logger.warning(f"Credit check failed for user {user.user_id}: {reason}")
        error_html = f"""<div id="ai-result-output" hx-swap-oob="true" class="alert alert-danger" role="alert">Credit Error: {reason}</div>"""
        # Include current credit status in OOB swap even on error
        credits_display_html = f"""<span id="credits-display" hx-swap-oob="true" class="dropdown-item-text small text-muted">Credits: {db_user.credits} (N/A uses left)</span>"""
        return HTMLResponse(content=error_html + credits_display_html, status_code=403)

    logger.info(f"Credit valid. Calling Google AI with prompt: {prompt[:50]}...") # Use prompt directly
    ai_result_text = await call_google_ai(prompt) # Pass prompt directly

    interactions_remaining = MAX_AI_INTERACTIONS - db_user.ai_interactions_used # Calculate remaining before potentially consuming
    formatted_result = ""
    credit_consumed = False # Flag to track if we actually consumed a credit

    if ai_result_text is None or ai_result_text.startswith("Error:"):
         logger.warning(f"AI Generation failed for user {user.user_id}. Reason: {ai_result_text}")
         formatted_result = f"""<div class="alert alert-warning" role="alert">{ai_result_text or 'AI generation failed.'}</div>"""
         # Don't consume credit if AI failed
    else:
        # --- Consume Credit only on SUCCESSFUL generation ---
        try:
            # Use the existing session from Depends(get_session)
            db.refresh(db_user) # Refresh before incrementing
            db_user.ai_interactions_used += 1
            is_still_valid, _ = check_credit_status(db_user) # Optional check if expiry during generation matters
            if not is_still_valid: logger.warning(f"Credit may have expired during generation for user {user.user_id}.")

            db.add(db_user)
            db.commit()
            db.refresh(db_user) # Get latest count after commit
            interactions_remaining = MAX_AI_INTERACTIONS - db_user.ai_interactions_used
            credit_consumed = True
            logger.info(f"Interaction count updated for user {user.user_id} to {db_user.ai_interactions_used}. Remaining: {interactions_remaining}")
        except Exception as e:
            logger.error(f"Failed to update interaction count for user {user.user_id}: {e}", exc_info=True)
            db.rollback() # Rollback the main session if update fails
            interactions_remaining = "DB Error"
            # Return the AI result anyway, but log the count error
            formatted_result = ai_result_text.replace('\n', '<br>\n')
            formatted_result = f"<p>{formatted_result}</p><p><small class='text-danger'>(Error updating usage count)</small></p>"


        # Format successful result only if credit wasn't consumed above due to error
        if credit_consumed:
            formatted_result = ai_result_text.replace('\n', '<br>\n')
            formatted_result = f"<p>{formatted_result}</p>"

    # --- Create HTML fragment for HTMX ---
    # Fetch latest credits again in case they were updated by webhook concurrently or if commit failed
    db.refresh(db_user)
    current_credits = db_user.credits
    # Use the accurately calculated remaining count if update succeeded
    final_remaining = interactions_remaining if isinstance(interactions_remaining, int) else (MAX_AI_INTERACTIONS - db_user.ai_interactions_used)

    html_fragment = f"""
    <div id="ai-result-output">
        {formatted_result}
    </div>
    <span id="credits-display" hx-swap-oob="true" class="dropdown-item-text small text-muted">Credits: {current_credits} ({max(0, final_remaining)} uses left)</span>
    """
    return HTMLResponse(content=html_fragment)

# Mount the API router
app.include_router(api_router)

# === STRIPE WEBHOOK ===
@app.post("/webhook/stripe")
async def stripe_webhook_endpoint(request: Request, stripe_signature: str = Header(None)):
     if not STRIPE_WEBHOOK_SECRET: raise HTTPException(status_code=500, detail="Webhook not configured")
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
                 # Use a separate session for webhook isolation
                 with Session(engine) as db_session:
                      statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user_id)
                      db_user = db_session.exec(statement).first()
                      if db_user:
                          db_user.credits = (db_user.credits or 0) + 1
                          db_user.credit_activation_time = datetime.now(timezone.utc)
                          db_user.ai_interactions_used = 0
                          db_session.add(db_user)
                          db_session.commit()
                          logger.info(f"User {propel_user_id} granted credit. Total credits: {db_user.credits}")
                      else: logger.error(f"Webhook Error: User {propel_user_id} not found for payment {stripe_session_id}.")
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

# === Keep asyncio import ===
import asyncio