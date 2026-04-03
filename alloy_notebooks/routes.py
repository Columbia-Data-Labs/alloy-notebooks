"""Tornado HTTP handlers for the Alloy Notebooks server extension."""

import json

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado

from . import connection_store


class ConnectionsHandler(APIHandler):
    """CRUD handler for saved database connections."""

    @tornado.web.authenticated
    def get(self):
        """List all saved connections."""
        connections = connection_store.list_connections()
        # Strip passwords from the response
        safe = []
        for c in connections:
            copy = dict(c)
            if "password" in copy:
                copy["password"] = "••••" if copy["password"] else ""
            safe.append(copy)
        self.finish(json.dumps({"connections": safe}))

    @tornado.web.authenticated
    def post(self):
        """Save a new connection."""
        body = self.get_json_body()
        result = connection_store.save_connection(body)
        self.set_status(201)
        self.finish(json.dumps(result))


class ConnectionHandler(APIHandler):
    """Handler for a single connection by ID."""

    @tornado.web.authenticated
    def get(self, conn_id):
        conn = connection_store.get_connection(conn_id)
        if conn is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "Connection not found"}))
            return
        if "password" in conn:
            conn["password"] = "••••" if conn["password"] else ""
        self.finish(json.dumps(conn))

    @tornado.web.authenticated
    def put(self, conn_id):
        body = self.get_json_body()
        result = connection_store.update_connection(conn_id, body)
        if result is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "Connection not found"}))
            return
        self.finish(json.dumps(result))

    @tornado.web.authenticated
    def delete(self, conn_id):
        deleted = connection_store.delete_connection(conn_id)
        if not deleted:
            self.set_status(404)
            self.finish(json.dumps({"error": "Connection not found"}))
            return
        self.finish(json.dumps({"status": "deleted"}))


class ConnectionStringHandler(APIHandler):
    """Build a connection string from config (without storing)."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        # If password is masked (from the frontend list), look up the real one
        conn_id = body.get("id")
        if conn_id and body.get("password") in ("••••", ""):
            stored = connection_store.get_connection(conn_id)
            if stored and stored.get("password"):
                body["password"] = stored["password"]
        try:
            conn_str = connection_store.build_connection_string(body)
            self.finish(json.dumps({"connection_string": conn_str}))
        except Exception as e:
            self.set_status(400)
            self.finish(json.dumps({"error": str(e)}))


def setup_route_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    ns = "alloy-notebooks"

    handlers = [
        (url_path_join(base_url, ns, "connections"), ConnectionsHandler),
        (url_path_join(base_url, ns, "connections", r"([^/]+)"), ConnectionHandler),
        (url_path_join(base_url, ns, "connection-string"), ConnectionStringHandler),
    ]

    web_app.add_handlers(host_pattern, handlers)
