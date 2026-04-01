"""Alloy IPython magics for SQL execution and cross-language data sharing."""

import json

from IPython.core.magic import Magics, magics_class, cell_magic, line_magic
from IPython.display import display, HTML


ALLOY_MIME_TYPE = "application/vnd.alloy.resultset+json"


@magics_class
class AlloyMagics(Magics):
    """Magics for Alloy Notebooks — SQL execution with rich output."""

    def _ensure_sql_loaded(self):
        """Make sure JupySQL's sql extension is loaded."""
        if not hasattr(self.shell, "_alloy_sql_loaded"):
            try:
                self.shell.run_line_magic("load_ext", "sql")
            except Exception:
                pass  # May already be loaded
            self.shell._alloy_sql_loaded = True

    @cell_magic
    def alloy_sql(self, line, cell):
        """Execute SQL and return results with Alloy's rich MIME type.

        Usage:
            %%alloy_sql [connection_string] [--as variable_name]

        The result is displayed as a rich table and optionally stored
        as a pandas DataFrame in the given variable name.
        """
        self._ensure_sql_loaded()

        # Parse --as flag for variable storage
        var_name = None
        parts = line.strip().split()
        filtered_parts = []
        i = 0
        while i < len(parts):
            if parts[i] == "--as" and i + 1 < len(parts):
                var_name = parts[i + 1]
                i += 2
            else:
                filtered_parts.append(parts[i])
                i += 1
        sql_line = " ".join(filtered_parts)

        # Execute via JupySQL — try multiple approaches to capture the result
        import pandas as pd
        df = None

        try:
            result = self.shell.run_cell_magic("sql", sql_line, cell)
        except Exception as e:
            display(HTML(f'<div style="color:red;font-weight:bold">SQL Error: {e}</div>'))
            return

        # Try to get a DataFrame from the result
        if result is not None:
            if isinstance(result, pd.DataFrame):
                df = result
            elif hasattr(result, "DataFrame"):
                df = result.DataFrame()
            else:
                try:
                    df = pd.DataFrame(result)
                except Exception:
                    pass

        # If run_cell_magic returned None, try using the connection directly
        if df is None:
            try:
                from sql.connection import ConnectionManager
                conn = ConnectionManager.current
                if conn:
                    raw_result = conn.execute(cell)
                    rows = raw_result.fetchall()
                    if hasattr(raw_result, 'keys'):
                        cols = list(raw_result.keys())
                    elif hasattr(raw_result, 'description') and raw_result.description:
                        cols = [d[0] for d in raw_result.description]
                    else:
                        cols = [f"col_{i}" for i in range(len(rows[0]))] if rows else []
                    df = pd.DataFrame(rows, columns=cols)
            except Exception as e:
                display(HTML(f'<div style="color:red;font-weight:bold">SQL Error: {e}</div>'))
                return

        if df is None or df.empty:
            display(HTML('<div style="color:#888">Query returned no results.</div>'))
            return

        # Store as variable if requested
        if var_name:
            self.shell.user_ns[var_name] = df

        # Auto-store as _alloy_last_result
        self.shell.user_ns["_alloy_last_result"] = df

        # Build rich output with our custom MIME type
        rows_affected = len(df)
        columns = list(df.columns)

        # Convert to JSON-serializable format
        # Handle non-serializable types
        records = []
        for _, row in df.head(1000).iterrows():  # Cap at 1000 rows for display
            record = {}
            for col in columns:
                val = row[col]
                if pd.isna(val):
                    record[col] = None
                elif hasattr(val, "isoformat"):
                    record[col] = val.isoformat()
                else:
                    try:
                        json.dumps(val)
                        record[col] = val
                    except (TypeError, ValueError):
                        record[col] = str(val)
            records.append(record)

        alloy_data = {
            "columns": columns,
            "rows": records,
            "total_rows": rows_affected,
            "truncated": rows_affected > 1000,
            "var_name": var_name,
        }

        # Publish both our MIME type and a fallback HTML table
        html_table = df.head(50).to_html(
            classes="alloy-result-table",
            index=False,
            border=0,
        )
        status = f"({rows_affected} row{'s' if rows_affected != 1 else ''} affected)"

        bundle = {
            ALLOY_MIME_TYPE: alloy_data,
            "text/html": f"{html_table}<p>{status}</p>",
            "text/plain": df.to_string(),
        }

        metadata = {
            ALLOY_MIME_TYPE: {
                "isolated": False,
            }
        }

        display(bundle, raw=True, metadata=metadata)

    @line_magic
    def alloy_connect(self, line):
        """Connect to a database using a connection string.

        Usage:
            %alloy_connect mssql+pyodbc://localhost/mydb?trusted_connection=yes&driver=ODBC+Driver+18+for+SQL+Server
            %alloy_connect --alias mydb <connection_string>
        """
        self._ensure_sql_loaded()
        self.shell.run_line_magic("sql", line)

    @line_magic
    def alloy_disconnect(self, line):
        """Disconnect from a database.

        Usage:
            %alloy_disconnect
            %alloy_disconnect --alias mydb
        """
        self._ensure_sql_loaded()
        self.shell.run_line_magic("sql", f"--close {line}".strip())

    @cell_magic
    def alloy_chart(self, line, cell):
        """Generate a chart from the last SQL result or a named DataFrame.

        Usage:
            %%alloy_chart [variable_name]
            type: bar
            x: column_name
            y: column_name
            title: My Chart
        """
        import matplotlib
        matplotlib.use("agg")
        import matplotlib.pyplot as plt

        # Parse config from cell body
        config = {}
        for cfg_line in cell.strip().split("\n"):
            if ":" in cfg_line:
                key, value = cfg_line.split(":", 1)
                config[key.strip().lower()] = value.strip()

        # Get the DataFrame
        var_name = line.strip() if line.strip() else "_alloy_last_result"
        df = self.shell.user_ns.get(var_name)
        if df is None:
            display(HTML('<div style="color:red">No data found. Run a SQL query first.</div>'))
            return

        chart_type = config.get("type", "bar")
        x_col = config.get("x", df.columns[0] if len(df.columns) > 0 else None)
        y_col = config.get("y", df.columns[1] if len(df.columns) > 1 else None)
        title = config.get("title", "")
        direction = config.get("direction", "vertical")
        legend = config.get("legend", "top")
        x_label = config.get("x_label", x_col or "")
        y_label = config.get("y_label", y_col or "")
        color = config.get("color", None)
        figsize_w = float(config.get("width", "10"))
        figsize_h = float(config.get("height", "6"))

        fig, ax = plt.subplots(figsize=(figsize_w, figsize_h))

        if chart_type == "bar":
            if direction == "horizontal":
                ax.barh(df[x_col].astype(str), df[y_col], color=color)
            else:
                ax.bar(df[x_col].astype(str), df[y_col], color=color)
        elif chart_type == "line":
            ax.plot(df[x_col], df[y_col], color=color, marker="o")
        elif chart_type == "scatter":
            ax.scatter(df[x_col], df[y_col], color=color)
        elif chart_type == "pie":
            ax.pie(df[y_col], labels=df[x_col].astype(str), autopct="%1.1f%%")
        elif chart_type == "histogram":
            ax.hist(df[y_col or x_col], bins=int(config.get("bins", "20")), color=color)
        elif chart_type == "area":
            ax.fill_between(range(len(df)), df[y_col], alpha=0.5, color=color)
            ax.set_xticks(range(len(df)))
            ax.set_xticklabels(df[x_col].astype(str), rotation=45)

        ax.set_xlabel(x_label)
        ax.set_ylabel(y_label)
        if title:
            ax.set_title(title)

        # Legend position
        if legend == "none":
            pass
        elif legend in ("top", "bottom", "left", "right"):
            loc_map = {"top": "upper center", "bottom": "lower center",
                       "left": "center left", "right": "center right"}
            if ax.get_legend_handles_labels()[1]:
                ax.legend(loc=loc_map.get(legend, "best"))

        plt.tight_layout()
        plt.show()
        plt.close(fig)

    @line_magic
    def alloy_to_r(self, line):
        """Transfer a pandas DataFrame to R via rpy2.

        Usage:
            %alloy_to_r my_df
            %alloy_to_r my_df r_var_name

        If r_var_name is not given, uses the same name in R.
        """
        parts = line.strip().split()
        if not parts:
            display(HTML('<div style="color:red">Usage: %alloy_to_r pandas_var [r_name]</div>'))
            return

        py_name = parts[0]
        r_name = parts[1] if len(parts) > 1 else py_name

        df = self.shell.user_ns.get(py_name)
        if df is None:
            display(HTML(f'<div style="color:red">Variable "{py_name}" not found.</div>'))
            return

        try:
            import rpy2.robjects as ro
            from rpy2.robjects import pandas2ri
            pandas2ri.activate()
            r_df = pandas2ri.py2rpy(df)
            ro.globalenv[r_name] = r_df
            display(HTML(f'<div style="color:green">Transferred "{py_name}" to R as "{r_name}" ({len(df)} rows)</div>'))
        except ImportError:
            display(HTML(
                '<div style="color:red">rpy2 is not installed. '
                'Install it with: pip install rpy2</div>'
            ))
        except Exception as e:
            display(HTML(f'<div style="color:red">Error transferring to R: {e}</div>'))

    @line_magic
    def alloy_from_r(self, line):
        """Transfer an R data.frame to Python as a pandas DataFrame.

        Usage:
            %alloy_from_r r_var_name
            %alloy_from_r r_var_name py_var_name
        """
        parts = line.strip().split()
        if not parts:
            display(HTML('<div style="color:red">Usage: %alloy_from_r r_var [py_name]</div>'))
            return

        r_name = parts[0]
        py_name = parts[1] if len(parts) > 1 else r_name

        try:
            import rpy2.robjects as ro
            from rpy2.robjects import pandas2ri
            pandas2ri.activate()
            r_obj = ro.globalenv[r_name]
            df = pandas2ri.rpy2py(r_obj)
            self.shell.user_ns[py_name] = df
            display(HTML(f'<div style="color:green">Transferred R "{r_name}" to Python as "{py_name}" ({len(df)} rows)</div>'))
        except ImportError:
            display(HTML(
                '<div style="color:red">rpy2 is not installed. '
                'Install it with: pip install rpy2</div>'
            ))
        except Exception as e:
            display(HTML(f'<div style="color:red">Error transferring from R: {e}</div>'))

    @line_magic
    def alloy_vars(self, line):
        """List all Alloy DataFrames in the current namespace."""
        import pandas as pd
        dfs = []
        for name, val in self.shell.user_ns.items():
            if isinstance(val, pd.DataFrame) and not name.startswith("_"):
                dfs.append((name, val.shape[0], val.shape[1], list(val.columns[:5])))

        if not dfs:
            display(HTML('<div style="color:#888">No DataFrames in namespace.</div>'))
            return

        rows = "".join(
            f"<tr><td><b>{n}</b></td><td>{r}</td><td>{c}</td>"
            f"<td>{', '.join(str(x) for x in cols)}{'...' if len(cols) == 5 else ''}</td></tr>"
            for n, r, c, cols in dfs
        )
        display(HTML(
            f'<table style="font-size:12px"><thead><tr>'
            f'<th>Name</th><th>Rows</th><th>Cols</th><th>Columns</th>'
            f'</tr></thead><tbody>{rows}</tbody></table>'
        ))


def load_ipython_extension(ipython):
    """Called by %load_ext alloy_notebooks.kernel"""
    ipython.register_magics(AlloyMagics)
    # Note: JupySQL (%load_ext sql) is loaded separately by the frontend
    # extension. Do NOT load it here — causes deadlock if both are in
    # the same cell or auto-load sequence.


def unload_ipython_extension(ipython):
    pass
