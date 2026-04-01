/**
 * Chart Configuration dialog — replicates Azure Data Studio's "Configure Chart" panel.
 */

import React, { useState } from 'react';
import { ReactWidget } from '@jupyterlab/ui-components';

export interface IChartConfig {
  type: string;
  x: string;
  y: string;
  title: string;
  direction: string;
  legend: string;
  x_label: string;
  y_label: string;
  color: string;
  width: string;
  height: string;
  bins: string;
}

const DEFAULT_CONFIG: IChartConfig = {
  type: 'bar',
  x: '',
  y: '',
  title: '',
  direction: 'vertical',
  legend: 'top',
  x_label: '',
  y_label: '',
  color: '',
  width: '10',
  height: '6',
  bins: '20'
};

const CHART_TYPES = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'pie', label: 'Pie' },
  { value: 'histogram', label: 'Histogram' },
  { value: 'area', label: 'Area' }
];

interface IChartDialogProps {
  columns: string[];
  onConfigChange: (config: IChartConfig) => void;
  initialConfig?: Partial<IChartConfig>;
}

const ChartDialogComponent: React.FC<IChartDialogProps> = ({
  columns,
  onConfigChange,
  initialConfig
}) => {
  const [config, setConfig] = useState<IChartConfig>({
    ...DEFAULT_CONFIG,
    x: columns[0] || '',
    y: columns.length > 1 ? columns[1] : columns[0] || '',
    ...initialConfig
  });

  const update = (field: keyof IChartConfig, value: string) => {
    const newConfig = { ...config, [field]: value };
    setConfig(newConfig);
    onConfigChange(newConfig);
  };

  return (
    <div className="alloy-chart-dialog">
      <div className="alloy-form-group">
        <label>Chart Type</label>
        <select value={config.type} onChange={e => update('type', e.target.value)}>
          {CHART_TYPES.map(t => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {config.type !== 'histogram' && (
        <div className="alloy-form-group">
          <label>Data Direction</label>
          <select
            value={config.direction}
            onChange={e => update('direction', e.target.value)}
          >
            <option value="vertical">Vertical</option>
            <option value="horizontal">Horizontal</option>
          </select>
        </div>
      )}

      <div className="alloy-form-group">
        <label>{config.type === 'pie' ? 'Labels Column' : 'X Axis Column'}</label>
        <select value={config.x} onChange={e => update('x', e.target.value)}>
          {columns.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="alloy-form-group">
        <label>{config.type === 'pie' ? 'Values Column' : 'Y Axis Column'}</label>
        <select value={config.y} onChange={e => update('y', e.target.value)}>
          {columns.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {config.type === 'histogram' && (
        <div className="alloy-form-group">
          <label>Bins</label>
          <input
            type="number"
            value={config.bins}
            onChange={e => update('bins', e.target.value)}
            min="1"
            max="200"
          />
        </div>
      )}

      <div className="alloy-form-group">
        <label>Legend Position</label>
        <select
          value={config.legend}
          onChange={e => update('legend', e.target.value)}
        >
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
          <option value="none">None</option>
        </select>
      </div>

      <div className="alloy-form-group">
        <label>Title</label>
        <input
          type="text"
          value={config.title}
          onChange={e => update('title', e.target.value)}
          placeholder="Chart title"
        />
      </div>

      <div className="alloy-form-group">
        <label>X Axis Label</label>
        <input
          type="text"
          value={config.x_label}
          onChange={e => update('x_label', e.target.value)}
        />
      </div>

      <div className="alloy-form-group">
        <label>Y Axis Label</label>
        <input
          type="text"
          value={config.y_label}
          onChange={e => update('y_label', e.target.value)}
        />
      </div>

      <div className="alloy-form-group">
        <label>Color</label>
        <input
          type="text"
          value={config.color}
          onChange={e => update('color', e.target.value)}
          placeholder="e.g. steelblue, #ff6600"
        />
      </div>
    </div>
  );
};

/**
 * Create a ReactWidget body for use with showDialog.
 */
export class ChartDialogBody extends ReactWidget {
  private _columns: string[];
  private _config: IChartConfig;
  private _initialConfig?: Partial<IChartConfig>;

  constructor(columns: string[], initialConfig?: Partial<IChartConfig>) {
    super();
    this._columns = columns;
    this._initialConfig = initialConfig;
    this._config = {
      ...DEFAULT_CONFIG,
      x: columns[0] || '',
      y: columns.length > 1 ? columns[1] : columns[0] || '',
      ...initialConfig
    };
  }

  getValue(): IChartConfig {
    return this._config;
  }

  render(): JSX.Element {
    return (
      <ChartDialogComponent
        columns={this._columns}
        initialConfig={this._initialConfig}
        onConfigChange={config => {
          this._config = config;
        }}
      />
    );
  }
}
