/**
 * Unified cell type selector — replaces both JupyterLab's Code/Markdown/Raw
 * dropdown and Alloy's language selector with a single dropdown:
 * Python | SQL | R | Markdown | Raw
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/ui-components';
import { INotebookTracker, NotebookPanel, NotebookActions } from '@jupyterlab/notebook';

const LANGUAGE_KEY = 'alloy:language';

const CELL_OPTIONS = [
  { value: 'python', label: 'Python', cellType: 'code' as const, mime: 'text/x-python' },
  { value: 'sql', label: 'SQL', cellType: 'code' as const, mime: 'text/x-sql' },
  { value: 'duckdb', label: 'DuckDB', cellType: 'code' as const, mime: 'text/x-sql' },
  { value: 'r', label: 'R', cellType: 'code' as const, mime: 'text/x-rsrc' },
  { value: 'markdown', label: 'Markdown', cellType: 'markdown' as const, mime: '' },
  { value: 'raw', label: 'Raw', cellType: 'raw' as const, mime: '' }
];

interface ICellTypeSelectorProps {
  tracker: INotebookTracker;
}

const CellTypeSelectorComponent: React.FC<ICellTypeSelectorProps> = ({
  tracker
}) => {
  const [currentValue, setCurrentValue] = useState('python');

  const syncFromCell = useCallback(() => {
    const cell = tracker.activeCell;
    if (!cell) {
      return;
    }
    const cellType = cell.model.type;
    if (cellType === 'markdown') {
      setCurrentValue('markdown');
    } else if (cellType === 'raw') {
      setCurrentValue('raw');
    } else {
      const lang =
        (cell.model.getMetadata(LANGUAGE_KEY) as string) || 'python';
      setCurrentValue(lang);
    }
  }, [tracker]);

  useEffect(() => {
    tracker.activeCellChanged.connect(syncFromCell);
    syncFromCell();
    return () => {
      tracker.activeCellChanged.disconnect(syncFromCell);
    };
  }, [tracker, syncFromCell]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setCurrentValue(value);

    const notebook = tracker.currentWidget;
    if (!notebook) {
      return;
    }

    const option = CELL_OPTIONS.find(o => o.value === value);
    if (!option) {
      return;
    }

    if (option.cellType === 'code') {
      // If current cell isn't code, change it to code first
      const cell = notebook.content.activeCell;
      if (cell && cell.model.type !== 'code') {
        NotebookActions.changeCellType(notebook.content, 'code');
      }
      // Re-acquire cell reference (changeCellType may recreate it)
      const activeCell = notebook.content.activeCell;
      if (activeCell) {
        activeCell.model.setMetadata(LANGUAGE_KEY, value);
        if (option.mime) {
          activeCell.model.mimeType = option.mime;
        }
      }
    } else {
      // Markdown or Raw — change cell type, clear language metadata
      NotebookActions.changeCellType(notebook.content, option.cellType);
      const activeCell = notebook.content.activeCell;
      if (activeCell) {
        try {
          activeCell.model.deleteMetadata(LANGUAGE_KEY);
        } catch {
          // deleteMetadata may not exist in all versions
        }
      }
    }
  };

  return (
    <div className="alloy-language-selector">
      <select
        className="alloy-lang-select"
        value={currentValue}
        onChange={handleChange}
      >
        {CELL_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

/**
 * Lumino widget wrapper.
 */
export class CellTypeSelectorWidget extends ReactWidget {
  private _tracker: INotebookTracker;

  constructor(tracker: INotebookTracker) {
    super();
    this._tracker = tracker;
    this.addClass('alloy-lang-toolbar-item');
  }

  render(): JSX.Element {
    return <CellTypeSelectorComponent tracker={this._tracker} />;
  }
}

/**
 * Install the unified selector into each notebook's toolbar.
 */
export function addCellTypeSelectorToNotebook(
  tracker: INotebookTracker
): void {
  tracker.widgetAdded.connect((_: INotebookTracker, panel: NotebookPanel) => {
    const widget = new CellTypeSelectorWidget(tracker);
    panel.toolbar.insertAfter('cellType', 'alloyCellType', widget);
  });
}
