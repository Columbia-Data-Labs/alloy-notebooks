"""Persistent storage for database connection configurations."""

import json
import os
import uuid
from pathlib import Path
from typing import Optional


def _config_dir() -> Path:
    return Path.home() / ".alloy"


def _config_file() -> Path:
    return _config_dir() / "connections.json"


def _ensure_config():
    _config_dir().mkdir(parents=True, exist_ok=True)
    path = _config_file()
    if not path.exists():
        path.write_text(json.dumps({"connections": {}}, indent=2))


def _load() -> dict:
    _ensure_config()
    return json.loads(_config_file().read_text())


def _save(data: dict):
    _ensure_config()
    _config_file().write_text(json.dumps(data, indent=2))


def list_connections() -> list[dict]:
    """Return all saved connections as a list."""
    data = _load()
    result = []
    for conn_id, conn in data.get("connections", {}).items():
        result.append({"id": conn_id, **conn})
    return result


def get_connection(conn_id: str) -> Optional[dict]:
    """Get a single connection by ID."""
    data = _load()
    conn = data.get("connections", {}).get(conn_id)
    if conn:
        return {"id": conn_id, **conn}
    return None


def save_connection(conn_config: dict) -> dict:
    """Save a new connection. Returns the saved connection with its ID."""
    data = _load()
    conn_id = conn_config.pop("id", None) or str(uuid.uuid4())[:8]
    data.setdefault("connections", {})[conn_id] = conn_config
    _save(data)
    return {"id": conn_id, **conn_config}


def update_connection(conn_id: str, conn_config: dict) -> Optional[dict]:
    """Update an existing connection."""
    data = _load()
    if conn_id not in data.get("connections", {}):
        return None
    conn_config.pop("id", None)
    data["connections"][conn_id] = conn_config
    _save(data)
    return {"id": conn_id, **conn_config}


def delete_connection(conn_id: str) -> bool:
    """Delete a connection by ID. Returns True if it existed."""
    data = _load()
    if conn_id in data.get("connections", {}):
        del data["connections"][conn_id]
        _save(data)
        return True
    return False


def build_connection_string(conn_config: dict) -> str:
    """Build a SQLAlchemy connection string from a connection config dict.

    Supports config fields:
        driver: mssql+pyodbc, postgresql, mysql+pymysql, sqlite, duckdb
        server: hostname or hostname,port
        database: database name
        auth_type: windows, sql, connection_string
        username: (for sql auth)
        password: (for sql auth)
        connection_string: (raw string, used directly if auth_type=connection_string)
        encrypt: yes/no/mandatory (for mssql)
        trust_server_certificate: true/false (for mssql)
    """
    if conn_config.get("auth_type") == "connection_string":
        return conn_config.get("connection_string", "")

    driver = conn_config.get("driver", "mssql+pyodbc")
    server = conn_config.get("server", "localhost")
    database = conn_config.get("database", "")
    auth_type = conn_config.get("auth_type", "windows")
    username = conn_config.get("username", "")
    password = conn_config.get("password", "")

    if driver == "sqlite":
        return f"sqlite:///{database}" if database else "sqlite://"

    if driver == "duckdb":
        return f"duckdb:///{database}" if database else "duckdb://"

    # Build URL
    if auth_type == "sql" and username:
        from urllib.parse import quote_plus
        user_part = f"{quote_plus(username)}:{quote_plus(password)}@"
    else:
        user_part = ""

    host_part = server.replace(",", ":")  # SQL Server uses comma for port

    base = f"{driver}://{user_part}{host_part}"
    if database:
        base += f"/{database}"

    # MSSQL-specific query params
    if driver.startswith("mssql"):
        from urllib.parse import quote_plus
        params = []
        if auth_type == "windows":
            params.append("trusted_connection=yes")
        odbc_driver = conn_config.get("odbc_driver", "")
        if not odbc_driver:
            odbc_driver = _detect_mssql_odbc_driver()
        params.append(f"driver={quote_plus(odbc_driver)}")
        trust = conn_config.get("trust_server_certificate", "true")
        if trust.lower() == "true":
            params.append("TrustServerCertificate=yes")
        encrypt = conn_config.get("encrypt", "yes")
        params.append(f"Encrypt={encrypt}")
        if params:
            base += "?" + "&".join(params)

    return base


def _detect_mssql_odbc_driver() -> str:
    """Auto-detect the best available ODBC driver for SQL Server."""
    try:
        import pyodbc
        drivers = pyodbc.drivers()
    except ImportError:
        return "ODBC Driver 17 for SQL Server"  # reasonable fallback

    # Prefer newer drivers first
    preferred = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "ODBC Driver 13.1 for SQL Server",
        "ODBC Driver 13 for SQL Server",
        "ODBC Driver 11 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server Native Client RDA 11.0",
        "SQL Server",
    ]
    for p in preferred:
        if p in drivers:
            return p

    # Last resort: return first driver that mentions SQL Server
    for d in drivers:
        if "sql server" in d.lower():
            return d

    return "ODBC Driver 17 for SQL Server"
