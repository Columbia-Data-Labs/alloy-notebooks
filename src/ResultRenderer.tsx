/**
 * Custom MIME renderer for Alloy SQL results.
 * Renders tabular data with Table/Chart toggle and inline chart rendering.
 * Default chart: grouped bars — columns on X-axis, one series per row (like Azure Data Studio).
 */

import React, { useState, useRef, useEffect } from 'react';
import { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { ReactWidget } from '@jupyterlab/ui-components';
import { showDialog, Dialog } from '@jupyterlab/apputils';
import { ChartDialogBody, IChartConfig } from './ChartDialog';

export const ALLOY_MIME_TYPE = 'application/vnd.alloy.resultset+json';

interface IAlloyResultData {
  columns: string[];
  rows: Record<string, any>[];
  total_rows: number;
  truncated: boolean;
}

const SERIES_COLORS = [
  '#FF9DA7', '#7EB5D6', '#B6D7A8', '#FFD966',
  '#D5A6BD', '#A4C2F4', '#F6B26B', '#93C47D',
  '#E06666', '#6FA8DC', '#8E7CC3', '#C27BA0'
];

/**
 * Render a grid of value-count bar charts, one per column.
 * Each chart shows the frequency distribution of values in that column.
 */
function renderDefaultChartGrid(
  data: IAlloyResultData
): string {
  const rows = data.rows;
  const columns = data.columns;

  if (rows.length === 0 || columns.length === 0) {
    return '<div style="padding:20px;color:#888;text-align:center">No data to chart</div>';
  }

  // Build value counts for each column
  const columnCharts = columns.map(col => {
    const counts: Record<string, number> = {};
    rows.forEach(row => {
      const val = row[col] === null || row[col] === undefined ? 'NULL' : String(row[col]);
      // Truncate long values for display
      const key = val.length > 30 ? val.substring(0, 27) + '...' : val;
      counts[key] = (counts[key] || 0) + 1;
    });

    // Sort by count descending
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    // Cap at 15 bars max
    const capped = entries.slice(0, 15);
    const maxCount = capped.length > 0 ? capped[0][1] : 1;

    return { col, entries: capped, maxCount };
  });

  // Render each chart as an HTML div with inline SVG
  const chartWidth = 280;
  const chartInnerH = 180;
  const barAreaH = chartInnerH - 5;

  const charts = columnCharts.map(({ col, entries, maxCount }) => {
    const n = entries.length;
    if (n === 0) {
      return `<div class="alloy-mini-chart"><div class="alloy-mini-chart-title">${col}</div><div style="padding:20px;color:#aaa;font-size:11px">No data</div></div>`;
    }

    const barGap = 3;
    const barWidth = Math.max(10, Math.min(40, (chartWidth - 60 - barGap * (n + 1)) / n));
    const totalW = n * barWidth + (n - 1) * barGap;
    const offsetX = (chartWidth - 40 - totalW) / 2 + 35; // 35 for Y-axis labels
    const niceMax = maxCount <= 3 ? maxCount + 1 : Math.ceil(maxCount * 1.15);
    const svgH = chartInnerH + 45; // extra room for x labels

    // Y-axis ticks
    let yAxis = '';
    const ticks = Math.min(5, niceMax);
    for (let i = 0; i <= ticks; i++) {
      const val = Math.round((niceMax / ticks) * i);
      const y = barAreaH - (val / niceMax) * barAreaH;
      yAxis += `<line x1="33" y1="${y}" x2="${chartWidth - 5}" y2="${y}" stroke="#eee" stroke-width="1"/>`;
      yAxis += `<text x="30" y="${y + 4}" text-anchor="end" font-size="10" fill="#999">${val}</text>`;
    }

    // Bars
    let bars = '';
    entries.forEach(([label, count], i) => {
      const barH = Math.max(2, (count / niceMax) * barAreaH);
      const x = offsetX + i * (barWidth + barGap);
      const y = barAreaH - barH;
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" opacity="0.9" rx="2"><title>${label}: ${count}</title></rect>`;
      // Count label on top
      bars += `<text x="${x + barWidth / 2}" y="${y - 3}" text-anchor="middle" font-size="10" font-weight="600" fill="#444">${count}</text>`;
      // X-axis label (rotated)
      const lbl = label.length > 12 ? label.substring(0, 10) + '..' : label;
      bars += `<text x="${x + barWidth / 2}" y="${barAreaH + 10}" text-anchor="end" font-size="9" fill="#666" transform="rotate(-40 ${x + barWidth / 2} ${barAreaH + 10})">${lbl}</text>`;
    });

    const svg = `<svg width="${chartWidth}" height="${svgH}" xmlns="http://www.w3.org/2000/svg" style="font-family:sans-serif">${yAxis}${bars}</svg>`;
    return `<div class="alloy-mini-chart"><div class="alloy-mini-chart-title">${col}</div>${svg}</div>`;
  });

  return `<div class="alloy-chart-grid">${charts.join('')}</div>`;
}

/**
 * Render a configured chart (user-specified X, Y, type).
 */
function renderConfiguredChart(
  data: IAlloyResultData,
  config: IChartConfig,
  width: number,
  height: number
): string {
  const margin = { top: 40, right: 20, bottom: 60, left: 70 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;
  const rows = data.rows;
  const xCol = config.x;
  const yCol = config.y;

  if (rows.length === 0) {
    return `<svg width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#888">No data</text></svg>`;
  }

  const labels = rows.map(r => String(r[xCol] ?? ''));
  const values = rows.map(r => {
    const v = Number(r[yCol]);
    return isNaN(v) ? 0 : v;
  });
  const maxVal = Math.ceil(Math.max(...values, 1) * 1.1);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;
  const scaleY = (v: number) => h - ((v - minVal) / range) * h;

  const fillColor = config.color || SERIES_COLORS[0];

  // Grid
  let grid = '';
  for (let i = 0; i <= 5; i++) {
    const val = minVal + (range / 5) * i;
    const y = scaleY(val);
    grid += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ddd"/>`;
    grid += `<text x="-8" y="${y + 4}" text-anchor="end" font-size="10" fill="#888">${Number.isInteger(val) ? val : val.toFixed(1)}</text>`;
  }

  let content = '';
  const n = labels.length;

  if (config.type === 'bar') {
    const gap = Math.max(2, Math.min(10, w / n * 0.15));
    const barWidth = Math.max(15, (w - gap * (n + 1)) / n);
    const isHoriz = config.direction === 'horizontal';

    if (isHoriz) {
      const barH = Math.max(15, (h - gap * (n + 1)) / n);
      rows.forEach((_, i) => {
        const barW = Math.max(2, ((values[i] - minVal) / range) * w);
        const y = gap + i * (barH + gap);
        content += `<rect x="0" y="${y}" width="${barW}" height="${barH}" fill="${fillColor}" opacity="0.85" rx="2"><title>${labels[i]}: ${values[i]}</title></rect>`;
        content += `<text x="-5" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#666">${labels[i].substring(0, 20)}</text>`;
      });
    } else {
      rows.forEach((_, i) => {
        const x = gap + i * (barWidth + gap);
        const barH = Math.max(2, ((values[i] - minVal) / range) * h);
        const y = h - barH;
        content += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${fillColor}" opacity="0.85" rx="2"><title>${labels[i]}: ${values[i]}</title></rect>`;
        content += `<text x="${x + barWidth / 2}" y="${h + 15}" text-anchor="middle" font-size="10" fill="#666" transform="rotate(-30 ${x + barWidth / 2} ${h + 15})">${labels[i].substring(0, 15)}</text>`;
      });
    }
  } else if (config.type === 'line' || config.type === 'area') {
    const stepX = n > 1 ? w / (n - 1) : w / 2;
    const pts = values.map((v, i) => `${i * stepX},${scaleY(v)}`);
    if (config.type === 'area') {
      content += `<polygon points="0,${scaleY(minVal)} ${pts.join(' ')} ${(n - 1) * stepX},${scaleY(minVal)}" fill="${fillColor}" opacity="0.25"/>`;
    }
    content += `<polyline points="${pts.join(' ')}" fill="none" stroke="${fillColor}" stroke-width="2.5"/>`;
    values.forEach((v, i) => {
      content += `<circle cx="${i * stepX}" cy="${scaleY(v)}" r="4" fill="${fillColor}"><title>${labels[i]}: ${v}</title></circle>`;
    });
    labels.forEach((l, i) => {
      content += `<text x="${i * stepX}" y="${h + 15}" text-anchor="middle" font-size="10" fill="#666">${l.substring(0, 12)}</text>`;
    });
  } else if (config.type === 'scatter') {
    const xValues = rows.map(r => Number(r[xCol]) || 0);
    const xMax = Math.max(...xValues, 1);
    const xMin = Math.min(...xValues, 0);
    const xRange = xMax - xMin || 1;
    xValues.forEach((xv, i) => {
      content += `<circle cx="${((xv - xMin) / xRange) * w}" cy="${scaleY(values[i])}" r="5" fill="${fillColor}" opacity="0.7"><title>${xv}, ${values[i]}</title></circle>`;
    });
  } else if (config.type === 'pie') {
    const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 10;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      const slice = (Math.abs(v) / total) * Math.PI * 2;
      const end = angle + slice;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const lg = slice > Math.PI ? 1 : 0;
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      content += `<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${lg},1 ${x2},${y2} Z" fill="${color}" opacity="0.85"><title>${labels[i]}: ${v}</title></path>`;
      const mid = angle + slice / 2;
      content += `<text x="${cx + radius * 0.65 * Math.cos(mid)}" y="${cy + radius * 0.65 * Math.sin(mid)}" text-anchor="middle" font-size="10" fill="#333">${labels[i].substring(0, 10)}</text>`;
      angle = end;
    });
  }

  const title = config.title ? `<text x="${width / 2}" y="18" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${config.title}</text>` : '';
  const xLabel = config.x_label ? `<text x="${margin.left + w / 2}" y="${height - 5}" text-anchor="middle" font-size="12" fill="#666">${config.x_label}</text>` : '';
  const yLabel = config.y_label ? `<text x="14" y="${margin.top + h / 2}" text-anchor="middle" font-size="12" fill="#666" transform="rotate(-90 14 ${margin.top + h / 2})">${config.y_label}</text>` : '';

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="background:white;font-family:sans-serif">
    ${title}${xLabel}${yLabel}
    <g transform="translate(${margin.left},${margin.top})">${grid}${content}</g>
  </svg>`;
}

interface IResultTableProps {
  data: IAlloyResultData;
}

const ResultTableComponent: React.FC<IResultTableProps> = ({ data }) => {
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [chartConfig, setChartConfig] = useState<IChartConfig | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  const handleConfigureClick = async () => {
    const body = new ChartDialogBody(data.columns);
    const result = await showDialog({
      title: 'Configure Chart',
      body,
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })]
    });

    if (result.button.accept) {
      setChartConfig(body.getValue());
      setView('chart');
    }
  };

  const handleChartClick = () => {
    // Show default chart immediately (no dialog)
    setChartConfig(null);
    setView('chart');
  };

  useEffect(() => {
    if (view === 'chart' && chartRef.current) {
      const container = chartRef.current;
      if (chartConfig) {
        const svgWidth = Math.max(container.clientWidth || 700, 500);
        container.innerHTML = renderConfiguredChart(data, chartConfig, svgWidth, 400);
      } else {
        container.innerHTML = renderDefaultChartGrid(data);
      }
    }
  }, [view, chartConfig, data]);

  return (
    <div className="alloy-result-container">
      <div className="alloy-result-toolbar">
        <button
          className={`alloy-toolbar-btn ${view === 'table' ? 'active' : ''}`}
          onClick={() => setView('table')}
          title="Table view"
        >
          Table
        </button>
        <button
          className={`alloy-toolbar-btn ${view === 'chart' ? 'active' : ''}`}
          onClick={handleChartClick}
          title="Show chart"
        >
          Chart
        </button>
        {view === 'chart' && (
          <button
            className="alloy-toolbar-btn"
            onClick={handleConfigureClick}
            title="Configure Chart"
          >
            Configure Chart
          </button>
        )}
        <span className="alloy-result-info">
          ({data.total_rows} row{data.total_rows !== 1 ? 's' : ''} affected)
          {data.truncated ? ' showing first 1000' : ''}
        </span>
      </div>

      {view === 'table' && (
        <div className="alloy-table-wrapper">
          <table className="alloy-result-table">
            <thead>
              <tr>
                {data.columns.map(col => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i}>
                  {data.columns.map(col => (
                    <td key={col}>
                      {row[col] === null ? (
                        <span className="alloy-null">NULL</span>
                      ) : (
                        String(row[col])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'chart' && (
        <div className="alloy-chart-area" ref={chartRef} />
      )}
    </div>
  );
};

class AlloyResultRenderer extends ReactWidget implements IRenderMime.IRenderer {
  private _data: IAlloyResultData | null = null;
  private _mimeType: string;

  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this._mimeType = options.mimeType;
    this.addClass('alloy-result-widget');
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    this._data = model.data[this._mimeType] as any as IAlloyResultData;
    this.update();
  }

  render(): JSX.Element {
    if (!this._data) {
      return <div>No data</div>;
    }
    return <ResultTableComponent data={this._data} />;
  }
}

export const alloyRendererFactory: IRenderMime.IRendererFactory = {
  safe: true,
  mimeTypes: [ALLOY_MIME_TYPE],
  defaultRank: 50,
  createRenderer: (
    options: IRenderMime.IRendererOptions
  ): IRenderMime.IRenderer => {
    return new AlloyResultRenderer(options);
  }
};
