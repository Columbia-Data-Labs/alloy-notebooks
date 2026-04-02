/**
 * Alloy Notebooks — JupyterLab extension entry point.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer
} from '@jupyterlab/application';

import { INotebookTracker } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ICommandPalette } from '@jupyterlab/apputils';

import { ConnectionPanel } from './ConnectionPanel';
import { alloyRendererFactory } from './ResultRenderer';
import { addCellTypeSelectorToNotebook } from './LanguageSelector';
import { alloyCellExecutor } from './cellExecutor';

const PLUGIN_ID = 'alloy-notebooks:plugin';
const LANGUAGE_KEY = 'alloy:language';

/**
 * Apply CodeMirror language directly to a cell's editor.
 * JupyterLab's CodeMirrorEditor stores the language in an internal Compartment
 * called _language. We access it and reconfigure.
 */
async function applyCMLanguage(cell: any, lang: string): Promise<void> {
  if (lang === 'python') {
    return; // default, no override needed
  }
  try {
    // Access the JupyterLab CodeMirrorEditor wrapper
    const cmEditor = cell?.editor;
    if (!cmEditor) {
      return;
    }

    // JupyterLab's CodeMirrorEditor has a _language Compartment
    // and a _onMimeTypeChanged method. We can trigger it by setting mimeType
    // on the editor's model. But this gets overridden.
    // Instead, access the internal _language compartment directly.
    const editorView = cmEditor.editor;
    const langCompartment = cmEditor._language;
    if (!editorView || !langCompartment) {
      return;
    }

    let langExtension: any;
    if (lang === 'sql') {
      const m = await import('@codemirror/lang-sql');
      langExtension = m.sql().language;
    } else if (lang === 'r') {
      const { StreamLanguage } = await import('@codemirror/language');
      const m = await import('@codemirror/legacy-modes/mode/r');
      langExtension = StreamLanguage.define(m.r);
    }

    if (langExtension) {
      editorView.dispatch({
        effects: langCompartment.reconfigure(langExtension)
      });
    }
  } catch (e) {
    console.debug('Alloy: CM language switch failed:', e);
  }
}

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
 * Main plugin — UI, connection manager, language selector, settings.
 * Cell execution for SQL/R is handled by alloyCellExecutor (separate plugin).
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
    // 4. Auto-load JupySQL and Alloy kernel magic when notebook opens
    // ──────────────────────────────────────────────
    tracker.widgetAdded.connect((_, notebookPanel) => {
      notebookPanel.sessionContext.ready.then(async () => {
        const kernel = notebookPanel.sessionContext.session?.kernel;
        if (!kernel) {
          return;
        }
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
    // 5. Restore syntax highlighting and apply language icon classes
    // ──────────────────────────────────────────────
    tracker.activeCellChanged.connect((_, cell) => {
      if (!cell) {
        return;
      }
      const lang = cell.model.getMetadata(LANGUAGE_KEY) as string;
      if (lang && LANGUAGES[lang]) {
        cell.model.mimeType = LANGUAGES[lang].mime;
        applyCMLanguage(cell, lang);
      }
    });

    const applyAllCellClasses = (notebookPanel: any) => {
      const notebook = notebookPanel.content;
      for (let i = 0; i < notebook.widgets.length; i++) {
        const cell = notebook.widgets[i];
        const cellType = cell.model.type;
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
          if (LANGUAGES[lang]) {
            cell.model.mimeType = LANGUAGES[lang].mime;
            applyCMLanguage(cell, lang);
          }
        }
      }
    };

    tracker.widgetAdded.connect((_, notebookPanel) => {
      const notebook = notebookPanel.content;
      const refresh = () => applyAllCellClasses(notebookPanel);
      notebook.modelContentChanged.connect(refresh);
      // Apply immediately and again after a short delay
      // (CodeMirror loads language modes async, so early calls may not stick)
      refresh();
      setTimeout(refresh, 500);
      setTimeout(refresh, 2000);
    });

    tracker.activeCellChanged.connect(() => {
      const panel = tracker.currentWidget;
      if (panel) {
        applyAllCellClasses(panel);
      }
    });

    // ──────────────────────────────────────────────
    // 6. Language icon toggle via settings
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
        tracker.widgetAdded.connect((_, panel) => {
          const show = settings.get('showLanguageIcons').composite as boolean;
          if (show) {
            panel.content.node.classList.add('alloy-icons-enabled');
          }
        });
      }).catch(() => {
        tracker.widgetAdded.connect((_, panel) => {
          panel.content.node.classList.add('alloy-icons-enabled');
        });
      });
    }
  }
};

// Export both plugins: main UI + cell executor
export default [plugin, alloyCellExecutor];
