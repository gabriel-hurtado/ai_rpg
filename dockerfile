# Dockerfile

# Stage 1: Install dependencies with Poetry
FROM python:3.11-slim as builder
# Choose the Python version matching your project (e.g., 3.9, 3.10, 3.11, 3.12)

# Set environment variables for Poetry and pip
ENV PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    POETRY_VERSION=1.8.3 \
    # Make sure Poetry doesn't create its own venv inside the builder
    POETRY_VIRTUALENVS_CREATE=false

# Install Poetry itself
RUN pip install "poetry==$POETRY_VERSION"

WORKDIR /app

# Copy only the files needed for dependency installation first
# This leverages Docker layer caching efficiently
COPY pyproject.toml poetry.lock ./

# Install project dependencies (excluding development dependencies)
RUN poetry install --no-interaction --no-ansi --only main

# Stage 2: Setup the final application image
FROM python:3.11-slim as final

# Set environment variables for Python runtime
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app

# Copy the installed Python packages from the builder stage's site-packages
# Adjust the python version in the path if your base image is different
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
# Copy any command-line scripts installed by packages (like uvicorn)
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy your application code (main.py, database.py, models.py, templates/, static/)
# This comes after dependency installation for better caching
COPY ./ .

# Expose the port the application will run on (must match Uvicorn command)
EXPOSE 8000

# Command to run the application using Uvicorn
# Uses host 0.0.0.0 to be accessible from outside the container
# Uses port 8000 as exposed above
# --reload flag is removed here for a production-like build.
# We'll add --reload via docker-compose for development.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]