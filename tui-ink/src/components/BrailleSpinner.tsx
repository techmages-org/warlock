// ============================================================================
// BrailleSpinner — an animated braille "working" indicator (reusable).
//
// Frames come from `unicode-animations` (raw braille frame data); we drive the
// animation ourselves in an Ink <Text> via a setInterval inside useEffect with
// cleanup. The component must be rendered ONLY while a turn is in-flight — at
// idle it is unmounted, so there is no running timer and nothing re-renders
// (preserving the flicker-free, Static-only-at-rest architecture). NEVER place
// this inside <Static>.
//
// We deliberately did NOT use @graedenn/pi-loader: it peer-depends on
// @earendil-works/pi-tui (PI's own renderer), not Ink, so it does not integrate
// cleanly here. unicode-animations is renderer-agnostic frame data.
// ============================================================================

import { Text } from "ink";
import { useEffect, useState } from "react";
import { type BrailleSpinnerName, spinners } from "unicode-animations";
import { COLORS } from "../lib/theme.js";

export interface BrailleSpinnerProps {
  /** Animation name from unicode-animations (orbit/pulse/sparkle/braillewave/…). */
  name?: BrailleSpinnerName;
  color?: string;
  /** Override the frame interval (ms). Defaults to the animation's own pace, ~10fps floor. */
  intervalMs?: number;
}

export function BrailleSpinner({ name = "orbit", color = COLORS.cyan, intervalMs }: BrailleSpinnerProps) {
  const spinner = spinners[name] ?? spinners.braille;
  const frames = spinner.frames;
  const ms = Math.max(60, intervalMs ?? spinner.interval ?? 90);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, ms);
    return () => clearInterval(timer);
  }, [frames.length, ms]);

  return <Text color={color}>{frames[frame % frames.length]}</Text>;
}
