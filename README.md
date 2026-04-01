# Alloy Notebooks

**Multi-language notebooks for JupyterLab** -- write SQL, Python, and R in the same notebook with seamless data sharing between languages.

Built as a replacement for Azure Data Studio's notebook experience, which was [retired in February 2026](https://learn.microsoft.com/en-us/sql/tools/whats-happening-azure-data-studio).

![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4.x-orange)
![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue)
![License](https://img.shields.io/badge/License-BSD--3-green)

## Features

### SQL Cells with Inline Results
- Set any cell to **SQL** using the unified dropdown (Python | SQL | R | Markdown | Raw)
- SQL syntax highlighting
- Results rendered as interactive tables with row counts
- Click **Chart** to see value-count bar charts for each column -- no code needed
- Click **Configure Chart** for custom visualizations (bar, line, scatter, pie, area, histogram)

### Connection Manager
- Sidebar panel to save and manage database connections
- Supports **SQL Server**, PostgreSQL, MySQL, SQLite, DuckDB
- Auto-detects installed ODBC drivers
- Windows Authentication and SQL Authentication
- Connections persist across sessions (`~/.alloy/connections.json`)

### Cross-Language Data Sharing
- SQL results automatically available as pandas DataFrames in Python
- Name your results with `-- save as: my_data` in SQL cells
- R cells automatically receive only the Python variables they reference (smart transfer)
- New R variables (data.frames) automatically come back to Python after execution
- Uses **Apache Arrow** for near-zero-copy transfers when `pyarrow` + `rpy2-arrow` are installed (~425x faster than pandas2ri)
- `%alloy_vars` magic to list all available DataFrames

### Language Icons
- Small language icons (Python, SQL, R, Markdown) on the left margin of each cell
- Toggleable via Settings > Alloy Notebooks > "Show language icons"

### Unified Cell Type Dropdown
- Single dropdown replacing JupyterLab's Code/Markdown/Raw and a separate language selector
- Options: **Python | SQL | R | Markdown | Raw**
- Switching languages updates syntax highlighting instantly

## Install

```bash
pip install alloy-notebooks
```

### Optional: Fast R Integration

For R support:
```bash
pip install rpy2
```

For near-zero-copy data transfer between Python and R:
```bash
pip install pyarrow rpy2-arrow
```

## Quick Start

1. **Install**: `pip install alloy-notebooks`
2. **Start JupyterLab**: `jupyter lab`
3. **Connect**: Click "Alloy" in the left sidebar, add a database connection
4. **Write SQL**: Create a cell, select "SQL" from the dropdown, write a query, run it
5. **See results**: Table with Chart button appears below the cell
6. **Use in Python**: Results are in `_alloy_last_result`, or use `-- save as: my_df` to name them
7. **Use in R**: Switch a cell to "R", reference your DataFrame by name -- it transfers automatically

## Example Workflow

**SQL cell:**
```sql
-- save as: orders
SELECT customer_name, product, quantity, price
FROM sales.orders
WHERE order_date > '2026-01-01'
```

**Python cell:**
```python
# 'orders' is already a pandas DataFrame
orders['total'] = orders['quantity'] * orders['price']
print(orders.describe())
```

**R cell:**
```r
# 'orders' transfers automatically -- only this variable, not everything
summary(orders)
model <- lm(total ~ quantity, data = orders)
summary(model)
```

**Python cell:**
```python
# 'model' created in R is available if it's a data.frame
# Use %alloy_vars to see all available DataFrames
%alloy_vars
```

## Requirements

- JupyterLab >= 4.0.0
- Python >= 3.10
- For SQL Server: `pyodbc` with an ODBC driver installed
- For R cells: `rpy2` with R installed
- For fast transfers: `pyarrow` and `rpy2-arrow`

## Development

```bash
# Clone and install in development mode
git clone https://github.com/Columbia-Data-Labs/alloy-notebooks.git
cd alloy-notebooks
pip install -e ".[dev]"
jlpm install
jlpm build

# Watch for changes
jlpm watch  # in one terminal
jupyter lab  # in another terminal
```

## License

BSD-3-Clause

## Acknowledgments

Inspired by [Azure Data Studio](https://learn.microsoft.com/en-us/sql/azure-data-studio/) notebooks and built on top of [JupySQL](https://github.com/ploomber/jupysql) for SQL execution.
