/**
 * Alloy Notebooks — JupyterLab extension entry point.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer
} from '@jupyterlab/application';

import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ICommandPalette } from '@jupyterlab/apputils';

import { ConnectionPanel } from './ConnectionPanel';
import { alloyRendererFactory } from './ResultRenderer';
import { addCellTypeSelectorToNotebook } from './LanguageSelector';

const PLUGIN_ID = 'alloy-notebooks:plugin';
const LANGUAGE_KEY = 'alloy:language';

/**
 * Execute code silently in the kernel (no output displayed).
 */
function executeInKernel(
  tracker: INotebookTracker,
  code: string
): void {
  const notebook = tracker.currentWidget;
  if (!notebook) {
    return;
  }
  const kernel = notebook.sessionContext.session?.kernel;
  if (!kernel) {
    console.warn('Alloy: No active kernel');
    return;
  }
  kernel.requestExecute({ code, silent: true });
}


/**
 * Build Python code that wraps a SQL query for execution via JupySQL's connection.
 * Publishes results using our custom MIME type so the ResultRenderer picks it up
 * with Table/Chart buttons inline.
 */
function wrapSqlAsPython(sql: string): string {
  // Check for "-- save as: varname" directive
  let saveAs = '';
  const saveMatch = sql.match(/^--\s*save\s+as\s*:\s*([a-zA-Z_]\w*)\s*$/m);
  if (saveMatch) {
    saveAs = saveMatch[1];
  }

  // Check for "-- connection: alias" directive
  let connAlias = '';
  const connMatch = sql.match(/^--\s*connection\s*:\s*(\S+)\s*$/m);
  if (connMatch) {
    connAlias = connMatch[1];
  }

  const escaped = sql.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

  // Build connection selection code
  let connCode: string;
  if (connAlias) {
    const safeAlias = connAlias.replace(/[^a-zA-Z0-9_]/g, '_');
    connCode = [
      `_alloy_conn = _CM.connections.get("${safeAlias}")`,
      'if _alloy_conn is None:',
      `    raise RuntimeError("Connection '${safeAlias}' not found. Available: " + ", ".join(_CM.connections.keys()))`,
    ].join('\n');
  } else {
    connCode = [
      '_alloy_conn = _CM.current',
      'if _alloy_conn is None:',
      '    raise RuntimeError("No active database connection. Use the Alloy sidebar to connect first.")',
    ].join('\n');
  }

  const lines = [
    '# [Alloy: SQL Cell]',
    'from sql.connection import ConnectionManager as _CM',
    'import pandas as _pd, json as _json',
    'from IPython.display import display as _display',
    connCode,
    `_alloy_raw = _alloy_conn.execute("""${escaped}""")`,
    'try:',
    '    _alloy_rows = _alloy_raw.fetchall()',
    '    _alloy_cols = list(_alloy_raw.keys()) if hasattr(_alloy_raw, "keys") else [f"col_{i}" for i in range(len(_alloy_rows[0]))] if _alloy_rows else []',
    '    _alloy_last_result = _pd.DataFrame(_alloy_rows, columns=_alloy_cols)',
    '    _alloy_last_columns = list(_alloy_last_result.columns)',
  ];

  // If user specified "-- save as: varname", also save under that name
  if (saveAs) {
    lines.push(`    ${saveAs} = _alloy_last_result.copy()`);
    lines.push(`    print(f"\\u2713 Saved as '${saveAs}' ({len(_alloy_last_result)} rows)")`);
  }

  lines.push(
    '    # Build records for JSON (cap at 1000 rows for display)',
    '    _alloy_records = []',
    '    for _, _r in _alloy_last_result.head(1000).iterrows():',
    '        _rec = {}',
    '        for _c in _alloy_cols:',
    '            _v = _r[_c]',
    '            if _pd.isna(_v): _rec[_c] = None',
    '            elif hasattr(_v, "isoformat"): _rec[_c] = _v.isoformat()',
    '            else:',
    '                try: _json.dumps(_v); _rec[_c] = _v',
    '                except: _rec[_c] = str(_v)',
    '        _alloy_records.append(_rec)',
    '    _alloy_data = {"columns": _alloy_cols, "rows": _alloy_records, "total_rows": len(_alloy_last_result), "truncated": len(_alloy_last_result) > 1000}',
    '    _display({"application/vnd.alloy.resultset+json": _alloy_data, "text/plain": str(_alloy_last_result)}, raw=True)',
    'except Exception as _e:',
    '    if "no results" in str(_e).lower() or "not a query" in str(_e).lower():',
    '        print("Statement executed successfully (no result set).")',
    '    else:',
    '        raise _e',
    'finally:',
    '    for _v in ["_alloy_raw","_alloy_rows","_alloy_cols","_alloy_conn","_CM","_pd","_json","_display","_alloy_records","_alloy_data","_rec","_r","_c","_v","_e"]:',
    '        try: exec(f"del {_v}")',
    '        except: pass'
  );
  return lines.join('\n');
}



/**
 * Build Python code that wraps R code for transparent execution.
 * Smart approach:
 *   1. Parse R code to find which Python variables it references
 *   2. Transfer only those via Arrow (zero-copy) or pandas2ri (fallback)
 *   3. Run R code
 *   4. Pull back only NEW variables created in R
 */
function wrapRAsPython(rCode: string): string {
  const escaped = rCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return [
    '# [Alloy: R Cell]',
    'import os as _os, pandas as _pd',
    '',
    '# ── Ensure R_HOME and PATH are set before importing rpy2 ──',
    'if not _os.environ.get("R_HOME"):',
    '    for _rdir in ["C:/Program Files/R/R-4.5.3", "C:/Program Files/R/R-4.4.2", "C:/Program Files/R/R-4.4.1", "C:/Program Files/R/R-4.4.0"]:',
    '        if _os.path.isfile(_os.path.join(_rdir, "bin/x64/R.dll")):',
    '            _os.environ["R_HOME"] = _rdir',
    '            break',
    'if _os.environ.get("R_HOME"):',
    '    _rbin = _os.path.join(_os.environ["R_HOME"], "bin", "x64")',
    '    if _rbin not in _os.environ.get("PATH", ""):',
    '        _os.environ["PATH"] = _rbin + ";" + _os.environ.get("PATH", "")',
    '    try: _os.add_dll_directory(_rbin)',
    '    except: pass',
    '',
    '# ── Setup rpy2 ──',
    'try:',
    '    import rpy2.robjects as _ro',
    '    from rpy2.robjects import pandas2ri as _p2r_mod',
    'except ImportError:',
    '    raise RuntimeError("rpy2 is not installed. Run: pip install rpy2")',
    '',
    'try:',
    '    get_ipython().run_line_magic("load_ext", "rpy2.ipython")',
    'except: pass',
    '',
    '# ── Detect which Python variables the R code references ──',
    `_alloy_r_code = """${escaped}"""`,
    'try:',
    '    _ro.r.assign("._alloy_code", _alloy_r_code)',
    '    _alloy_r_symbols = set(_ro.r("unique(getParseData(parse(text=._alloy_code))$text[getParseData(parse(text=._alloy_code))$token == \'SYMBOL\'])"))',
    '    _ro.r("rm(._alloy_code)")',
    'except:',
    '    # Fallback: simple regex scan for Python variable names',
    '    import re as _re',
    '    _alloy_r_symbols = set(_re.findall(r"\\b([a-zA-Z_]\\w*)\\b", _alloy_r_code))',
    '    try: del _re',
    '    except: pass',
    '',
    '# Intersect with Python namespace — only transfer what R actually needs',
    '_alloy_py_vars = {k: v for k, v in get_ipython().user_ns.items()',
    '                  if not k.startswith("_") and k in _alloy_r_symbols}',
    '',
    '# Also include _alloy_last_result as "last_result" if referenced',
    'if "last_result" in _alloy_r_symbols and "_alloy_last_result" in get_ipython().user_ns:',
    '    _alloy_py_vars["last_result"] = get_ipython().user_ns["_alloy_last_result"]',
    '',
    '# ── Transfer via Arrow (fast) or pandas2ri (fallback) ──',
    '_alloy_use_arrow = False',
    'try:',
    '    import pyarrow as _pa',
    '    import rpy2_arrow.arrow as _pyra',
    '    _alloy_use_arrow = True',
    'except ImportError:',
    '    pass',
    '',
    '# Build converter for pandas <-> R',
    '_alloy_converter = _ro.default_converter + _p2r_mod.converter',
    '',
    'with _alloy_converter.context():',
    '    for _name, _obj in _alloy_py_vars.items():',
    '        try:',
    '            if isinstance(_obj, _pd.DataFrame):',
    '                if _alloy_use_arrow:',
    '                    _ro.globalenv[_name] = _pyra.pyarrow_table_to_r_table(_pa.Table.from_pandas(_obj))',
    '                else:',
    '                    _ro.globalenv[_name] = _obj',
    '            elif isinstance(_obj, (int, float)):',
    '                _ro.globalenv[_name] = _ro.FloatVector([_obj])',
    '            elif isinstance(_obj, str):',
    '                _ro.globalenv[_name] = _ro.StrVector([_obj])',
    '            elif isinstance(_obj, bool):',
    '                _ro.globalenv[_name] = _ro.BoolVector([_obj])',
    '        except: pass',
    '',
    '# ── Snapshot R env, execute, diff ──',
    '_alloy_r_before = set(_ro.globalenv.keys())',
    '',
    `get_ipython().run_cell_magic("R", "", """${escaped}""")`,
    '',
    '# ── Pull back only NEW R variables as DataFrames ──',
    '_alloy_r_after = set(_ro.globalenv.keys())',
    'for _rvar in _alloy_r_after - _alloy_r_before:',
    '    try:',
    '        _robj = _ro.globalenv[_rvar]',
    '        _rclass = set(list(_robj.rclass)) if hasattr(_robj, "rclass") else set()',
    '        if _rclass & {"data.frame", "tbl_df", "tbl", "matrix"}:',
    '            with _alloy_converter.context():',
    '                get_ipython().user_ns[_rvar] = _ro.conversion.get_conversion().rpy2py(_robj)',
    '    except Exception as _err:',
    '        print(f"Alloy: could not pull back {_rvar}: {_err}")',
    '',
    '# ── Cleanup ──',
    'for _v in ["_ro","_pa","_pyra","_p2r_mod","_pd","_os","_alloy_r_code","_alloy_r_symbols","_alloy_py_vars","_alloy_use_arrow","_alloy_converter","_name","_obj","_alloy_r_before","_alloy_r_after","_rvar","_robj","_rbin","_rdir","_re"]:',
    '    try: exec(f"del {_v}")',
    '    except: pass',
  ].join('\n');
}

/**
 * Main plugin.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Multi-language notebook extension for JupyterLab with SQL, charting, and cross-language data sharing',
  autoStart: true,
  requires: [INotebookTracker, IRenderMimeRegistry],
  optional: [ISettingRegistry, ILayoutRestorer, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    rendermime: IRenderMimeRegistry,
    settingRegistry: ISettingRegistry | null,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null
  ) => {
    console.log('Alloy Notebooks activated');

    // ──────────────────────────────────────────────
    // 1. Register custom MIME renderer for SQL results
    // ──────────────────────────────────────────────
    rendermime.addFactory(alloyRendererFactory, 0);

    // ──────────────────────────────────────────────
    // 2. Connection Manager sidebar
    // ──────────────────────────────────────────────
    const onConnect = (connString: string, alias: string) => {
      const escaped = connString.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const safeAlias = alias.replace(/[^a-zA-Z0-9_]/g, '_');
      executeInKernel(
        tracker,
        [
          'try:',
          '    get_ipython().run_line_magic("load_ext", "sql")',
          'except: pass',
          `_alloy_conn_str = '${escaped}'`,
          'from sql.connection import ConnectionManager as _CM',
          `_CM.set(_alloy_conn_str, displaycon=False, alias="${safeAlias}")`,
          `print("\\u2713 Connected to ${safeAlias}")`,
          'del _alloy_conn_str, _CM'
        ].join('\n')
      );
    };

    const onDisconnect = (alias: string) => {
      executeInKernel(
        tracker,
        [
          'from sql.connection import ConnectionManager as _CM',
          `_CM.close_connection_with_descriptor("${alias}")`,
          'del _CM',
          `print("Disconnected from ${alias}")`
        ].join('\n')
      );
    };

    const connectionPanel = new ConnectionPanel(
      app.serviceManager.serverSettings,
      onConnect,
      onDisconnect
    );

    app.shell.add(connectionPanel, 'left', { rank: 200 });

    if (restorer) {
      restorer.add(connectionPanel, 'alloy-connection-panel');
    }

    // Listen for kernel restarts to auto-reconnect
    tracker.widgetAdded.connect((_, panel) => {
      const session = panel.sessionContext;
      session.statusChanged.connect((_, status) => {
        if (status === 'restarting') {
          connectionPanel.notifyKernelRestarted();
        }
      });
    });

    // ──────────────────────────────────────────────
    // 3. Unified cell type dropdown (Python/SQL/R/Markdown/Raw)
    // ──────────────────────────────────────────────
    addCellTypeSelectorToNotebook(tracker);

    const LANGUAGES: Record<string, { label: string; mime: string }> = {
      python: { label: 'Python', mime: 'text/x-python' },
      sql: { label: 'SQL', mime: 'text/x-sql' },
      r: { label: 'R', mime: 'text/x-rsrc' }
    };

    app.commands.addCommand('alloy:set-cell-language', {
      label: args => {
        const lang = (args.language as string) || 'python';
        return `Set cell language: ${LANGUAGES[lang]?.label || lang}`;
      },
      execute: args => {
        const lang = (args.language as string) || 'python';
        const notebook = tracker.currentWidget;
        if (!notebook) {
          return;
        }
        const cell = notebook.content.activeCell;
        if (!cell) {
          return;
        }
        cell.model.setMetadata(LANGUAGE_KEY, lang);
        const langDef = LANGUAGES[lang];
        if (langDef) {
          cell.model.mimeType = langDef.mime;
        }
      }
    });

    for (const lang of Object.keys(LANGUAGES)) {
      if (palette) {
        palette.addItem({
          command: 'alloy:set-cell-language',
          category: 'Alloy Notebooks',
          args: { language: lang }
        });
      }
    }

    // ──────────────────────────────────────────────
    // 5. Intercept SQL/R cell execution
    // ──────────────────────────────────────────────
    NotebookActions.executionScheduled.connect((_, args) => {
      const { cell } = args;
      const lang = cell.model.getMetadata(LANGUAGE_KEY);

      if (lang === 'sql') {
        const source = cell.model.sharedModel.getSource();
        if (!source.trimStart().startsWith('#') && !source.trimStart().startsWith('%')) {
          // Replace SQL with Python wrapper code
          const pythonCode = wrapSqlAsPython(source);
          cell.model.sharedModel.setSource(pythonCode);
          // Restore original SQL source after execution starts
          const originalSource = source;
          setTimeout(() => {
            cell.model.sharedModel.setSource(originalSource);
          }, 800);
        }
      } else if (lang === 'r') {
        const source = cell.model.sharedModel.getSource();
        if (!source.trimStart().startsWith('%%') && !source.trimStart().startsWith('%')) {
          const pythonCode = wrapRAsPython(source);
          cell.model.sharedModel.setSource(pythonCode);
          const originalSource = source;
          setTimeout(() => {
            cell.model.sharedModel.setSource(originalSource);
          }, 800);
        }
      }
    });

    // ──────────────────────────────────────────────
    // 6. Auto-load JupySQL and Alloy kernel magic when notebook opens
    // ──────────────────────────────────────────────
    tracker.widgetAdded.connect((_, notebookPanel) => {
      notebookPanel.sessionContext.ready.then(async () => {
        const kernel = notebookPanel.sessionContext.session?.kernel;
        if (!kernel) {
          return;
        }
        // Load sql first, wait for it to finish, then load alloy kernel
        // Loading both in one requestExecute causes a deadlock
        const f1 = kernel.requestExecute({
          code: 'try:\n    get_ipython().run_line_magic("load_ext", "sql")\nexcept: pass',
          silent: true
        });
        await f1.done;
        kernel.requestExecute({
          code: 'try:\n    get_ipython().run_line_magic("load_ext", "alloy_notebooks.kernel")\nexcept: pass',
          silent: true
        });
      });
    });

    // ──────────────────────────────────────────────
    // 7. Restore syntax highlighting on cell focus
    // ──────────────────────────────────────────────
    tracker.activeCellChanged.connect((_, cell) => {
      if (!cell) {
        return;
      }
      const lang = cell.model.getMetadata(LANGUAGE_KEY) as string;
      if (lang && LANGUAGES[lang]) {
        cell.model.mimeType = LANGUAGES[lang].mime;
      }
    });

    // Apply highlighting AND language icon classes to all cells
    const applyAllCellClasses = (notebookPanel: any) => {
      const notebook = notebookPanel.content;
      for (let i = 0; i < notebook.widgets.length; i++) {
        const cell = notebook.widgets[i];
        const cellType = cell.model.type;

        // Remove old alloy-cell-* classes
        const node = cell.node;
        node.classList.forEach((cls: string) => {
          if (cls.startsWith('alloy-cell-')) {
            node.classList.remove(cls);
          }
        });

        if (cellType === 'markdown') {
          node.classList.add('alloy-cell-markdown');
        } else if (cellType === 'raw') {
          node.classList.add('alloy-cell-raw');
        } else {
          const lang = (cell.model.getMetadata(LANGUAGE_KEY) as string) || 'python';
          node.classList.add(`alloy-cell-${lang}`);
          // Also restore syntax highlighting
          if (LANGUAGES[lang]) {
            cell.model.mimeType = LANGUAGES[lang].mime;
          }
        }
      }
    };

    tracker.widgetAdded.connect((_, notebookPanel) => {
      const notebook = notebookPanel.content;
      const refresh = () => applyAllCellClasses(notebookPanel);
      notebook.modelContentChanged.connect(refresh);
      refresh();
    });

    // Also refresh on active cell change (handles metadata changes from dropdown)
    tracker.activeCellChanged.connect(() => {
      const panel = tracker.currentWidget;
      if (panel) {
        applyAllCellClasses(panel);
      }
    });

    // ──────────────────────────────────────────────
    // 8. Language icon toggle via settings
    // ──────────────────────────────────────────────
    if (settingRegistry) {
      settingRegistry.load(PLUGIN_ID).then(settings => {
        const updateIcons = () => {
          const show = settings.get('showLanguageIcons').composite as boolean;
          tracker.forEach(panel => {
            if (show) {
              panel.content.node.classList.add('alloy-icons-enabled');
            } else {
              panel.content.node.classList.remove('alloy-icons-enabled');
            }
          });
        };
        settings.changed.connect(updateIcons);
        updateIcons();

        // Also apply to newly opened notebooks
        tracker.widgetAdded.connect((_, panel) => {
          const show = settings.get('showLanguageIcons').composite as boolean;
          if (show) {
            panel.content.node.classList.add('alloy-icons-enabled');
          }
        });
      }).catch(() => {
        // Settings not available -- default to showing icons
        tracker.widgetAdded.connect((_, panel) => {
          panel.content.node.classList.add('alloy-icons-enabled');
        });
      });
    }
  }
};

export default plugin;
