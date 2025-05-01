#!/bin/bash
set -e

# Optional: Wait for DB - uncomment if needed (and install netcat in Dockerfile)
# echo "Entrypoint: Waiting for database at host '${POSTGRES_HOST:-db}' on port ${POSTGRES_PORT:-5432}..."
# while ! nc -z "${POSTGRES_HOST:-db}" "${POSTGRES_PORT:-5432}"; do
#   sleep 0.5
# done
# echo "Entrypoint: Database started"

# --- Set DATABASE_URL for Alembic ---
# Use the URL specifically meant for container-to-container communication
export DATABASE_URL="${CONTAINER_DATABASE_URL}"
if [ -z "$DATABASE_URL" ]; then
  echo "Entrypoint Error: CONTAINER_DATABASE_URL is not set!"
  exit 1
fi
echo "Entrypoint: Using DATABASE_URL=${DATABASE_URL%@*}*** for Alembic" # Log safely

# Run Alembic migrations
echo "Entrypoint: Running database migrations..."
poetry run alembic upgrade head

echo "Entrypoint: Migrations complete."

# Execute the command passed into the container (CMD)
echo "Entrypoint: Starting application ($@)..."
exec "$@"