# alembic/env.py

# Original Imports
from logging.config import fileConfig
from sqlalchemy import engine_from_config
from sqlalchemy import pool
from alembic import context

# ---> Added Imports <---
import os
from dotenv import load_dotenv
from sqlmodel import SQLModel # Import SQLModel itself
import sys

# ---> Add project root to sys.path <---
# Assumes your 'alembic' folder is directly inside your project root 'ai_jdr'
project_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, project_dir)
# print(f"Alembic: Added to sys.path: {project_dir}") # Optional: for debugging path

# ---> Import your models AFTER modifying sys.path <---
# This makes User, Conversation, etc. known to SQLModel.metadata
import models
# print(f"Alembic: Imported models module: {models}") # Optional: for debugging import

# ---> Load .env file from the project root <---
dotenv_path = os.path.join(project_dir, '.env')
# print(f"Alembic: Loading .env file from: {dotenv_path}") # Optional: for debugging path
load_dotenv(dotenv_path=dotenv_path)


# --- Original Alembic Config Setup ---
config = context.config

# Interpret the config file for Python logging (Keep this)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ---> Read Database URL from Environment <---
db_url = os.getenv("DATABASE_URL")
if not db_url:
    raise ValueError("Alembic: DATABASE_URL not found in environment variables. Check .env file.")
# print(f"Alembic: Read DATABASE_URL (partial): {db_url[:20]}...") # Optional: for debugging URL

# ---> Set the sqlalchemy.url based on environment variable <---
# This overrides any value potentially set in alembic.ini
config.set_main_option("sqlalchemy.url", db_url)


# ---> Configure target_metadata using SQLModel <---
# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
target_metadata = SQLModel.metadata # <--- MODIFIED THIS LINE


# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    # url = config.get_main_option("sqlalchemy.url") # We already set this via set_main_option using db_url
    url = db_url # Can use the variable directly here too
    context.configure(
        url=url,
        target_metadata=target_metadata, # Uses SQLModel.metadata defined above
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    # engine_from_config uses the "sqlalchemy.url" we set in the config object above
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata # Uses SQLModel.metadata defined above
        )

        with context.begin_transaction():
            context.run_migrations()

# --- Original execution logic (Keep this) ---
if context.is_offline_mode():
    print("Running migrations offline...")
    run_migrations_offline()
else:
    print("Running migrations online...")
    run_migrations_online()

print("Alembic env.py execution finished.") # Optional: Confirmation