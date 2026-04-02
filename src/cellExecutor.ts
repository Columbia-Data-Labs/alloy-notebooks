/**
 * Custom cell executor for Alloy Notebooks.
 * Intercepts SQL and R cells, executes wrapped Python code via OutputArea.execute(),
 * without modifying cell source — no orange "modified since execution" indicator.
 * For all other cells, delegates to the default execution path.
 */

import {
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { INotebookCellExecutor, runCell as jupyterDefaultRunCell } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { OutputArea } from '@jupyterlab/outputarea';
import { JSONObject } from '@lumino/coreutils';

const LANGUAGE_KEY = 'alloy:language';

/**
 * Check if a cell is an Alloy SQL or R cell.
 */
function getAlloyLanguage(cell: any): string | null {
  try {
    const lang = cell.model.getMetadata(LANGUAGE_KEY);
    if (lang === 'sql' || lang === 'r') {
      const source: string = cell.model.sharedModel.getSource();
      // Skip if user wrote Python magic (starts with %)
      // Note: # is a valid comment in both SQL and R, so don't skip on #
      if (source.trimStart().startsWith('%')) {
        return null;
      }
      return lang;
    }
  } catch {
    // not a code cell or no metadata
  }
  return null;
}

/**
 * The custom runCell function.
 */
async function alloyRunCell(
  options: INotebookCellExecutor.IRunCellOptions
): Promise<boolean> {
  const { cell, sessionContext, onCellExecuted, onCellExecutionScheduled } = options;

  const lang = getAlloyLanguage(cell);

  // For non-Alloy cells, use the default JupyterLab executor
  if (!lang || cell.model.type !== 'code') {
    return jupyterDefaultRunCell(options);
  }

  const codeCell = cell as CodeCell;
  const model = codeCell.model;
  const source = model.sharedModel.getSource();

  if (!source.trim() || !sessionContext?.session?.kernel) {
    model.sharedModel.transact(() => {
      model.clearExecution();
    }, false);
    return true;
  }

  const wrappedCode = lang === 'sql'
    ? buildSqlWrapper(source)
    : buildRWrapper(source);

  // Fire the scheduled signal
  onCellExecutionScheduled({ cell });

  // Clear previous outputs
  model.sharedModel.transact(() => {
    model.clearExecution();
    codeCell.outputHidden = false;
  }, false);

  try {
    // Execute the WRAPPED code, piping output to this cell's outputArea
    // Cell source is NEVER modified — no orange indicator
    const metadata = model.metadata as unknown as JSONObject;
    const reply = await OutputArea.execute(
      wrappedCode,
      codeCell.outputArea,
      sessionContext,
      metadata
    );

    if (cell.isDisposed) {
      return false;
    }

    if (reply) {
      model.executionCount = reply.content.execution_count;
    }

    if (!reply || reply.content.status === 'ok') {
      onCellExecuted({ cell, success: true });
      return true;
    } else {
      const content = reply.content as any;
      const error = new Error(
        `${content.ename || 'Error'}: ${content.evalue || 'Unknown error'}`
      );
      onCellExecuted({ cell, success: false, error: error as any });
      throw error;
    }
  } catch (e: any) {
    if (cell.isDisposed || e.message?.startsWith('Canceled')) {
      return false;
    }
    onCellExecuted({ cell, success: false, error: e });
    throw e;
  }
}

// ── SQL/R wrapper builders (duplicated from index.ts to keep this self-contained) ──

function buildSqlWrapper(sql: string): string {
  let saveAs = '';
  const saveMatch = sql.match(/^--\s*save\s+as\s*:\s*([a-zA-Z_]\w*)\s*$/m);
  if (saveMatch) {
    saveAs = saveMatch[1];
  }

  let connAlias = '';
  const connMatch = sql.match(/^--\s*connection\s*:\s*(\S+)\s*$/m);
  if (connMatch) {
    connAlias = connMatch[1];
  }

  const escaped = sql.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

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
      '_alloy_conns = _CM.connections',
      'if len(_alloy_conns) == 0:',
      '    raise RuntimeError("No active database connection. Use the Alloy sidebar to connect first.")',
      'elif len(_alloy_conns) == 1:',
      '    _alloy_conn = list(_alloy_conns.values())[0]',
      'else:',
      '    raise RuntimeError(',
      '        "Multiple connections are active. Specify which one with:\\n"',
      '        "  -- connection: <alias>\\n\\n"',
      '        "Available connections: " + ", ".join(_alloy_conns.keys())',
      '    )',
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

  if (saveAs) {
    lines.push(`    ${saveAs} = _alloy_last_result.copy()`);
    lines.push(`    print(f"\\u2713 Saved as '${saveAs}' ({len(_alloy_last_result)} rows)")`);
  }

  lines.push(
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
    '    for _v in ["_alloy_raw","_alloy_rows","_alloy_cols","_alloy_conn","_alloy_conns","_CM","_pd","_json","_display","_alloy_records","_alloy_data","_rec","_r","_c","_v","_e"]:',
    '        try: exec(f"del {_v}")',
    '        except: pass'
  );
  return lines.join('\n');
}

function buildRWrapper(rCode: string): string {
  const escaped = rCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return [
    '# [Alloy: R Cell]',
    'import os as _os, pandas as _pd',
    '',
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
    `_alloy_r_code = """${escaped}"""`,
    'try:',
    '    _ro.r.assign("._alloy_code", _alloy_r_code)',
    '    _alloy_r_symbols = set(_ro.r("unique(getParseData(parse(text=._alloy_code))$text[getParseData(parse(text=._alloy_code))$token == \'SYMBOL\'])"))',
    '    _ro.r("rm(._alloy_code)")',
    'except:',
    '    import re as _re',
    '    _alloy_r_symbols = set(_re.findall(r"\\b([a-zA-Z_]\\w*)\\b", _alloy_r_code))',
    '    try: del _re',
    '    except: pass',
    '',
    '_alloy_py_vars = {k: v for k, v in get_ipython().user_ns.items()',
    '                  if not k.startswith("_") and k in _alloy_r_symbols}',
    '',
    'if "last_result" in _alloy_r_symbols and "_alloy_last_result" in get_ipython().user_ns:',
    '    _alloy_py_vars["last_result"] = get_ipython().user_ns["_alloy_last_result"]',
    '',
    '_alloy_use_arrow = False',
    'try:',
    '    import pyarrow as _pa',
    '    import rpy2_arrow.arrow as _pyra',
    '    _alloy_use_arrow = True',
    'except ImportError:',
    '    pass',
    '',
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
    '_alloy_r_before = set(_ro.globalenv.keys())',
    '',
    `get_ipython().run_cell_magic("R", "", """${escaped}""")`,
    '',
    'for _rvar in set(_ro.globalenv.keys()) - _alloy_r_before:',
    '    try:',
    '        _robj = _ro.globalenv[_rvar]',
    '        _rclass = set(list(_robj.rclass)) if hasattr(_robj, "rclass") else set()',
    '        if _rclass & {"data.frame", "tbl_df", "tbl", "matrix"}:',
    '            with _alloy_converter.context():',
    '                get_ipython().user_ns[_rvar] = _ro.conversion.get_conversion().rpy2py(_robj)',
    '    except Exception as _err:',
    '        print(f"Alloy: could not pull back {_rvar}: {_err}")',
    '',
    'for _v in ["_ro","_pa","_pyra","_p2r_mod","_pd","_os","_alloy_r_code","_alloy_r_symbols","_alloy_py_vars","_alloy_use_arrow","_alloy_converter","_name","_obj","_alloy_r_before","_rvar","_robj","_rbin","_rdir","_re","_rclass","_err"]:',
    '    try: exec(f"del {_v}")',
    '    except: pass',
  ].join('\n');
}

/**
 * The plugin that provides INotebookCellExecutor.
 * Must disable the default: @jupyterlab/notebook-extension:cell-executor
 */
export const alloyCellExecutor: JupyterFrontEndPlugin<INotebookCellExecutor> = {
  id: 'alloy-notebooks:cell-executor',
  description: 'Custom cell executor that intercepts SQL and R cells.',
  autoStart: true,
  provides: INotebookCellExecutor,
  activate: (): INotebookCellExecutor => {
    console.log('Alloy cell executor activated');
    return Object.freeze({ runCell: alloyRunCell });
  }
};
