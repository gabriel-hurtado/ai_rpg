# main.py - Complete with Credit System, AI Integration, Config Endpoint

from typing import List
from fastapi import FastAPI, Request, Depends, HTTPException, Header, APIRouter, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import os
import logging
from datetime import datetime, timedelta, timezone
import asyncio
from contextlib import asynccontextmanager # For newer FastAPI lifespan

# Pydantic for request body validation
from pydantic import BaseModel

# Database imports
# Use create_all for now, comment out/remove if switching to Alembic
from database import create_db_and_tables, get_session, engine
from models import User as DBUser, ChatMessage # Import the models
from sqlmodel import Session, select, col # Added col for ordering

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
        auth = init_auth(AUTH_URL, API_KEY)
        logger.info(f"PropelAuth initialized for Auth URL: {AUTH_URL}")
        require_user = auth.require_user
        optional_user = auth.optional_user
except Exception as e:
    logger.error(f"Failed to initialize PropelAuth: {e}", exc_info=True)

# --- Configure Google AI ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model = None
SYSTEM_PROMPT = """You are a creative assistant for generating Tabletop Roleplaying Game (TTRPG) content. \
Your goal is to help Game Masters (GMs) build their unique homebrew worlds. \
Generate imaginative and useful content like locations, non-player characters (NPCs) with motivations, \
magic items with history, monsters with unique abilities, or plot hooks. \
Be descriptive and provide details that a GM can use in their game. \
Maintain a helpful and inspiring tone. Avoid clichés where possible unless requested. \
Format responses clearly using markdown where appropriate (like lists or emphasis), but avoid overly complex formatting."""

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        ai_model = genai.GenerativeModel(
            'gemini-2.5-pro-exp-03-25', # Use requested Pro model
            system_instruction=SYSTEM_PROMPT
            )
        google_ai_configured = True
        logger.info("Google AI Client Configured successfully with gemini-1.5-pro-latest.")
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

# --- Lifespan Context Manager (Replaces on_startup) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("FastAPI application starting up...")
    # Database setup happens here now
    create_db_and_tables() # Using create_all for now
    logger.info("Startup tasks complete.")
    yield
    # Shutdown tasks can go here if needed
    logger.info("FastAPI application shutting down...")

# --- FastAPI App Setup ---
app = FastAPI(title="AI RPG", version="0.1.0", lifespan=lifespan) # Add lifespan
logger.info("FastAPI app created.")

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
            # Initialize new fields
            db_user = DBUser(propelauth_user_id=propel_user.user_id, email=user_email, credits=0, ai_interactions_used=0, credit_activation_time=None)
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
    else: # Has credits but no activation time - likely needs first use or payment wasn't fully processed?
        logger.warning(f"User {db_user.id} has {db_user.credits} credits but no activation time.")
        # Treat as invalid until activated properly by payment/first use if desired
        return False, "Credit not activated."
    return True, "Credit valid."

# --- Google AI Helper Function ---
async def call_google_ai(prompt: str, history: List[dict] | None = None) -> str | None:
    """Calls the configured Google AI model with history and returns the text response."""
    if not google_ai_configured or not ai_model:
        logger.error("Google AI not configured.")
        return "Error: AI service is not configured."

    logger.info(f"Sending prompt to Google AI: {prompt[:80]}...")
    try:
        # Start chat uses history, send_message continues it
        chat_session = ai_model.start_chat(history=history or [])
        response = await chat_session.send_message_async(prompt)

        if not response.candidates:
             safety_info = response.prompt_feedback if hasattr(response, 'prompt_feedback') else 'Unknown reason'
             logger.warning(f"Google AI returned no candidates. Safety: {safety_info}")
             reason = f" ({response.prompt_feedback.block_reason.name})" if hasattr(response, 'prompt_feedback') and response.prompt_feedback.block_reason else ""
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
    return { # Return DB user info needed by frontend
        "propel_user_id": user.user_id, "email": db_user_instance.email,
        "credits": db_user_instance.credits,
        "credit_activation_time": db_user_instance.credit_activation_time,
        "ai_interactions_used": db_user_instance.ai_interactions_used,
        "db_id": db_user_instance.id
    }

# --- Chat History Endpoint ---
@api_router.get("/chat/history")
async def get_chat_history(user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.info(f"Fetching chat history for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user or not db_user.id:
        raise HTTPException(status_code=404, detail="User database record not found")
    statement = select(ChatMessage).where(ChatMessage.user_id == db_user.id).order_by(col(ChatMessage.timestamp).asc())
    messages = db.exec(statement).all()
    history = [{"role": msg.role, "content": msg.content, "timestamp": msg.timestamp} for msg in messages]
    logger.info(f"Returning {len(history)} messages for user {user.user_id}")
    return {"history": history}


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

# --- AI Chat Message Endpoint ---
@api_router.post("/chat/message", response_class=HTMLResponse)
async def post_chat_message(prompt: str = Form(...), user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.info(f"Chat message request from user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error")

    # 1. Check Credit
    is_valid, reason = check_credit_status(db_user)
    if not is_valid:
        logger.warning(f"Credit check failed for user {user.user_id}: {reason}")
        error_html = f"""<div id="chat-error" hx-swap-oob="true" class="alert alert-danger alert-dismissible fade show my-2" role="alert">Credit Error: {reason}<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>"""
        credits_html = f"""<span id="credits-display" hx-swap-oob="true" class="dropdown-item-text small text-muted">Credits: {db_user.credits} (N/A)</span>"""
        return HTMLResponse(content=error_html + credits_html, status_code=403)

    if not google_ai_configured or not ai_model:
         error_html = f"""<div id="chat-error" hx-swap-oob="true" class="alert alert-danger alert-dismissible fade show my-2" role="alert">AI Service Error: Not configured.<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>"""
         return HTMLResponse(content=error_html, status_code=503)

    # 2. Load History
    logger.info("Loading chat history from DB...")
    history_statement = select(ChatMessage).where(ChatMessage.user_id == db_user.id).order_by(col(ChatMessage.timestamp).asc()).limit(20) # Limit history length
    db_history = db.exec(history_statement).all()
    gemini_history = [{"role": msg.role, "parts": [{"text": msg.content}]} for msg in db_history]
    logger.info(f"Loaded {len(gemini_history)} messages for chat history.")

    # 3. Call Google AI with history
    user_prompt = prompt
    try:
        ai_response_text = await call_google_ai(user_prompt, history=gemini_history)
    except Exception as e:
        logger.error(f"AI call error: {e}", exc_info=True)
        ai_response_text = f"Error: AI service call failed ({type(e).__name__})."
        ai_result_text = None

    # --- Prepare results and update DB ---
    interactions_remaining = MAX_AI_INTERACTIONS - db_user.ai_interactions_used
    formatted_response_html = ""
    error_html = f"""<div id="chat-error" hx-swap-oob="true"></div>""" # Clear errors by default
    status_code = 200 # Default OK status

    # 4. Handle AI Response (Success or Error)
    if ai_response_text is None or ai_response_text.startswith("Error:"):
        logger.warning(f"AI Generation failed/blocked for user {user.user_id}. Reason: {ai_response_text}")
        formatted_response_html = f"""<div class="alert alert-warning" role="alert">{ai_result_text or 'AI generation failed.'}</div>"""
        # Don't save or consume credit if AI failed/blocked
        status_code = 400 if "blocked" in (ai_response_text or "").lower() else 500
    else:
        # SUCCESSFUL AI Response
        # 5. Save messages and Consume Credit
        try:
            with Session(engine) as save_session:
                user_to_update = save_session.get(DBUser, db_user.id)
                if not user_to_update: raise Exception("User disappeared during save")

                # Save user message
                user_msg_db = ChatMessage(user_id=user_to_update.id, role="user", content=user_prompt)
                save_session.add(user_msg_db)
                # Save AI model message
                ai_msg_db = ChatMessage(user_id=user_to_update.id, role="model", content=ai_response_text)
                save_session.add(ai_msg_db)
                # Consume credit
                user_to_update.ai_interactions_used += 1
                interactions_remaining = MAX_AI_INTERACTIONS - user_to_update.ai_interactions_used
                save_session.add(user_to_update)
                save_session.commit()
                logger.info(f"Saved chat messages. User {user.user_id} interaction count: {user_to_update.ai_interactions_used}")
                # Format successful response for display
                formatted_ai_response = ai_response_text.replace('\n', '<br>\n')
                formatted_response_html = f"""
                <div class="chat-message user-message p-2 my-2">
                    <strong>You:</strong><p class="m-0">{user_prompt.replace('<', '<').replace('>', '>')}</p>
                </div>
                <div class="chat-message ai-message p-2 my-2">
                    <strong>AI:</strong><p class="m-0">{formatted_ai_response}</p>
                </div>
                """
        except Exception as e:
            logger.error(f"DB error saving chat/credits for user {user.user_id}: {e}", exc_info=True)
            interactions_remaining = "DB Error"
            # Format before f-string
            safe_user_prompt_err = user_prompt.replace('<', '<').replace('>', '>')
            safe_ai_response_err = ai_response_text.replace('<', '<').replace('>', '>').replace('\n', '<br>')

            formatted_response_html = f"""
            <div class="chat-message user-message p-2 my-2">
                <strong>You:</strong><p class="m-0">{safe_user_prompt_err}</p>
            </div>
            <div class="alert alert-danger mt-2" role="alert">Error saving message to history. AI response was:<p class="m-0">{safe_ai_response_err}</p></div>
            """
            status_code = 500 # Internal error saving

    # 6. Create final HTML fragment with OOB swaps
    db.refresh(db_user) # Refresh to get latest credit count in case webhook ran
    current_credits = db_user.credits
    # Use the accurately calculated remaining count if update succeeded
    final_remaining = interactions_remaining if isinstance(interactions_remaining, int) else (MAX_AI_INTERACTIONS - db_user.ai_interactions_used)

    credits_html = f"""<span id="credits-display" hx-swap-oob="true" class="dropdown-item-text small text-muted">Credits: {current_credits} ({max(0, final_remaining)} uses left)</span>"""

    # NOTE: formatted_response_html already contains the user/ai messages OR an error alert
    # We target '#chat-message-list' with hx-swap="beforeend" in the HTML form
    # So the main content of the response is just the new messages/error for that target
    # OOB swaps handle credits and clearing previous errors

    # Send only the new messages fragment + OOB swaps
    return HTMLResponse(content=formatted_response_html + credits_html + error_html, status_code=status_code)


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
                 with Session(engine) as db_session: # Use separate session
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