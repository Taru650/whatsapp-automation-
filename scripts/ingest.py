#!/usr/bin/env python3
"""
Embed data/facilities.csv and data/history.md into the pgvector store.

Run this once after filling in real data, and again any time the data
changes (e.g. an updated phone number, a corrected history section) —
there is no LLM retraining involved, just re-running this script.

Usage:
    python scripts/ingest.py

Requires POSTGRES_* and OLLAMA_BASE_URL / OLLAMA_EMBED_MODEL to be set
(see .env.example) and Ollama to already have the embedding model pulled:
    ollama pull nomic-embed-text
"""
import csv
import os
import sys

import psycopg2
import requests

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")

POSTGRES_DSN = {
    "host": os.environ.get("POSTGRES_HOST", "localhost"),
    "port": os.environ.get("POSTGRES_PORT", "5432"),
    "dbname": os.environ.get("POSTGRES_DB", "sonpur_mela"),
    "user": os.environ.get("POSTGRES_USER", "n8n"),
    "password": os.environ.get("POSTGRES_PASSWORD"),
}

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
FACILITIES_CSV = os.path.join(DATA_DIR, "facilities.csv")
HISTORY_MD = os.path.join(DATA_DIR, "history.md")

PLACEHOLDER_MARKERS = ("PLACEHOLDER", "TODO")


def embed(text: str) -> list[float]:
    resp = requests.post(
        f"{OLLAMA_BASE_URL}/api/embeddings",
        json={"model": OLLAMA_EMBED_MODEL, "prompt": text},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def to_pgvector_literal(vec: list[float]) -> str:
    return "[" + ",".join(repr(v) for v in vec) + "]"


def load_facilities():
    rows = []
    with open(FACILITIES_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(row)
    return rows


def split_history_sections(md_text: str):
    """Split on '## ' headings; each section is one retrieval chunk."""
    sections = []
    current_heading, current_body = None, []
    for line in md_text.splitlines():
        if line.startswith("## "):
            if current_heading is not None:
                sections.append((current_heading, "\n".join(current_body).strip()))
            current_heading = line[3:].strip()
            current_body = []
        elif current_heading is not None:
            current_body.append(line)
    if current_heading is not None:
        sections.append((current_heading, "\n".join(current_body).strip()))
    return sections


def has_placeholder(*values: str) -> bool:
    joined = " ".join(v or "" for v in values).upper()
    return any(marker in joined for marker in PLACEHOLDER_MARKERS)


def main():
    if not POSTGRES_DSN["password"]:
        sys.exit("POSTGRES_PASSWORD is not set — export it or load your .env first.")

    conn = psycopg2.connect(**POSTGRES_DSN)
    conn.autocommit = True
    cur = conn.cursor()

    skipped = 0

    print("Ingesting facilities...")
    cur.execute("DELETE FROM facilities;")
    for row in load_facilities():
        if has_placeholder(row.get("name", ""), row.get("phone", "")):
            skipped += 1
            continue
        text = (
            f"{row['category']} contact: {row['name']}. "
            f"Phone: {row.get('phone', '')}. Location: {row.get('location', '')}. "
            f"Hours: {row.get('hours', '')}. {row.get('notes', '')}"
        )
        vec = embed(text)
        cur.execute(
            """
            INSERT INTO facilities (category, name, phone, location, lat, lon, hours, notes, embedding)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                row["category"],
                row["name"],
                row.get("phone"),
                row.get("location"),
                float(row["lat"]) if row.get("lat") else None,
                float(row["lon"]) if row.get("lon") else None,
                row.get("hours"),
                row.get("notes"),
                to_pgvector_literal(vec),
            ),
        )

    print("Ingesting history chunks...")
    cur.execute("DELETE FROM history_chunks;")
    with open(HISTORY_MD, encoding="utf-8") as f:
        md_text = f.read()
    for heading, body in split_history_sections(md_text):
        if not body or has_placeholder(body):
            skipped += 1
            continue
        vec = embed(f"{heading}\n{body}")
        cur.execute(
            "INSERT INTO history_chunks (source, content, embedding) VALUES (%s, %s, %s)",
            (heading, body, to_pgvector_literal(vec)),
        )

    cur.close()
    conn.close()

    if skipped:
        print(
            f"Skipped {skipped} row(s)/section(s) still containing PLACEHOLDER/TODO markers. "
            "Fill in real data and re-run before relying on this for production answers."
        )
    print("Done.")


if __name__ == "__main__":
    main()
