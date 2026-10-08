/**
 * ProfitChart.jsx
 *
 * A pure-SVG line chart for Sales / Supplier Cost / Gross Profit over time.
 * No external charting library required.
 */

import { useMemo, useState } from 'react';
import { formatCurrency } from '../../utils/formatCurrency.js';
import './ProfitChart.css';

const LINES = [
  { key: 'sales', label: 'Sales', color: '#0a7d4f' },
  { key: 'cost', label: 'Supplier Cost', color: '#c62828' },
  { key: 'profit', label: 'Gross Profit', color: '#1d4ed8' },
];

const W = 800;
const H = 260;
const PAD = { top: 16, right: 24, bottom: 48, left: 72 };

function fmtLabel(str) {
  // "2026-10-05" → "Oct 5"   "2026-10" → "Oct 26"
  const parts = str.split('-');
  if (parts.length === 3) {
    const d = new Date(str + 'T00:00:00');
    return d.toLocaleDateString('en-GH', { month: 'short', day: 'numeric' });
  }
  if (parts.length === 2) {
    const d = new Date(`${str}-01T00:00:00`);
    return d.toLocaleDateString('en-GH', { month: 'short', year: '2-digit' });
  }
  return str;
}

export default function ProfitChart({ series = [] }) {
  const [tooltip, setTooltip] = useState(null);

  const { points, maxVal, xTicks, yTicks } = useMemo(() => {
    if (!series.length) return { points: {}, maxVal: 0, xTicks: [], yTicks: [] };

    const allVals = series.flatMap((s) => [s.sales, s.cost, s.profit]);
    const max = Math.max(...allVals, 1);
    const roundedMax = Math.ceil(max / 10) * 10;

    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const xStep = series.length > 1 ? chartW / (series.length - 1) : 0;

    const mapX = (i) => PAD.left + (series.length === 1 ? chartW / 2 : i * xStep);
    const mapY = (v) => PAD.top + chartH - (v / roundedMax) * chartH;

    const pts = {};
    for (const line of LINES) {
      pts[line.key] = series.map((s, i) => ({ x: mapX(i), y: mapY(s[line.key]), v: s[line.key], label: s.label }));
    }

    // x-axis tick indices (max ~8 labels)
    const step = Math.max(1, Math.ceil(series.length / 8));
    const xTicks = series
      .map((s, i) => ({ i, label: fmtLabel(s.label), x: mapX(i) }))
      .filter((_, i) => i % step === 0 || i === series.length - 1);

    // y-axis ticks
    const yTickCount = 5;
    const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
      const v = (roundedMax * i) / yTickCount;
      return { v, y: mapY(v) };
    });

    return { points: pts, maxVal: roundedMax, xTicks, yTicks };
  }, [series]);

  if (!series.length) {
    return <p className="muted profit-empty">No data available for the selected period.</p>;
  }

  const buildPath = (pts) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const buildArea = (pts) => {
    const chartBottom = H - PAD.bottom;
    return `${buildPath(pts)} L${pts[pts.length - 1].x.toFixed(1)},${chartBottom} L${pts[0].x.toFixed(1)},${chartBottom} Z`;
  };

  return (
    <div className="profit-chart">
      {/* Legend */}
      <div className="profit-chart__legend">
        {LINES.map((line) => (
          <span key={line.key} className="profit-chart__legend-item">
            <span className="profit-chart__legend-dot" style={{ background: line.color }} />
            {line.label}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="profit-chart__svg"
        role="img"
        aria-label="Sales vs Supplier Cost vs Gross Profit over time"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Y grid lines */}
        {yTicks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} className="profit-chart__grid" />
            <text x={PAD.left - 6} y={t.y + 4} className="profit-chart__axis-label" textAnchor="end">
              {t.v >= 1000 ? `${(t.v / 1000).toFixed(1)}k` : t.v}
            </text>
          </g>
        ))}

        {/* X tick labels */}
        {xTicks.map((t) => (
          <text key={t.i} x={t.x} y={H - PAD.bottom + 16} className="profit-chart__axis-label" textAnchor="middle">
            {t.label}
          </text>
        ))}

        {/* Area fills (transparent) */}
        {LINES.map((line) => (
          <path
            key={`area-${line.key}`}
            d={buildArea(points[line.key])}
            fill={line.color}
            fillOpacity="0.06"
          />
        ))}

        {/* Lines */}
        {LINES.map((line) => (
          <path
            key={`line-${line.key}`}
            d={buildPath(points[line.key])}
            stroke={line.color}
            strokeWidth="2.5"
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Hit-area rectangles for tooltip */}
        {series.map((s, i) => {
          const x = points.sales[i]?.x ?? 0;
          const colW = W / Math.max(series.length, 1);
          return (
            <rect
              key={i}
              x={x - colW / 2}
              y={PAD.top}
              width={colW}
              height={H - PAD.top - PAD.bottom}
              fill="transparent"
              onMouseEnter={() =>
                setTooltip({
                  x,
                  y: Math.min(...LINES.map((l) => points[l.key][i]?.y ?? 999)),
                  label: fmtLabel(s.label),
                  sales: s.sales,
                  cost: s.cost,
                  profit: s.profit,
                  orders: s.orders,
                })
              }
            />
          );
        })}

        {/* Dot indicators on hover */}
        {tooltip &&
          LINES.map((line) => {
            const idx = series.findIndex((s) => fmtLabel(s.label) === tooltip.label);
            const pt = idx >= 0 ? points[line.key][idx] : null;
            return pt ? (
              <circle key={line.key} cx={pt.x} cy={pt.y} r={5} fill={line.color} stroke="#fff" strokeWidth="2" />
            ) : null;
          })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="profit-chart__tooltip"
          style={{
            left: `${((tooltip.x - PAD.left) / (W - PAD.left - PAD.right)) * 100}%`,
          }}
        >
          <strong>{tooltip.label}</strong>
          <span style={{ color: '#0a7d4f' }}>Sales: {formatCurrency(tooltip.sales)}</span>
          <span style={{ color: '#c62828' }}>Cost: {formatCurrency(tooltip.cost)}</span>
          <span style={{ color: '#1d4ed8' }}>Profit: {formatCurrency(tooltip.profit)}</span>
          <span className="muted">{tooltip.orders} orders</span>
        </div>
      )}
    </div>
  );
}
