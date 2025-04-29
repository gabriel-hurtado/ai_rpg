# database.py
import logging
import os
from dotenv import load_dotenv
from sqlmodel import Session, SQLModel, create_engine
from urllib.parse import urlparse

# Load .env file to ensure DATABASE_URL is available
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load database URL from environment variable
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    logger.error("DATABASE_URL environment variable is not set. Please check your .env file.")
    raise ValueError("DATABASE_URL environment variable is not set.")

# Log database URL safely
try:
    parsed_url = urlparse(DATABASE_URL)
    safe_url = f"{parsed_url.scheme}://{parsed_url.username}:***@{parsed_url.hostname}:{parsed_url.port}{parsed_url.path}"
    logger.info(f"Database URL found: {safe_url}")
except Exception:
    logger.info("Database URL found (unable to parse for safe logging).")

# Create the database engine
logger.info("Creating database engine...")
try:
    engine = create_engine(DATABASE_URL, echo=True)
    logger.info("Database engine created successfully.")
except Exception as e:
    logger.error(f"Error creating database engine: {e}", exc_info=True)
    raise

def create_db_and_tables():
    """Creates database tables based on SQLModel metadata."""
    logger.info("Attempting to create database tables...")
    try:
        SQLModel.metadata.create_all(engine)
        logger.info("Database tables checked/created successfully.")
    except Exception as e:
        logger.error(f"Error creating database tables: {e}", exc_info=True)

def get_session():
    """FastAPI dependency function to yield a database Session."""
    with Session(engine) as session:
        try:
            yield session
        finally:
            session.close()