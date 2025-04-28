# main.py - Updated with Conversation Management and Refined Credits

from fastapi import FastAPI, Request, Depends, HTTPException, Header, APIRouter, Form, Response
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import os
import logging
from datetime import datetime, timezone
import asyncio
from contextlib import asynccontextmanager
from typing import List, Optional, AsyncGenerator

# Pydantic for request body validation (if needed later)
# from pydantic import BaseModel

# Database imports
from database import get_session, engine # Assuming database.py defines engine and get_session
# Using create_all for now - COMMENT OUT IF USING ALEMBIC
from database import create_db_and_tables
# Updated Model Imports
from models import User as DBUser, ChatMessage, Conversation, MessageRole
from sqlmodel import Session, select, col

# PropelAuth Imports
from propelauth_fastapi import init_auth, User as PropelUser

# Stripe Import
import stripe

# Google AI Import
import google.generativeai as genai
from google.generativeai.types import GenerationConfig # For potential future config

# Markdown Rendering
import markdown

# --- Configuration Constants ---
CREDITS_PER_PURCHASE = 100 # How many credits are granted per successful Stripe purchase

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
logger.info(".env file loaded for main app.")

# --- Configure Stripe ---
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID") # Represents the product for CREDITS_PER_PURCHASE
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")

stripe_configured = False
if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY
    logger.info("Stripe API Key configured.")
    stripe_configured = True
    if not STRIPE_WEBHOOK_SECRET: logger.warning("Stripe Webhook Secret not found. Webhook verification will fail.")
    if not STRIPE_PRICE_ID: logger.warning("Stripe Price ID not found. Cannot create checkout sessions.")
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

# --- Configure Google AI ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
google_ai_configured = False
ai_model = None
SYSTEM_PROMPT = """You are a creative assistant for generating Tabletop Roleplaying Game (TTRPG) content.
Your goal is to help Game Masters (GMs) build their unique homebrew worlds.
Generate imaginative and useful content like locations, non-player characters (NPCs) with motivations,
magic items with history, monsters with unique abilities, or plot hooks.
Be descriptive and provide details that a GM can use in their game.
Maintain a helpful and inspiring tone. Avoid clichés where possible unless requested.
Format responses clearly using markdown where appropriate (like lists or emphasis), but avoid overly complex formatting."""

if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        ai_model = genai.GenerativeModel(
            # Use a model that supports system instructions and function calling if needed later
            # model_name='gemini-1.5-flash-latest', # Or 'gemini-1.5-pro-latest'
            model_name='gemini-1.5-flash-latest',
            system_instruction=SYSTEM_PROMPT,
            # generation_config=GenerationConfig(...) # Optional: configure temp, top_k etc.
        )
        google_ai_configured = True
        logger.info(f"Google AI Client Configured successfully with model: {ai_model.model_name}")
    except Exception as e:
        logger.error(f"Failed to configure Google AI: {e}", exc_info=True)
else:
    logger.warning("GOOGLE_API_KEY not found. AI features disabled.")

# --- Safe Dependency Wrappers ---
# Keep these as they are useful guards
async def safe_optional_user(user: Optional[PropelUser] = Depends(optional_user) if optional_user else None):
     return user

async def safe_require_user(user: Optional[PropelUser] = Depends(require_user) if require_user else None):
    if require_user is None: raise HTTPException(status_code=503, detail="Auth service unavailable")
    if user is None: raise HTTPException(status_code=401, detail="Not authenticated") # Should be handled by require_user
    return user

# --- Lifespan Context Manager ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("FastAPI application starting up...")
    # Run create_all if NOT using Alembic. Comment out if using Alembic.
    logger.info("Creating database tables if they don't exist...")
    create_db_and_tables()
    logger.info("Startup tasks complete.")
    yield
    logger.info("FastAPI application shutting down...")

# --- FastAPI App Setup ---
app = FastAPI(title="AI RPG Builder", version="0.2.0", lifespan=lifespan) # Increment version
logger.info("FastAPI app created.")

# --- Static Files and Templates ---
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
logger.info("Static files and Jinja2 templates configured.")

# --- Database User Sync Helper ---
async def get_or_create_db_user(propel_user: PropelUser, db: Session) -> Optional[DBUser]:
    """Gets the DB User matching the PropelAuth user, creating one if needed."""
    if not propel_user or not propel_user.user_id:
        logger.warning("Attempted get_or_create_db_user with invalid PropelUser")
        return None
    try:
        statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user.user_id)
        db_user = db.exec(statement).first()
        if not db_user:
            logger.info(f"Creating new DB User for PropelAuth ID: {propel_user.user_id}")
            user_email = propel_user.email or f"user_{propel_user.user_id}@placeholder.ai" # Handle missing email
            db_user = DBUser(
                propelauth_user_id=propel_user.user_id,
                email=user_email,
                credits=0 # Start with 0 credits
            )
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            logger.info(f"New DB user created with ID: {db_user.id}")
        return db_user
    except Exception as e:
        logger.error(f"DB error in get_or_create_db_user for {propel_user.user_id}: {e}", exc_info=True)
        db.rollback() # Rollback on error
        return None

# --- Credit Status Check Helper (Simplified) ---
def check_credit_status(db_user: Optional[DBUser]) -> tuple[bool, str]:
    """Checks if the user has any credits."""
    if not db_user:
        return False, "User not found."
    if db_user.credits <= 0:
        return False, "Insufficient credits."
    return True, "Credit available."

# --- Google AI Streaming Helper ---
async def call_google_ai_stream(prompt: str, history: Optional[List[dict]] = None) -> AsyncGenerator[str, None]:
    """Yields chunks of the AI response as they are produced using the Gemini API."""
    if not google_ai_configured or not ai_model:
        logger.error("Google AI called but not configured.")
        yield "Error: AI service is not configured."
        return

    logger.info(f"Streaming AI request. History length: {len(history) if history else 0}. Prompt: '{prompt[:50]}...'")
    try:
        # Format history for Gemini API
        formatted_history = []
        if history:
            for msg in history:
                 role = msg.get("role") # Should be 'user' or 'assistant' from DB
                 content = msg.get("content")
                 if role and content:
                     # Convert 'assistant' role to 'model' for the API
                     api_role = "model" if role == MessageRole.ASSISTANT else role
                     formatted_history.append({"role": api_role, "parts": [{"text": content}]})

        # Start chat session with history
        chat_session = ai_model.start_chat(history=formatted_history)
        # Stream the response to the new prompt
        response_stream = await chat_session.send_message_async(prompt, stream=True)

        async for chunk in response_stream:
            if chunk.text:
                # logger.debug(f"AI Stream Chunk: {chunk.text}") # Very verbose
                yield chunk.text
            # Handle potential errors or empty chunks if necessary
            # Check for finish reason, safety ratings etc. if needed:
            # if chunk.prompt_feedback: logger.warning(f"Prompt feedback: {chunk.prompt_feedback}")
            # if chunk.candidates and chunk.candidates[0].finish_reason: logger.info(f"Stream finish reason: {chunk.candidates[0].finish_reason}")

    except Exception as e:
        logger.error(f"Error during Google AI streaming API call: {e}", exc_info=True)
        yield f"Error: Could not connect to AI service ({type(e).__name__})."

# === ROOT ENDPOINT ===
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: Optional[PropelUser] = Depends(safe_optional_user), db: Session = Depends(get_session)):
    db_user_data = None
    if user:
        db_user_instance = await get_or_create_db_user(user, db)
        if db_user_instance:
             # Only pass necessary, non-sensitive info
             db_user_data = { "email": db_user_instance.email, "credits": db_user_instance.credits }
    context = {
        "request": request, "app_title": app.title,
        "propel_user": user.to_dict() if user else None,
        "db_user": db_user_data,
        "propelauth_url": AUTH_URL
    }
    return templates.TemplateResponse("index.html", context)

# === API ROUTES ===
api_router = APIRouter(prefix="/api/v1")

# --- Config Endpoint (Removed old constants) ---
@api_router.get("/config")
async def get_app_config():
    logger.info("GET request for '/api/v1/config'")
    # Provide any frontend-relevant config (e.g., model name if needed)
    return {
        "ai_model_name": ai_model.model_name if ai_model else "N/A",
        "stripe_configured": stripe_configured and bool(STRIPE_PRICE_ID), # Tell frontend if checkout is possible
        "credits_per_purchase": CREDITS_PER_PURCHASE
     }

# --- Stripe Checkout Endpoint ---
@api_router.post("/create-checkout-session")
async def create_checkout_session(user: PropelUser = Depends(safe_require_user)):
    """Create a Stripe checkout session for the user to purchase credits"""
    if not stripe_configured or not STRIPE_PRICE_ID:
        logger.error(f"Checkout attempt failed: Stripe not configured/Price ID missing. User: {user.user_id}")
        raise HTTPException(status_code=503, detail="Payment system is currently unavailable.")

    logger.info(f"Creating Stripe Checkout session for user: {user.user_id}")
    try:
        # Ensure the DB user exists before creating session (optional but good practice)
        # with Session(engine) as temp_db: # Use separate short-lived session if needed
        #    db_user = await get_or_create_db_user(user, temp_db)
        #    if not db_user: raise HTTPException(status_code=404, detail="User account not found.")

        checkout_session = stripe.checkout.Session.create(
            line_items=[{'price': STRIPE_PRICE_ID, 'quantity': 1}],
            mode='payment',
            success_url=f'{APP_BASE_URL}/payment/success?session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{APP_BASE_URL}/payment/cancel',
            client_reference_id=user.user_id, # Link session to PropelAuth User ID
            metadata={'propel_user_id': user.user_id} # Also store in metadata for redundancy
        )
        logger.info(f"Stripe session created: {checkout_session.id} for user {user.user_id}")
        return {"checkout_url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Error creating session for user {user.user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Could not initiate payment session.")

# --- User Info Endpoint (Simplified) ---
@api_router.get("/user/me")
async def get_current_user_info(user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    logger.debug(f"GET request for '/api/v1/user/me' by user: {user.user_id}")
    db_user_instance = await get_or_create_db_user(user, db)
    if not db_user_instance:
        logger.error(f"Could not find or create DB user for authenticated user {user.user_id}")
        raise HTTPException(status_code=500, detail="User data error.")

    # No expiry check needed anymore based on the model change
    return {
        "propel_user_id": user.user_id, # From Propel token
        "email": db_user_instance.email, # From DB
        "credits": db_user_instance.credits, # From DB
        "db_id": db_user_instance.id # Internal DB ID
    }

# --- Conversation Management Endpoints ---

@api_router.get("/conversations", response_model=List[dict]) # Add response model for clarity
async def get_conversations(user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    """Get all active conversations for the current user, ordered by most recently updated."""
    logger.debug(f"Fetching conversations for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        statement = select(Conversation).where(
            Conversation.user_id == db_user.id,
            Conversation.is_active == True # Only active ones
        ).order_by(col(Conversation.updated_at).desc()) # Order by recent activity

        conversations = db.exec(statement).all()
        logger.info(f"Found {len(conversations)} active conversations for user {user.user_id}")

        # Return a list of simplified conversation objects
        return [
            {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at.isoformat(),
                "updated_at": conv.updated_at.isoformat()
            }
            for conv in conversations
        ]
    except Exception as e:
        logger.error(f"Error fetching conversations for user {user.user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Database error fetching conversations.")

@api_router.post("/conversations", response_model=dict, status_code=201) # Add response model, status code
async def create_conversation(user: PropelUser = Depends(safe_require_user), db: Session = Depends(get_session)):
    """Create a new, empty conversation."""
    logger.info(f"Creating new conversation for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        new_conversation = Conversation(
            user_id=db_user.id,
            title="New Chat" # Default title
            # created_at/updated_at handled by model defaults/db triggers now
        )
        db.add(new_conversation)
        db.commit()
        db.refresh(new_conversation)
        logger.info(f"New conversation created with ID {new_conversation.id} for user {user.user_id}")

        return {
            "id": new_conversation.id,
            "title": new_conversation.title,
            "created_at": new_conversation.created_at.isoformat(),
            "updated_at": new_conversation.updated_at.isoformat()
        }
    except Exception as e:
        logger.error(f"Error creating conversation for user {user.user_id}: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error creating conversation.")

@api_router.get("/conversations/{conversation_id}", response_model=dict) # Add response model
async def get_conversation_details(
    conversation_id: int,
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Get details of a specific conversation and its messages."""
    logger.debug(f"Fetching details for conversation {conversation_id} for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        # Fetch the conversation ensuring ownership and active status
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True
            )
        ).first()

        if not conversation:
            logger.warning(f"Conversation {conversation_id} not found or access denied for user {user.user_id}")
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        # Fetch associated messages, ordered by time
        messages_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == conversation_id
        ).order_by(col(ChatMessage.timestamp).asc())
        messages = db.exec(messages_statement).all()
        logger.info(f"Found {len(messages)} messages for conversation {conversation_id}")

        # Format messages for the response
        formatted_messages = [
            {
                "id": msg.id,
                "role": msg.role.value, # Use the enum value ('user' or 'assistant')
                # Render markdown for assistant messages before sending? Or let frontend handle?
                # Let frontend handle for now, just send raw content.
                "content": msg.content,
                "timestamp": msg.timestamp.isoformat(),
                "prompt_tokens": msg.prompt_tokens, # Include token info if available
                "completion_tokens": msg.completion_tokens,
                "total_tokens": msg.total_tokens
            } for msg in messages
        ]

        return {
            "conversation": {
                "id": conversation.id,
                "title": conversation.title,
                "created_at": conversation.created_at.isoformat(),
                "updated_at": conversation.updated_at.isoformat()
            },
            "messages": formatted_messages
        }
    except HTTPException:
        raise # Re-raise specific HTTP exceptions
    except Exception as e:
        logger.error(f"Error retrieving conversation {conversation_id} for user {user.user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Database error retrieving conversation.")

@api_router.put("/conversations/{conversation_id}", response_model=dict) # Add response model
async def update_conversation_title(
    conversation_id: int,
    # Use Pydantic model for request body validation instead of Form
    payload: dict = None, # Simple dict for now, could be Pydantic model: `title: str`
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Update the title of a conversation."""
    if not payload or 'title' not in payload or not isinstance(payload['title'], str):
        raise HTTPException(status_code=400, detail="Invalid payload. 'title' field (string) is required.")

    new_title = payload['title'].strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="Title cannot be empty.")

    logger.info(f"Updating title for conversation {conversation_id} to '{new_title}' for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        # Fetch the conversation ensuring ownership and active status
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True
            )
        ).first()

        if not conversation:
            logger.warning(f"Update failed: Conversation {conversation_id} not found or access denied for user {user.user_id}")
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        # Update title and timestamp (updated_at might be handled by DB trigger, but explicit is safe)
        conversation.title = new_title
        conversation.updated_at = datetime.now(timezone.utc) # Explicitly update timestamp
        db.add(conversation)
        db.commit()
        db.refresh(conversation)
        logger.info(f"Conversation {conversation_id} title updated successfully.")

        return {
            "id": conversation.id,
            "title": conversation.title,
            "created_at": conversation.created_at.isoformat(),
            "updated_at": conversation.updated_at.isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating conversation {conversation_id} for user {user.user_id}: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error updating conversation.")

@api_router.delete("/conversations/{conversation_id}", status_code=204) # Use 204 No Content for successful delete
async def delete_conversation(
    conversation_id: int,
    user: PropelUser = Depends(safe_require_user),
    db: Session = Depends(get_session)
):
    """Soft delete a conversation by setting is_active to False."""
    logger.info(f"Attempting to delete conversation {conversation_id} for user {user.user_id}")
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    try:
        # Fetch the conversation ensuring ownership and *currently active* status
        conversation = db.exec(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == db_user.id,
                Conversation.is_active == True
            )
        ).first()

        if not conversation:
            logger.warning(f"Delete failed: Conversation {conversation_id} not found, already deleted, or access denied for user {user.user_id}")
            # Return 404 whether it doesn't exist or isn't active, user doesn't need to know which
            raise HTTPException(status_code=404, detail="Conversation not found or not accessible")

        # Perform soft delete
        conversation.is_active = False
        conversation.updated_at = datetime.now(timezone.utc) # Explicitly update timestamp
        db.add(conversation)
        db.commit()
        logger.info(f"Conversation {conversation_id} soft deleted successfully for user {user.user_id}")

        # Return No Content response
        return Response(status_code=204)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting conversation {conversation_id} for user {user.user_id}: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error deleting conversation.")


# --- AI Chat Message Endpoint (Streaming, Conversation-Aware, Credit Decrement) ---
@api_router.post("/chat/message")
async def chat_message_stream(
    request: Request, # Need request to get db session via Depends
    prompt: str = Form(...),
    conversation_id_form: Optional[int] = Form(None, alias="conversation_id"), # Use alias if needed
    user: PropelUser = Depends(safe_require_user),
    # Use the original session for initial checks and setup
    db: Session = Depends(get_session)
):
    """Handles sending a message, streaming the AI response, saving messages, and decrementing credits."""
    logger.info(f"POST /chat/message User: {user.user_id}, Conversation ID Form: {conversation_id_form}, Prompt: '{prompt[:50]}...'")

    # 1. Get DB User (using original session)
    db_user = await get_or_create_db_user(user, db)
    if not db_user: raise HTTPException(status_code=500, detail="User data error.")

    # --- CAPTURE USER ID ---
    user_id = db_user.id # Capture the primitive ID

    # 2. Check Credits
    has_credit, reason = check_credit_status(db_user)
    if not has_credit:
        logger.warning(f"Credit check failed for user {user_id}: {reason}")
        raise HTTPException(status_code=402, detail=f"Payment Required: {reason}")

    # 3. Get or Create Conversation (using original session)
    conversation: Optional[Conversation] = None
    is_new_conversation = False
    response_headers = {}
    conversation_id = conversation_id_form # Use the ID from the form

    try:
        if conversation_id:
            conversation = db.exec(
                select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.user_id == user_id, # Use captured user_id
                    Conversation.is_active == True
                )
            ).first()
            if not conversation:
                logger.warning(f"Chat attempt failed: Conversation {conversation_id} not found or access denied for user {user_id}")
                raise HTTPException(status_code=404, detail="Conversation not found or not accessible")
            logger.debug(f"Using existing conversation {conversation.id}")
        else:
            is_new_conversation = True
            max_title_length = 50
            initial_title = prompt[:max_title_length] + ("..." if len(prompt) > max_title_length else "")
            conversation = Conversation(user_id=user_id, title=initial_title) # Use captured user_id
            db.add(conversation)
            db.commit() # Commit to get the ID
            db.refresh(conversation)
            conversation_id = conversation.id # Get the new ID (This is now the final ID)
            response_headers["X-Conversation-ID"] = str(conversation_id)
            response_headers["X-Conversation-Title"] = conversation.title
            logger.info(f"Created new conversation {conversation_id} with title '{conversation.title}' for user {user_id}")

        # --- CAPTURE FINAL CONVERSATION ID ---
        final_conversation_id = conversation_id # Capture the definitive ID

        # 4. Save User Message (using original session)
        user_message = ChatMessage(
            user_id=user_id, # Set user_id for user messages
            conversation_id=final_conversation_id,
            role=MessageRole.USER,
            content=prompt
        )
        db.add(user_message)
        conversation.updated_at = datetime.now(timezone.utc) # Update timestamp explicitly
        db.add(conversation) # Add conversation again to stage the updated_at change
        db.commit() # Commit user message and timestamp update BEFORE streaming
        # db.refresh(user_message) # Refresh is optional here

        logger.debug(f"User message saved for conversation {final_conversation_id}")

        # 5. Prepare History for AI (using original session)
        history_statement = select(ChatMessage).where(
            ChatMessage.conversation_id == final_conversation_id
        ).order_by(col(ChatMessage.timestamp).asc()).limit(20) # Limit history depth
        history_messages = db.exec(history_statement).all()
        formatted_history = [
            {"role": msg.role.value, "content": msg.content}
            for msg in history_messages
        ]

        # 6. Define the Streaming Generator with Post-Stream Actions
        #    It now implicitly uses the captured user_id and final_conversation_id from the outer scope
        async def stream_and_save():
            full_response_content = ""
            ai_had_error = False
            try:
                # Call the streaming AI function
                ai_stream = call_google_ai_stream(prompt, formatted_history[:-1]) # History before current prompt

                async for chunk in ai_stream:
                    if chunk.startswith("Error:"): # Check for errors from the AI helper itself
                         logger.error(f"AI service returned an error chunk: {chunk}")
                         full_response_content = chunk # Store the error message
                         ai_had_error = True
                         yield chunk # Yield the error to the client
                         # Optionally break here if you don't want to yield anything after an error chunk
                         # break
                    else:
                         yield chunk
                         full_response_content += chunk # Accumulate the valid response

                # ---- Stream finished ----
                if ai_had_error or not full_response_content:
                    logger.error(f"AI stream completed with error or empty response for convo {final_conversation_id}. No DB write performed.")
                    return # Exit the generator, do not proceed to DB operations

                logger.info(f"AI stream completed successfully for convo {final_conversation_id}. Saving response & decrementing credit.")

                # --- Use a NEW SESSION for post-stream DB operations ---
                with Session(engine) as post_stream_db:
                    try:
                        # Re-fetch user using the new session and the captured ID
                        # Use .get for primary key lookup
                        current_db_user = post_stream_db.get(DBUser, user_id)

                        if not current_db_user:
                             logger.error(f"CRITICAL: User {user_id} not found in DB during post-stream save for convo {final_conversation_id}.")
                             # Don't yield an error here, maybe log intensely. The stream is done.
                             return
                        if current_db_user.credits <= 0:
                             logger.error(f"User {user_id} has no credits left post-stream ({current_db_user.credits}). Aborting save/decrement for convo {final_conversation_id}.")
                             # This might happen in race conditions, log and exit gracefully.
                             return

                        # Save the AI message (using new session)
                        ai_message = ChatMessage(
                            user_id=None, # AI messages have no user_id
                            conversation_id=final_conversation_id, # Use captured ID
                            role=MessageRole.ASSISTANT,
                            content=full_response_content,
                            # Add token counts here if available
                            prompt_tokens=None, completion_tokens=None, total_tokens=None
                        )
                        post_stream_db.add(ai_message)

                        # Decrement user credit (using new session)
                        current_db_user.credits -= 1
                        post_stream_db.add(current_db_user) # Add user again to stage credit change

                        # Update conversation timestamp (using new session)
                        current_conversation = post_stream_db.get(Conversation, final_conversation_id)
                        if current_conversation:
                            # Use server time if possible, fallback to app time
                            ai_message_timestamp = getattr(ai_message, 'timestamp', None) or datetime.now(timezone.utc)
                            current_conversation.updated_at = ai_message_timestamp
                            post_stream_db.add(current_conversation)

                        post_stream_db.commit() # Commit AI message, credit decrement, timestamp
                        logger.info(f"AI Response saved (Convo: {final_conversation_id}), User {user_id} credits decremented to {current_db_user.credits}")

                    except Exception as db_exc:
                        logger.error(f"DB Error during post-stream save for convo {final_conversation_id}: {db_exc}", exc_info=True)
                        post_stream_db.rollback()
                        # Don't yield error, stream already finished. Log for monitoring.

            except Exception as e_stream:
                logger.error(f"Error during streaming generation for convo {final_conversation_id}: {e_stream}", exc_info=True)
                # Yield a final error message chunk if streaming itself failed
                yield f"\n\n--- Server Error during response generation ---"
            finally:
                # The 'with Session(engine)' block handles session closure automatically
                pass

        # 7. Return StreamingResponse using the generator
        return StreamingResponse(stream_and_save(), media_type="text/plain; charset=utf-8", headers=response_headers)

    except HTTPException:
        # db.rollback() # Rollback original session if needed (Depends context usually handles it)
        raise
    except Exception as e:
        # db.rollback() # Rollback original session on unexpected errors
        logger.error(f"Unexpected error in /chat/message endpoint setup for user {user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error processing chat request.")

# Mount the API router
app.include_router(api_router)

# === STRIPE WEBHOOK ===
@app.post("/webhook/stripe")
async def stripe_webhook_endpoint(request: Request, stripe_signature: str = Header(None)):
     if not stripe_configured or not STRIPE_WEBHOOK_SECRET:
         logger.error("Stripe webhook received but not configured server-side.")
         raise HTTPException(status_code=503, detail="Webhook endpoint not configured")

     payload = await request.body()
     logger.info(f"Received Stripe webhook. Signature provided: {stripe_signature is not None}, Payload length: {len(payload)}")

     try:
         event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
         logger.info(f"Stripe event verified: ID={event['id']}, Type={event['type']}")
     except ValueError as e: # Invalid payload
         logger.error(f"Webhook payload error: {e}", exc_info=True)
         raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")
     except stripe.error.SignatureVerificationError as e: # Invalid signature
         logger.error(f"Webhook signature verification error: {e}", exc_info=True)
         raise HTTPException(status_code=400, detail=f"Invalid signature: {e}")
     except Exception as e:
         logger.error(f"Webhook construct_event unknown error: {e}", exc_info=True)
         raise HTTPException(status_code=400, detail=f"Webhook error: {e}")

     # Handle the checkout.session.completed event
     if event['type'] == 'checkout.session.completed':
         session_data = event['data']['object']
         stripe_session_id = session_data.get('id')
         payment_status = session_data.get('payment_status')
         # Get user ID reliably from client_reference_id or metadata
         propel_user_id = session_data.get('client_reference_id') or session_data.get('metadata', {}).get('propel_user_id')

         logger.info(f"Processing '{event['type']}': StripeID={stripe_session_id}, User={propel_user_id}, Status={payment_status}")

         if payment_status == 'paid' and propel_user_id:
             logger.info(f"Payment successful for user: {propel_user_id}. Attempting to grant credits.")
             try:
                 # Use a separate, short-lived session for webhook DB operation for isolation
                 with Session(engine) as db_session:
                      statement = select(DBUser).where(DBUser.propelauth_user_id == propel_user_id)
                      db_user = db_session.exec(statement).first()

                      if db_user:
                          # Add the defined number of credits
                          db_user.credits = (db_user.credits or 0) + CREDITS_PER_PURCHASE
                          # No longer need activation time or resetting usage count
                          db_session.add(db_user)
                          db_session.commit()
                          logger.info(f"User {propel_user_id} granted {CREDITS_PER_PURCHASE} credits. New total: {db_user.credits}")
                      else:
                          # This case is less likely if get_or_create runs on login/API calls, but handle it.
                          logger.error(f"Webhook Error: User {propel_user_id} not found in DB for successful payment {stripe_session_id}.")
                          # Consider creating the user here or logging for manual intervention
             except Exception as e:
                  logger.error(f"DB error granting credit for user {propel_user_id} from webhook {stripe_session_id}: {e}", exc_info=True)
                  # Don't raise HTTPException here, Stripe expects 200 if event received.
                  # Log error for monitoring. Stripe will retry if it gets 5xx.
                  return Response(content="Internal server error processing credit grant", status_code=500) # Signal internal issue

         elif not propel_user_id:
             logger.error(f"Webhook Critical Error: '{event['type']}' received for session {stripe_session_id} but 'client_reference_id' or metadata ID is missing!")
         else: # payment_status is not 'paid' or other issue
             logger.warning(f"Session {stripe_session_id} completed for user {propel_user_id} but status is '{payment_status}'. No credits granted.")

     else:
         logger.info(f"Received unhandled Stripe event type: {event['type']}")

     # Acknowledge receipt of the event to Stripe
     return {"status": "success"}

# === PAYMENT STATUS PAGES ===
# These remain largely the same, just ensure they use the AUTH_URL context variable
@app.get("/payment/success", response_class=HTMLResponse)
async def payment_success(request: Request, session_id: str | None = None):
    logger.info(f"User redirected to payment success page. Session ID: {session_id}")
    # Optionally verify session_id with Stripe here for extra security/context
    return templates.TemplateResponse("payment_status.html", {
        "request": request,
        "status": "Success!",
        "message": f"Thank you! {CREDITS_PER_PURCHASE} credits should now be available on your account.",
        "propelauth_url": AUTH_URL
    })

@app.get("/payment/cancel", response_class=HTMLResponse)
async def payment_cancel(request: Request):
     logger.info("User redirected to payment cancel page.")
     return templates.TemplateResponse("payment_status.html", {
         "request": request,
         "status": "Cancelled",
         "message": "Your payment process was cancelled. No credits were added.",
         "propelauth_url": AUTH_URL
     })

# Keep asyncio import if needed elsewhere, though FastAPI handles most async operations
# import asyncio