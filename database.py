# database.py
import os
from sqlmodel import SQLModel, create_engine, Session
from dotenv import load_dotenv
import logging

# ---> ADD THIS LINE TO ENSURE MODELS ARE REGISTERED WITH SQLMODEL METADATA <---
import models # Or: from models import User (if User is the only model for now)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load .env file to ensure DATABASE_URL is available
load_dotenv()
logger.info("database.py: .env file loaded.")

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    logger.error("DATABASE_URL environment variable is not set. Please check your .env file.")
    raise ValueError("DATABASE_URL environment variable is not set.")
else:
    # Log partially for verification, hiding the password
    try:
        from urllib.parse import urlparse
        parsed_url = urlparse(DATABASE_URL)
        # Construct safe URL without password for logging
        safe_url = f"{parsed_url.scheme}://{parsed_url.username}:***@{parsed_url.hostname}:{parsed_url.port}{parsed_url.path}"
        logger.info(f"database.py: Database URL found: {safe_url}")
    except Exception:
        logger.info("database.py: Database URL found (unable to parse for safe logging).")


# Create the database engine
# echo=True logs SQL queries to the console, useful for development
# echo=False is recommended for production
logger.info("database.py: Creating database engine...")
try:
    # For psycopg2 (installed via psycopg2-binary):
    engine = create_engine(DATABASE_URL, echo=True)
    # If you were explicitly using psycopg (v3) and changed the URL scheme:
    # engine = create_engine(DATABASE_URL.replace("postgresql://","postgresql+psycopg://"), echo=True)
    logger.info("database.py: Database engine created successfully.")
except Exception as e:
     logger.error(f"database.py: Error creating database engine: {e}", exc_info=True)
     raise # Stop application startup if engine creation fails

def create_db_and_tables():
    """Creates database tables based on SQLModel metadata."""
    logger.info("database.py: Attempting to create database tables...")
    try:
        # SQLModel.metadata contains table definitions from imported models
        # like the User class in models.py (because we added 'import models' above)
        SQLModel.metadata.create_all(engine)
        logger.info("database.py: Database tables checked/created successfully.")
    except Exception as e:
        # Log the full error trace if table creation fails
        logger.error(f"database.py: Error creating database tables: {e}", exc_info=True)
        # Depending on severity, you might want to raise e here too


def get_session():
    """FastAPI dependency function to yield a database Session."""
    # The 'with' statement ensures the session resources are managed correctly
    # (e.g., connection returned to pool, transaction handling)
    with Session(engine) as session:
        try:
            # Yield the session for the endpoint function to use
            yield session
        finally:
            # Ensure the session is closed after the request is handled
            session.close()
            # logger.debug("database.py: Database session closed.") # Optional debug logging