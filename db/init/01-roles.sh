#!/bin/sh
# Runs once on first container start (empty volume). Superuser only creates roles + extension;
# the app connects as memhub_rw (owner, import/write) or memhub_ro (MCP search, read-only).
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d memhub \
  -v rw_pw="$MEMHUB_RW_PASSWORD" -v ro_pw="$MEMHUB_RO_PASSWORD" <<'SQL'
CREATE ROLE memhub_rw LOGIN PASSWORD :'rw_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE memhub_ro LOGIN PASSWORD :'ro_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER DATABASE memhub OWNER TO memhub_rw;
ALTER SCHEMA public OWNER TO memhub_rw;
REVOKE ALL ON DATABASE memhub FROM PUBLIC;
GRANT CONNECT ON DATABASE memhub TO memhub_ro;
GRANT USAGE ON SCHEMA public TO memhub_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE memhub_rw IN SCHEMA public GRANT SELECT ON TABLES TO memhub_ro;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
