// Tiny inline SVG sparkline used inside tile headers for trend indication.
// Deliberately thin-line — no fill — so it reads as instrument trace.

export function MiniSparkline({
  data,
  width = 60,
  height = 16,
  color = "var(--violet-base)",
  strokeWidth = 1,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}) {
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--line-dim)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 1;
  const step = (width - pad * 2) / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} aria-hidden="true" className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
