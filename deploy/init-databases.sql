-- Runs once, on the first start of an empty Postgres volume.
-- citizen_bot is created by POSTGRES_DB; n8n keeps its own data separately.
CREATE DATABASE n8n;
