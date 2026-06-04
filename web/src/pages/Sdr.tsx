import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";
import { AdsbMap } from "../components/AdsbMap";

type SdrStatus = {
  ok: boolean;
  rtl_sdr_detected: boolean;
  tuner: string | null;
  device_count: number;
  usb_present: boolean;
  blacklist: { present: boolean; path: string };
  readsb: { active: boolean };
  rtl_433: { active: boolean; jsonl: string };
  lock: { holder: string | null };
  probe_raw: string | null;
};

type Aircraft = {
  icao: string;
  callsign: string | null;
  altitude_ft: number | null;
  speed_kt: number | null;
  heading: number | null;
  lat: number | null;
  lon: number | null;
  rssi: number | null;
  seen_s: number | null;
  squawk: string | null;
};

type AdsbResp =
  | { ok: true; now: number; count: number; aircraft: Aircraft[] }
  | { ok: false; reason: string; aircraft: Aircraft[] };

type Preset = { id: string; label: string; freq_mhz: number; mode: string; bw_khz: number };

type Rtl433Event = Record<string, unknown>;

type Tab = "adsb" | "rtl433" | "presets" | "device";

const TABS: { id: Tab; label: string }[] = [
  { id: "adsb", label: "ADS-B" },
  { id: "rtl433", label: "rtl_433" },
  { id: "presets", label: "Presets" },
  { id: "device", label: "Device" },
];

export function Sdr() {
  const [tab, setTab] = useState<Tab>("adsb");
  const [status, setStatus] = useState<SdrStatus | null>(null);
  const [adsb, setAdsb] = useState<AdsbResp | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [events, setEvents] = useState<Rtl433Event[]>([]);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGet<SdrStatus>("/api/sdr/status"));
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    apiGet<{ presets: Preset[] }>("/api/sdr/presets")
      .then((d) => setPresets(d.presets || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "adsb") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<AdsbResp>("/api/sdr/adsb/aircraft");
        if (alive) setAdsb(d);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "rtl433") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ events: Rtl433Event[] }>("/api/sdr/rtl433/events?n=100");
        if (alive) setEvents(d.events || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const readsbActive = !!status?.readsb?.active;
  const rtl433Active = !!status?.rtl_433?.active;
  const stateLabel = status == null
    ? "ACQUIRING"
    : !status.rtl_sdr_detected
      ? "NO SDR"
      : readsbActive ? "ADS-B" : rtl433Active ? "RTL_433" : "IDLE";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="04 SDR-SCN"
        title="SDR Scanner"
        state={stateLabel}
        icon="∿"
        right={
          <span className="hud-label text-txt-dim">
            {status?.tuner ?? "—"} · lock:{status?.lock?.holder ?? "—"}
          </span>
        }
      />

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="hud-btn"
            data-active={tab === t.id ? "true" : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="DEVICE" led={status?.rtl_sdr_detected ? "mint" : "pink"}>
          <BigValue
            value={status?.rtl_sdr_detected ? "PRESENT" : "ABSENT"}
            color={status?.rtl_sdr_detected ? "mint" : "pink"}
            size="md"
          />
          <div className="mt-2 text-txt-dim">count {status?.device_count ?? 0}</div>
        </Tile>
        <Tile title="TUNER">
          <BigValue value={status?.tuner ?? "—"} color="violet" size="md" />
        </Tile>
        <Tile title="LOCK HOLDER">
          <BigValue value={status?.lock?.holder ?? "—"} color="amber" size="md" />
        </Tile>
        <Tile title="ACTIVE">
          <div className="flex items-center gap-2">
            <StatusLED color={readsbActive ? "mint" : "dim"} />
            <span className="text-txt-body">readsb</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusLED color={rtl433Active ? "mint" : "dim"} />
            <span className="text-txt-body">rtl_433</span>
          </div>
        </Tile>
      </div>

      {tab === "adsb" && (
        <AdsbTab
          adsb={adsb}
          onStart={async () => {
            try { await apiPost("/api/sdr/adsb/start"); setNote("readsb start requested"); }
            catch (e) { setNote(`readsb start failed: ${e}`); }
            refresh();
          }}
          onStop={async () => {
            try { await apiPost("/api/sdr/adsb/stop"); setNote("readsb stop requested"); }
            catch (e) { setNote(`readsb stop failed: ${e}`); }
            refresh();
          }}
        />
      )}

      {tab === "rtl433" && (
        <Rtl433Tab
          running={rtl433Active}
          events={events}
          onStart={async () => {
            try { await apiPost("/api/sdr/rtl433/start"); setNote("rtl_433 started"); }
            catch (e) { setNote(`rtl_433 start failed: ${e}`); }
            refresh();
          }}
          onStop={async () => {
            try { await apiPost("/api/sdr/rtl433/stop"); setNote("rtl_433 stopped"); }
            catch (e) { setNote(`rtl_433 stop failed: ${e}`); }
            refresh();
          }}
        />
      )}

      {tab === "presets" && <PresetsTab presets={presets} />}
      {tab === "device" && <DeviceTab status={status} />}
    </div>
  );
}

function AdsbTab({
  adsb,
  onStart,
  onStop,
}: {
  adsb: AdsbResp | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const ok = adsb?.ok === true;
  const aircraft = adsb?.aircraft ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="hud-btn border-amber-base text-amber-base"
          onClick={onStart}
          disabled={ok}
        >
          ▶ START READSB
        </button>
        <button
          className="hud-btn border-pink-alert text-pink-alert"
          onClick={onStop}
          disabled={!ok}
        >
          ■ STOP READSB
        </button>
        <span className="ml-2 text-txt-dim">
          {ok
            ? `${adsb.count} aircraft — updated ${adsb.now ? new Date(adsb.now * 1000).toLocaleTimeString() : ""}`
            : adsb?.reason ?? "readsb inactive"}
        </span>
      </div>

      <AdsbMap aircraft={aircraft} active={ok} />

      <Tile title="AIRCRAFT" padded={false} led={ok ? "mint" : "amber"}>
        <div className="overflow-auto max-h-[560px]">
          <table className="w-full text-[0.8125rem]">
            <thead className="sticky top-0 bg-bg-tile">
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">ICAO</th>
                <th className="hud-label px-3 py-2 text-left">Callsign</th>
                <th className="hud-label px-3 py-2 text-right">Alt (ft)</th>
                <th className="hud-label px-3 py-2 text-right">kt</th>
                <th className="hud-label px-3 py-2 text-right">Hdg</th>
                <th className="hud-label px-3 py-2 text-left">Pos</th>
                <th className="hud-label px-3 py-2 text-right">Seen</th>
              </tr>
            </thead>
            <tbody>
              {!ok && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-txt-dim">
                    {adsb?.reason ?? "readsb inactive — click START READSB"}
                  </td>
                </tr>
              )}
              {ok && adsb.aircraft.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-txt-dim">
                    readsb active but no aircraft in range yet
                  </td>
                </tr>
              )}
              {ok && adsb.aircraft.slice(0, 100).map((a) => (
                <tr key={a.icao} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 tabular-nums text-violet-bright">{a.icao}</td>
                  <td className="px-3 py-1 text-amber-base">{a.callsign ?? "—"}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-txt-body">{a.altitude_ft ?? "—"}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-cyan-signal">{a.speed_kt ?? "—"}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-txt-body">{a.heading ?? "—"}</td>
                  <td className="px-3 py-1 text-txt-dim tabular-nums">
                    {a.lat != null && a.lon != null
                      ? `${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums text-txt-dim">
                    {a.seen_s != null ? `${a.seen_s}s` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}

function Rtl433Tab({
  running,
  events,
  onStart,
  onStop,
}: {
  running: boolean;
  events: Rtl433Event[];
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
          onClick={onStart}
          disabled={running}
        >
          ▶ START RTL_433
        </button>
        <button
          className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
          onClick={onStop}
          disabled={!running}
        >
          ■ STOP RTL_433
        </button>
        <span className="ml-2 text-txt-dim flex items-center gap-2">
          <StatusLED color={running ? "mint" : "dim"} />
          {running ? "decoding — waiting for ISM signals" : "idle"}
        </span>
      </div>

      <Tile title="DECODED EVENTS" padded={false} led={events.length > 0 ? "mint" : "amber"}>
        <div className="overflow-auto max-h-[560px] p-4 font-mono text-[0.75rem]">
          {events.length === 0 ? (
            <div className="text-txt-dim">
              {running ? "listening — no decoded events yet" : "no events captured yet — start rtl_433"}
            </div>
          ) : (
            events.slice().reverse().map((e, i) => (
              <div key={i} className="border-b border-line-dim/40 py-1">
                <span className="text-txt-dim">{String(e.time ?? "")}</span>{" "}
                <span className="text-violet-bright">{String(e.model ?? "?")}</span>{" "}
                <span className="text-txt-body">
                  {Object.entries(e)
                    .filter(([k]) => k !== "time" && k !== "model")
                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                    .join(" ")}
                </span>
              </div>
            ))
          )}
        </div>
      </Tile>
    </div>
  );
}

function PresetsTab({ presets }: { presets: Preset[] }) {
  return (
    <Tile title="SCANNER PRESETS" padded={false} led="violet">
      <div className="px-4 py-2 text-txt-dim text-[0.75rem] border-b border-line-dim">
        read-only this wave — preset tuning (rtl_fm streaming / audio) arrives in a future wave.
      </div>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">ID</th>
              <th className="hud-label px-3 py-2 text-left">Label</th>
              <th className="hud-label px-3 py-2 text-right">MHz</th>
              <th className="hud-label px-3 py-2 text-left">Mode</th>
              <th className="hud-label px-3 py-2 text-right">BW kHz</th>
              <th className="hud-label px-3 py-2 text-left">Tune</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((p) => (
              <tr key={p.id} className="border-b border-line-dim/40">
                <td className="px-3 py-1 text-txt-body">{p.id}</td>
                <td className="px-3 py-1 text-violet-bright">{p.label}</td>
                <td className="px-3 py-1 text-right tabular-nums text-amber-base">{p.freq_mhz}</td>
                <td className="px-3 py-1 text-cyan-signal">{p.mode}</td>
                <td className="px-3 py-1 text-right tabular-nums text-txt-body">{p.bw_khz}</td>
                <td className="px-3 py-1">
                  <button className="hud-btn opacity-40 cursor-not-allowed" disabled>
                    ▶ tune
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function DeviceTab({ status }: { status: SdrStatus | null }) {
  return (
    <div className="space-y-3">
      <Tile title="RTL-SDR DEVICE" led={status?.rtl_sdr_detected ? "mint" : "pink"}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <div className="hud-label text-txt-dim">USB present</div>
            <div className={status?.usb_present ? "text-mint-safe" : "text-pink-alert"}>
              {status?.usb_present ? "yes" : "no"}
            </div>
          </div>
          <div>
            <div className="hud-label text-txt-dim">Detected</div>
            <div className={status?.rtl_sdr_detected ? "text-mint-safe" : "text-pink-alert"}>
              {status?.rtl_sdr_detected ? "yes" : "no"}
            </div>
          </div>
          <div>
            <div className="hud-label text-txt-dim">Tuner</div>
            <div className="text-violet-bright">{status?.tuner ?? "—"}</div>
          </div>
          <div>
            <div className="hud-label text-txt-dim">Blacklist</div>
            <div className={status?.blacklist?.present ? "text-mint-safe" : "text-amber-base"}>
              {status?.blacklist?.present ? "rtl-sdr blacklisted from dvb" : "dvb may conflict"}
            </div>
          </div>
        </div>
      </Tile>

      <Tile title="rtl_test -t OUTPUT" padded={false} led="violet">
        <pre className="whitespace-pre-wrap px-4 py-3 text-txt-dim text-[0.75rem] font-mono overflow-auto max-h-80">
          {status?.probe_raw || "(no probe output)"}
        </pre>
      </Tile>

      <Tile title="SDR LOCK" led={status?.lock?.holder ? "amber" : "mint"}>
        <div className="flex items-center gap-2">
          <StatusLED color={status?.lock?.holder ? "amber" : "mint"} />
          <span className="text-txt-body">
            {status?.lock?.holder
              ? `claimed by ${status.lock.holder}`
              : "unlocked — either claimant may start"}
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            className="hud-btn"
            onClick={() => apiPost("/api/sdr/adsb/start").catch(() => {})}
          >
            claim for ADS-B
          </button>
          <button
            className="hud-btn"
            onClick={() => apiPost("/api/sdr/rtl433/start").catch(() => {})}
          >
            claim for rtl_433
          </button>
          <button
            className="hud-btn border-pink-alert text-pink-alert"
            onClick={() => apiPost("/api/sdr/lock/release").catch(() => {})}
          >
            force release
          </button>
        </div>
      </Tile>
    </div>
  );
}
