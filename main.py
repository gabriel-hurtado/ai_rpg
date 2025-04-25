# main.py - Final Version for Phase 4 (Credits, History, Config, Non-Streaming AI)

from fastapi import FastAPI, Request, Depends, HTTPException, Header, APIRouter, Form
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import os
import logging
from datetime import datetime, timedelta, timezone
import asyncio
from contextlib import asynccontextmanager
from typing import List, Optional

# Pydantic for request body validation (kept for potential future use)
from pydantic import BaseModel

# Database imports
from database import get_session, engine # Assuming database.py defines engine and get_session
# Using create_all for now - COMMENT OUT IF USING ALEMBIC
from database import create_db_and_tables
from models import User as DBUser, ChatMessage # Import the models
from sqlmodel import Session, select, col

# PropelAuth Imports
from propelauth_fastapi import init_auth, User as PropelUser

# Stripe Import
import stripe

# Google AI Import
import google.generativeai as genai

# Markdown Rendering
import markdown

# --- Configuration Constants ---
MAX_AI_INTERACTIONS = 100
CREDIT_DURATION_DAYS = 7

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
    if not STRIPE_WEBHOOK_SECRET: logger.warning("Stripe Webhook Secret not found in .env. Webhook verification will fail.")
    if not STRIPE_PRICE_ID: logger.warning("Stripe Price ID not found in .env. Cannot create checkout sessions.")
else:
    logger.warning("Stripe Secret Key not found in .env. Payment features will be disabled.")


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
async def safe_optional_user(user: Optional[PropelUser] = Depends(optional_user) if optional_user else None):
     return user

async def safe_require_user(user: Optional[PropelUser] = Depends(require_user) if require_user else None):
    if require_user is None: raise HTTPException(status_code=503, detail="Auth service unavailable")
    if user is None: raise HTTPException(status_code=401, detail="Not authenticated") # Should be handled by require_user itself
    return user

# --- Lifespan Context Manager ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("FastAPI application starting up...")
    # Run create_all if NOT using Alembic. Comment out if using Alembic.
    create_db_and_tables()
    logger.info("Startup tasks complete.")
    yield
    logger.info("FastAPI application shutting down...")

# --- FastAPI App Setup ---
app = FastAPI(title="AI RPG Builder", version="0.1.0", lifespan=lifespan)
logger.info("FastAPI app created.")

# --- Static Files and Templates ---
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
logger.info("Static files and Jinja2 templates configured.")

# --- Database User Sync Helper ---
async def get_or_create_db_user(propel_user: PropelUser, db: Session = Depends(get_session)) -> Optional[DBUser]:
    if not propel_user or not propel_user.user_id: return None
    # logger.debug(f"DB Check/Create for PropelAuth ID: {propel_user.user_id}") # Use debug level
    try:
        statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()
        if not db_user:
            logger.info(f"Creating DB User {propel_user.user_id}...")
            user_email = propel_user.email or f"user_{propel_user.user_id}@placeholder.ai"
            db_user = DBUser(propelauth_user_id=propel_user.user_id, email=user_email, credits=0, ai_interactions_used=0, credit_activation_time=None)
            db.add(db_user); db.commit(); db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")
        # else: logger.debug(f"Found existing DB user with ID: {db_user.id}") # Use debug level
        return db_user
    except Exception as e:
        logger.error(f"DB error in get_or_create_db_user for {propel_user.user_id}: {e}", exc_info=True)
        db.rollback(); return None

# --- Credit Status Check Helper ---
def check_credit_status(db_user: Optional[DBUser]) -> tuple[bool, str]:
    """Checks if the user has valid, non-expired credit."""
    if not db_user: return False, "User not found."
    if db_user.credits <= 0: return False, "No active credits."
    if db_user.ai_interactions_used >= MAX_AI_INTERACTIONS: return False, "Credit interaction limit reached."
    if db_user.credit_activation_time:
        now_utc = datetime.now(timezone.utc)
        activation_utc = db_user.credit_activation_time if db_user.credit_activation_time.tzinfo else db_user.credit_activation_time.replace(tzinfo=timezone.utc)
        expiry_time = activation_utc + timedelta(days=CREDIT_DURATION_DAYS)
        if now_utc >= expiry_time:
            logger.info(f"Credit expired for user {db_user.id}.")
            return False, "Credit has expired."
    else:
        logger.warning(f"User {db_user.id} has {db_user.credits} credits but no activation time.")
        return False, "Credit not activated."
    return True, "Credit valid."

# --- Google AI Helper Function (Non-Streaming for now) ---
async def call_google_ai(prompt: str, history: Optional[List[dict]] = None) -> Optional[str]:
    """Calls the configured Google AI model with history and returns the text response."""
    if not google_ai_configured or not ai_model:
        logger.error("Google AI not configured.")
        return "Error: AI service is not configured."

    logger.info(f"Sending prompt to Google AI: {prompt[:80]}...")
    try:
        # Format history for Gemini API
        formatted_history = []
        if history:
            for msg in history:
                 role = msg.get("role")
                 content = msg.get("content")
                 if role and content:
                     formatted_history.append({"role": role if role == 'user' else 'model', "parts": [{"text": content}]})

        # Start chat with history and send the new message
        chat_session = ai_model.start_chat(history=formatted_history)
        response = await chat_session.send_message_async(prompt) # Non-streaming call

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

# --- Google AI Streaming Helper ---
async def call_google_ai_stream(prompt: str, history: Optional[list] = None):
    """Yields chunks of the AI response as they are produced. Falls back to non-streaming if streaming is not supported by SDK."""
    if not google_ai_configured or not ai_model:
        yield "Error: AI service is not configured."
        return
    try:
        # Prepare messages for streaming
        messages = []
        if history:
            for msg in history:
                role = msg.get("role")
                content = msg.get("content")
                if role and content:
                    messages.append({"role": role, "parts": [{"text": content}]})
        messages.append({"role": "user", "parts": [{"text": prompt}]})

        import asyncio
        def try_stream():
            # Try streaming if supported, else fallback to non-streaming
            if hasattr(ai_model, "generate_content_stream"):
                return ai_model.generate_content_stream(messages)
            else:
                # Fallback to non-streaming
                return [ai_model.generate_content(messages)]

        loop = asyncio.get_event_loop()
        stream = await loop.run_in_executor(None, try_stream)
        for chunk in stream:
            if hasattr(chunk, 'text') and chunk.text:
                yield chunk.text
            elif hasattr(chunk, 'candidates') and chunk.candidates and hasattr(chunk.candidates[0], 'text'):
                yield chunk.candidates[0].text
            else:
                yield str(chunk)
    except Exception as e:
        import traceback
        yield f"Error: Could not connect to AI service ({type(e).__name__}): {e}\n{traceback.format_exc()}"

# === ROOT ENDPOINT ===
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: Optional[PropelUser] = Depends(safe_optional_user), db: Session = Depends(get_session)):
    # logger.debug(f"GET request for '/' - User authenticated: {user is not None}")
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
    # logger.info(f"GET request for '/api/v1/user/me' by user: {user.user_id}")
    db_user_instance = await get_or_create_db_user(user, db)
    if not db_user_instance: raise HTTPException(status_code=500, detail="User data error.")

    # --- Check and Expire Credits on fetch ---
    is_valid, reason = check_credit_status(db_user_instance)
    if not is_valid and reason == "Credit has expired." and db_user_instance.credits > 0:
        logger.info(f"Expiring credits for user {db_user_instance.id} during /user/me fetch.")
        try:
            db_user_instance.credits = 0
            db_user_instance.ai_interactions_used = 0
            db_user_instance.credit_activation_time = None
            db.add(db_user_instance)
            db.commit()
            db.refresh(db_user_instance)
            logger.info(f"Credits successfully expired for user {db_user_instance.id}.")
        except Exception as e:
             logger.error(f"Failed to expire credits in DB for user {db_user_instance.id}: {e}", exc_info=True)
             db.rollback() # Rollback this specific session on error
             # Continue without raising error, frontend will see 0 credits
    # --- End Credit Expiry Check ---

    return {
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
    if not db_user or not db_user.id: raise HTTPException(status_code=404, detail="User not found")
    statement = select(ChatMessage).where(ChatMessage.user_id == db_user.id).order_by(col(ChatMessage.timestamp).asc()) # .limit(50)
    messages = db.exec(statement).all()
    # Return content suitable for rendering (AI content already markdown->html)
    history = [{"role": msg.role, "content": msg.content if msg.role == 'user' else markdown.markdown(msg.content, extensions=['fenced_code', 'tables']), "timestamp": msg.timestamp} for msg in messages]
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

# --- AI Chat Message Endpoint (Using Form Data, Streaming) ---
@api_router.post("/chat/message", response_class=HTMLResponse)
async def post_chat_message(
    prompt: str = Form(...), # Expect form data
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    user_prompt = prompt
    logger.info(f"Chat message request from user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error")

    # 1. Check Credit
    is_valid, reason = check_credit_status(db_user)
    if not is_valid:
        logger.warning(f"Credit check failed for user {user.user_id}: {reason}")
        error_html = f"""
        <div id=\"chat-error\" hx-swap-oob=\"true\" class=\"alert alert-danger alert-dismissible fade show my-2\" role=\"alert\">
        Credit Error: {reason}<button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button></div>"""
        credits_html = f"""
        <span id=\"credits-display\" hx-swap-oob=\"true\" class=\"dropdown-item-text small text-muted\">Credits: {db_user.credits} (N/A)</span>"""
        return HTMLResponse(content=error_html + credits_html, status_code=403)

    if not google_ai_configured:
         error_html = f"""
         <div id=\"chat-error\" hx-swap-oob=\"true\" class=\"alert alert-danger alert-dismissible fade show my-2\" role=\"alert\">AI Service Error: Not configured.<button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button></div>"""
         return HTMLResponse(content=error_html, status_code=503)

    # 2. Load History
    logger.info("Loading chat history from DB for AI context...")
    history_statement = select(ChatMessage).where(ChatMessage.user_id == db_user.id).order_by(col(ChatMessage.timestamp).asc()).limit(20) # Limit context
    db_history = db.exec(history_statement).all()
    gemini_history = [{"role": m.role, "content": m.content} for m in db_history]
    logger.info(f"Loaded {len(gemini_history)} messages for chat context.")

    # 3. Stream AI Response
    import markdown
    async def ai_streamer():
        buffer = ""
        async for chunk in call_google_ai_stream(user_prompt, history=gemini_history):
            buffer += chunk
            html_chunk = markdown.markdown(chunk, extensions=['fenced_code', 'tables'])
            yield html_chunk
        # After streaming, save to DB (buffer contains full response)
        try:
            with Session(engine) as save_session:
                user_to_update = save_session.get(DBUser, db_user.id)
                if not user_to_update:
                    logger.error("User vanished during streaming save.")
                    return
                user_msg_db = ChatMessage(user_id=user_to_update.id, role="user", content=user_prompt)
                save_session.add(user_msg_db)
                ai_msg_db = ChatMessage(user_id=user_to_update.id, role="model", content=buffer)
                save_session.add(ai_msg_db)
                user_to_update.ai_interactions_used += 1
                save_session.add(user_to_update)
                save_session.commit()
                logger.info(f"Saved streamed chat. User {user.user_id} interactions: {user_to_update.ai_interactions_used}")
        except Exception as e:
            logger.error(f"DB error saving streamed chat/credits for user {user.user_id}: {e}", exc_info=True)
    return StreamingResponse(ai_streamer(), media_type="text/html")

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