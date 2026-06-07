import { useEffect, useState, useCallback } from "react";
import clsx from "clsx";
import { Tile, StatusLED } from "./hud";
import { apiGet, apiPost } from "../lib/api";

type AudioDevice = {
  id: number;
  name: string;
  default: boolean;
  volume: number | null;
  muted: boolean;
};
type AudioStatus = {
  ok: boolean;
  sinks: AudioDevice[];
  sources: AudioDevice[];
};

export function AudioSettings() {
  const [data, setData] = useState<AudioStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiGet<AudioStatus>("/api/audio/devices");
      setData(r);
      setErr(null);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const setDefault = async (id: number) => {
    setBusy(`default-${id}`);
    try {
      await apiPost("/api/audio/default", { id });
      await refresh();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const setVolume = async (id: number, volume: number) => {
    try {
      await apiPost("/api/audio/volume", { id, volume });
      // optimistic update
      setData((d) =>
        d
          ? {
              ...d,
              sinks: d.sinks.map((s) => (s.id === id ? { ...s, volume } : s)),
              sources: d.sources.map((s) => (s.id === id ? { ...s, volume } : s)),
            }
          : d
      );
    } catch (e: any) {
      setErr(String(e));
    }
  };

  const setMute = async (id: number, muted: boolean) => {
    setBusy(`mute-${id}`);
    try {
      await apiPost("/api/audio/mute", { id, muted });
      await refresh();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const playTest = async (id?: number) => {
    setBusy(`test-${id ?? "default"}`);
    try {
      await apiPost("/api/audio/test", { id: id ?? null });
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setTimeout(() => setBusy(null), 800);
    }
  };

  if (!data) {
    return (
      <Tile title="AUDIO" led={err ? "pink" : "violet"}>
        {err ? <span className="text-pink-alert">{err}</span> : "loading…"}
      </Tile>
    );
  }

  const Row = ({ d, kind }: { d: AudioDevice; kind: "sink" | "source" }) => (
    <div
      className={clsx(
        "px-3 py-2 border-l-2 flex items-center gap-3 text-[11px]",
        d.default ? "border-amber-base bg-amber-base/[0.04]" : "border-line-dim hover:border-violet-base/60"
      )}
    >
      <button
        onClick={() => !d.default && setDefault(d.id)}
        disabled={d.default || busy === `default-${d.id}`}
        className={clsx(
          "w-12 shrink-0 px-1 py-0.5 border text-[10px] uppercase tracking-wider",
          d.default
            ? "border-amber-base text-amber-bright"
            : "border-line-mid text-txt-dim hover:text-violet-bright hover:border-violet-base"
        )}
        title={d.default ? "current default" : "set as default"}
      >
        {d.default ? "● ACTIVE" : "set"}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-txt-hi truncate">{d.name}</div>
        <div className="text-txt-dim">id={d.id}</div>
      </div>
      {d.volume !== null && (
        <div className="flex items-center gap-2 w-44 shrink-0">
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            value={d.volume}
            onChange={(e) => setVolume(d.id, parseFloat(e.target.value))}
            className="flex-1 accent-violet-base"
          />
          <span className="w-9 text-right text-txt-body tabular-nums">
            {Math.round(d.volume * 100)}%
          </span>
        </div>
      )}
      <button
        onClick={() => setMute(d.id, !d.muted)}
        className={clsx(
          "w-9 shrink-0 px-1 py-0.5 border text-[10px] uppercase",
          d.muted
            ? "border-pink-alert text-pink-alert"
            : "border-line-mid text-txt-dim hover:text-amber-bright hover:border-amber-base"
        )}
        title={d.muted ? "muted (click to unmute)" : "click to mute"}
      >
        {d.muted ? "MUT" : "ON"}
      </button>
      {kind === "sink" && (
        <button
          onClick={() => playTest(d.id)}
          disabled={busy === `test-${d.id}`}
          className="w-12 shrink-0 px-1 py-0.5 border border-line-mid text-[10px] uppercase text-txt-dim hover:text-amber-bright hover:border-amber-base"
          title="play test tone"
        >
          {busy === `test-${d.id}` ? "…" : "TEST"}
        </button>
      )}
    </div>
  );

  return (
    <Tile title="AUDIO" led="violet" headerRight={<span className="text-txt-dim">{data.sinks.length}↓ / {data.sources.length}↑</span>}>
      <div className="space-y-3">
        <div>
          <div className="text-txt-dim text-[10px] uppercase tracking-wider mb-1 flex items-center gap-2">
            <StatusLED color="amber" /> output (sinks)
          </div>
          <div className="space-y-px">
            {data.sinks.length === 0 && <div className="text-txt-dim text-[11px]">no sinks</div>}
            {data.sinks.map((d) => <Row key={`sink-${d.id}`} d={d} kind="sink" />)}
          </div>
        </div>
        <div>
          <div className="text-txt-dim text-[10px] uppercase tracking-wider mb-1 flex items-center gap-2">
            <StatusLED color="cyan" /> input (sources)
          </div>
          <div className="space-y-px">
            {data.sources.length === 0 && <div className="text-txt-dim text-[11px]">no sources</div>}
            {data.sources.map((d) => <Row key={`src-${d.id}`} d={d} kind="source" />)}
          </div>
        </div>
        {err && <div className="text-pink-alert text-[11px]">err: {err}</div>}
      </div>
    </Tile>
  );
}
