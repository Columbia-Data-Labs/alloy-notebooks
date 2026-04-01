/**
 * Connection Manager sidebar panel.
 * Allows users to add, edit, delete, and connect to database connections.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/ui-components';
import { ServerConnection } from '@jupyterlab/services';
import { requestAPI } from './request';

/** Shape of a saved connection config */
interface IConnectionConfig {
  id?: string;
  name: string;
  driver: string;
  server: string;
  database: string;
  auth_type: string;
  username: string;
  password: string;
  encrypt: string;
  trust_server_certificate: string;
  odbc_driver: string;
  connection_string: string;
}

const EMPTY_CONN: IConnectionConfig = {
  name: '',
  driver: 'mssql+pyodbc',
  server: 'localhost',
  database: '',
  auth_type: 'windows',
  username: '',
  password: '',
  encrypt: 'yes',
  trust_server_certificate: 'true',
  odbc_driver: '',  // empty = auto-detect on the server
  connection_string: ''
};

const DRIVERS = [
  { value: 'mssql+pyodbc', label: 'Microsoft SQL Server' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql+pymysql', label: 'MySQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'duckdb', label: 'DuckDB' }
];

interface IConnectionPanelProps {
  serverSettings: ServerConnection.ISettings;
  onConnect: (connString: string, alias: string) => void;
  onDisconnect: (alias: string) => void;
}

const ConnectionPanelComponent: React.FC<IConnectionPanelProps> = ({
  serverSettings,
  onConnect,
  onDisconnect
}) => {
  const [connections, setConnections] = useState<IConnectionConfig[]>([]);
  const [editing, setEditing] = useState<IConnectionConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeConnection, setActiveConnection] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const loadConnections = useCallback(async () => {
    try {
      const data = await requestAPI<{ connections: IConnectionConfig[] }>(
        'connections',
        serverSettings
      );
      setConnections(data.connections);
    } catch (err) {
      console.error('Failed to load connections:', err);
    }
  }, [serverSettings]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleSave = async () => {
    if (!editing) {
      return;
    }
    try {
      if (editing.id) {
        await requestAPI(`connections/${editing.id}`, serverSettings, {
          method: 'PUT',
          body: JSON.stringify(editing),
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await requestAPI('connections', serverSettings, {
          method: 'POST',
          body: JSON.stringify(editing),
          headers: { 'Content-Type': 'application/json' }
        });
      }
      setShowForm(false);
      setEditing(null);
      await loadConnections();
      setStatus('Connection saved.');
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await requestAPI(`connections/${id}`, serverSettings, {
        method: 'DELETE'
      });
      await loadConnections();
      if (activeConnection === id) {
        setActiveConnection(null);
      }
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const handleConnect = async (conn: IConnectionConfig) => {
    try {
      // Get the connection string from the server
      const data = await requestAPI<{ connection_string: string }>(
        'connection-string',
        serverSettings,
        {
          method: 'POST',
          body: JSON.stringify(conn),
          headers: { 'Content-Type': 'application/json' }
        }
      );
      const alias = conn.name || conn.id || 'default';
      onConnect(data.connection_string, alias);
      setActiveConnection(conn.id || null);
      setStatus(`Connected to ${conn.name || conn.server}`);
    } catch (err) {
      setStatus(`Connection failed: ${err}`);
    }
  };

  const handleDisconnect = (conn: IConnectionConfig) => {
    const alias = conn.name || conn.id || 'default';
    onDisconnect(alias);
    setActiveConnection(null);
    setStatus('Disconnected.');
  };

  const updateField = (field: keyof IConnectionConfig, value: string) => {
    if (editing) {
      setEditing({ ...editing, [field]: value });
    }
  };

  return (
    <div className="alloy-connection-panel">
      <div className="alloy-panel-header">
        <h3>Connections</h3>
        <button
          className="alloy-btn alloy-btn-primary"
          onClick={() => {
            setEditing({ ...EMPTY_CONN });
            setShowForm(true);
          }}
          title="Add Connection"
        >
          +
        </button>
      </div>

      {status && <div className="alloy-status">{status}</div>}

      {/* Connection list */}
      <div className="alloy-connection-list">
        {connections.map(conn => (
          <div
            key={conn.id}
            className={`alloy-connection-item ${activeConnection === conn.id ? 'active' : ''}`}
          >
            <div className="alloy-connection-info">
              <span className="alloy-connection-name">
                {conn.name || conn.server}
              </span>
              <span className="alloy-connection-detail">
                {DRIVERS.find(d => d.value === conn.driver)?.label || conn.driver}
                {conn.database ? ` / ${conn.database}` : ''}
              </span>
            </div>
            <div className="alloy-connection-actions">
              {activeConnection === conn.id ? (
                <button
                  className="alloy-btn alloy-btn-sm alloy-btn-danger"
                  onClick={() => handleDisconnect(conn)}
                  title="Disconnect"
                >
                  ✕
                </button>
              ) : (
                <button
                  className="alloy-btn alloy-btn-sm alloy-btn-success"
                  onClick={() => handleConnect(conn)}
                  title="Connect"
                >
                  ⚡
                </button>
              )}
              <button
                className="alloy-btn alloy-btn-sm"
                onClick={() => {
                  setEditing({ ...conn });
                  setShowForm(true);
                }}
                title="Edit"
              >
                ✎
              </button>
              <button
                className="alloy-btn alloy-btn-sm alloy-btn-danger"
                onClick={() => conn.id && handleDelete(conn.id)}
                title="Delete"
              >
                🗑
              </button>
            </div>
          </div>
        ))}
        {connections.length === 0 && (
          <div className="alloy-empty">No saved connections. Click + to add one.</div>
        )}
      </div>

      {/* Add/Edit form */}
      {showForm && editing && (
        <div className="alloy-connection-form">
          <h4>{editing.id ? 'Edit Connection' : 'New Connection'}</h4>

          <label>Name (optional)</label>
          <input
            type="text"
            value={editing.name}
            onChange={e => updateField('name', e.target.value)}
            placeholder="My Database"
          />

          <label>Connection Type</label>
          <select
            value={editing.driver}
            onChange={e => updateField('driver', e.target.value)}
          >
            {DRIVERS.map(d => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>

          <label>Input Type</label>
          <select
            value={editing.auth_type === 'connection_string' ? 'connection_string' : 'parameters'}
            onChange={e => {
              if (e.target.value === 'connection_string') {
                updateField('auth_type', 'connection_string');
              } else {
                updateField('auth_type', 'windows');
              }
            }}
          >
            <option value="parameters">Parameters</option>
            <option value="connection_string">Connection String</option>
          </select>

          {editing.auth_type === 'connection_string' ? (
            <>
              <label>Connection String</label>
              <input
                type="text"
                value={editing.connection_string}
                onChange={e => updateField('connection_string', e.target.value)}
                placeholder="mssql+pyodbc://..."
              />
            </>
          ) : (
            <>
              <label>Server</label>
              <input
                type="text"
                value={editing.server}
                onChange={e => updateField('server', e.target.value)}
                placeholder="localhost"
              />

              {editing.driver.startsWith('mssql') && (
                <>
                  <label>Authentication</label>
                  <select
                    value={editing.auth_type}
                    onChange={e => updateField('auth_type', e.target.value)}
                  >
                    <option value="windows">Windows Authentication</option>
                    <option value="sql">SQL Server Authentication</option>
                  </select>
                </>
              )}

              {(editing.auth_type === 'sql' ||
                !editing.driver.startsWith('mssql')) &&
                editing.driver !== 'sqlite' &&
                editing.driver !== 'duckdb' && (
                  <>
                    <label>Username</label>
                    <input
                      type="text"
                      value={editing.username}
                      onChange={e => updateField('username', e.target.value)}
                    />
                    <label>Password</label>
                    <input
                      type="password"
                      value={editing.password}
                      onChange={e => updateField('password', e.target.value)}
                    />
                  </>
                )}

              <label>Database</label>
              <input
                type="text"
                value={editing.database}
                onChange={e => updateField('database', e.target.value)}
                placeholder={
                  editing.driver === 'sqlite' || editing.driver === 'duckdb'
                    ? '/path/to/file.db'
                    : 'database name'
                }
              />

              {editing.driver.startsWith('mssql') && (
                <>
                  <label>Encrypt</label>
                  <select
                    value={editing.encrypt}
                    onChange={e => updateField('encrypt', e.target.value)}
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="Mandatory">Mandatory</option>
                  </select>

                  <label>Trust Server Certificate</label>
                  <select
                    value={editing.trust_server_certificate}
                    onChange={e =>
                      updateField('trust_server_certificate', e.target.value)
                    }
                  >
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                </>
              )}
            </>
          )}

          <div className="alloy-form-buttons">
            <button className="alloy-btn alloy-btn-primary" onClick={handleSave}>
              Save
            </button>
            <button
              className="alloy-btn"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Lumino widget wrapper for the React connection panel.
 */
export class ConnectionPanel extends ReactWidget {
  private _serverSettings: ServerConnection.ISettings;
  private _onConnect: (connString: string, alias: string) => void;
  private _onDisconnect: (alias: string) => void;

  constructor(
    serverSettings: ServerConnection.ISettings,
    onConnect: (connString: string, alias: string) => void,
    onDisconnect: (alias: string) => void
  ) {
    super();
    this._serverSettings = serverSettings;
    this._onConnect = onConnect;
    this._onDisconnect = onDisconnect;
    this.id = 'alloy-connection-panel';
    this.title.label = 'Alloy';
    this.title.caption = 'Database Connections';
    this.addClass('alloy-sidebar');
  }

  render(): JSX.Element {
    return (
      <ConnectionPanelComponent
        serverSettings={this._serverSettings}
        onConnect={this._onConnect}
        onDisconnect={this._onDisconnect}
      />
    );
  }
}
