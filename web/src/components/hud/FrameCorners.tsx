// Thin amber L-brackets in each corner of the parent rect. Absolute-positioned
// and pointer-events:none, so the parent's own layout is untouched.

export function FrameCorners({
  color = "var(--amber-base)",
  length = 12,
  thickness = 1,
}: {
  color?: string;
  length?: number;
  thickness?: number;
}) {
  // Each corner is two strokes (horizontal + vertical segment of `length`).
  // We draw with SVG so the lines remain crisp at any size.
  const L = length;
  const T = thickness;
  const shared = {
    stroke: color,
    strokeWidth: T,
    strokeLinecap: "square" as const,
    shapeRendering: "crispEdges" as const,
  };
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
      preserveAspectRatio="none"
    >
      {/* top-left */}
      <line x1={0} y1={0} x2={L} y2={0} {...shared} />
      <line x1={0} y1={0} x2={0} y2={L} {...shared} />
      {/* top-right */}
      <line x1={`calc(100% - ${L}px)`} y1={0} x2="100%" y2={0} {...shared} />
      <line x1="100%" y1={0} x2="100%" y2={L} {...shared} />
      {/* bottom-left */}
      <line x1={0} y1="100%" x2={L} y2="100%" {...shared} />
      <line x1={0} y1={`calc(100% - ${L}px)`} x2={0} y2="100%" {...shared} />
      {/* bottom-right */}
      <line x1={`calc(100% - ${L}px)`} y1="100%" x2="100%" y2="100%" {...shared} />
      <line x1="100%" y1={`calc(100% - ${L}px)`} x2="100%" y2="100%" {...shared} />
    </svg>
  );
}
