# Dockerfile (for the 'web' service)

# Stage 1: Install dependencies with Poetry
FROM python:3.11-slim as builder

ENV PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    POETRY_VERSION=1.8.3 \
    POETRY_VIRTUALENVS_CREATE=false

RUN pip install "poetry==$POETRY_VERSION"

WORKDIR /app

COPY pyproject.toml ./
COPY poetry.lock ./ 

# Install project dependencies (ensure alembic is listed in pyproject.toml!)
# Use --only main if alembic is a main dependency, or remove --only if it's dev
RUN poetry install --no-interaction --no-ansi --only main

# --- Optional: Install netcat if using DB wait in entrypoint ---
# RUN apt-get update && apt-get install -y --no-install-recommends netcat-traditional && rm -rf /var/lib/apt/lists/*

# Stage 2: Setup the final application image
FROM python:3.11-slim as final

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app

# Copy installed packages
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
# Copy executables (uvicorn, alembic, etc.)
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code AND alembic config
COPY ./ ./

EXPOSE 8000

# --- Use Entrypoint Script ---
COPY ./entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]

# Default command passed to entrypoint
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]