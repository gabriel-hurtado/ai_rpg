from fastapi import APIRouter, Depends, HTTPException, Request, Response, Header
from fastapi.responses import HTMLResponse
from sqlmodel import Session, select
from starlette.templating import Jinja2Templates
from typing import Optional

from database import engine, get_session
from models import User
from services.auth_service import safe_require_user

import logging
import os
import stripe

logger = logging.getLogger(__name__)

templates = Jinja2Templates(directory="templates")

router = APIRouter(prefix="/payment", tags=["payments"])

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")
CREDITS_PER_PURCHASE = int(os.getenv("CREDITS_PER_PURCHASE", 100))

stripe_configured = False
if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY
    stripe_configured = True
else:
    logger.warning("Stripe Secret Key not found. Payment features disabled.")

@router.post("/create-checkout-session")
async def create_checkout_session(user: User = Depends(safe_require_user)):
    if not stripe_configured or not STRIPE_PRICE_ID:
        logger.error(f"Checkout attempt failed: Stripe not configured/Price ID missing. User: {user.user_id}")
        raise HTTPException(status_code=503, detail="Payment system is currently unavailable.")
    logger.info(f"Creating Stripe Checkout session for user: {user.user_id}")
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
            mode="payment",
            success_url=f"{APP_BASE_URL}/api/v1/payment/success?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{APP_BASE_URL}/api/v1/payment/cancel",
            client_reference_id=user.user_id,
            metadata={"propel_user_id": user.user_id},
        )
        logger.info(f"Stripe session created: {checkout_session.id} for user {user.user_id}")
        return {"checkout_url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Error creating session for user {user.user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Could not initiate payment session.")

@router.post("/webhook/stripe")
async def stripe_webhook_endpoint(request: Request, stripe_signature: Optional[str] = Header(None)):
    if not stripe_configured or not STRIPE_WEBHOOK_SECRET:
        logger.error("Stripe webhook received but not configured server-side.")
        raise HTTPException(status_code=503, detail="Webhook endpoint not configured")

    payload = await request.body()
    logger.info(f"Received Stripe webhook. Signature provided: {stripe_signature is not None}, Payload length: {len(payload)}")

    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
        logger.info(f"Stripe event verified: ID={event['id']}, Type={event['type']}")
    except ValueError as e:
        logger.error(f"Webhook payload error: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")
    except stripe.error.SignatureVerificationError as e:
        logger.error(f"Webhook signature verification error: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Invalid signature: {e}")
    except Exception as e:
        logger.error(f"Webhook construct_event unknown error: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Webhook error: {e}")

    if event["type"] == "checkout.session.completed":
        session_data = event["data"]["object"]
        stripe_session_id = session_data.get("id")
        payment_status = session_data.get("payment_status")
        propel_user_id = session_data.get("client_reference_id") or session_data.get("metadata", {}).get("propel_user_id")

        logger.info(f"Processing '{event['type']}': StripeID={stripe_session_id}, User={propel_user_id}, Status={payment_status}")

        if payment_status == "paid" and propel_user_id:
            logger.info(f"Payment successful for user: {propel_user_id}. Attempting to grant credits.")
            try:
                with Session(engine) as db_session:
                    statement = select(User).where(User.propelauth_user_id == propel_user_id)
                    db_user = db_session.exec(statement).first()

                    if db_user:
                        db_user.credits = (db_user.credits or 0) + CREDITS_PER_PURCHASE
                        db_session.add(db_user)
                        db_session.commit()
                        logger.info(f"User {propel_user_id} granted {CREDITS_PER_PURCHASE} credits. New total: {db_user.credits}")
                    else:
                        logger.error(f"Webhook Error: User {propel_user_id} not found in DB for successful payment {stripe_session_id}.")
            except Exception as e:
                logger.error(f"DB error granting credit for user {propel_user_id} from webhook {stripe_session_id}: {e}", exc_info=True)
                return Response(content="Internal server error processing credit grant", status_code=500)

        elif not propel_user_id:
            logger.error(f"Webhook Critical Error: '{event['type']}' received for session {stripe_session_id} but 'client_reference_id' or metadata ID is missing!")
        else:
            logger.warning(f"Session {stripe_session_id} completed for user {propel_user_id} but status is '{payment_status}'. No credits granted.")

    else:
        logger.info(f"Received unhandled Stripe event type: {event['type']}")

    return {"status": "success"}

@router.get("/success", response_class=HTMLResponse)
async def payment_success(request: Request, session_id: Optional[str] = None):
    logger.info(f"User redirected to payment success page. Session ID: {session_id}")
    return templates.TemplateResponse("payment_status.html", {
        "request": request,
        "status": "success",
        "session_id": session_id,
        "propelauth_url": os.getenv("PROPELAUTH_URL")
    })

@router.get("/cancel", response_class=HTMLResponse)
async def payment_cancel(request: Request):
    logger.info("User redirected to payment cancel page.")
    return templates.TemplateResponse("payment_status.html", {
        "request": request,
        "status": "cancel",
        "propelauth_url": os.getenv("PROPELAUTH_URL")
    })
