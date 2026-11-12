/* LMU Telemetry - app classifiche
 * Dati: viste Supabase v_pb (giri migliori), v_pb_archive, v_laps, tabella lap_traces (telemetria),
 * funzione reset_leaderboards (con PIN). Solo lettura con chiave publishable, tranne il reset.
 * Se il database non è ancora aggiornato (002_telemetria_reset.sql) usa le viste di prima, senza telemetria.
 * Pagine: #giri/<chiave> lista giri, #confronto/<chiave>[/<chiave>] telemetria, #reset,
 * #cancella/<id giro> cancella un tempo (con il PIN del reset).
 * Demo: ?demo=1 oppure pulsante, con dati generati da demo.js.
 */
(function () {
  "use strict";

  const cfg = window.LMU_CONFIG;
  const $app = document.getElementById("app");
  const $status = document.getElementById("status");
  const $updated = document.getElementById("updated");
  const $refresh = document.getElementById("refresh");

  // Categorie mostrate nel selettore (id usato anche come classe CSS per il colore)
  const CLASSES = ["HY", "P2", "P2E", "P3", "GT3", "GT3E"];
  const CLASS_LABEL = { HY: "Hypercar", P2: "LMP2", P2E: "LMP2 ELMS", P3: "LMP3", GT3: "LMGT3", GT3E: "LMGT3 ELMS", GTE: "LMGTE", OTHER: "Altro" };
  // Il gioco scrive le classi come "Hyper", "LMP2_ELMS", "GT3"...: le riconduce a un id fisso
  function clsId(raw) {
    const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const elms = s.includes("ELMS");
    if (s.includes("HYPER") || s === "LMH" || s === "LMDH") return "HY";
    if (s.includes("LMP2") || s === "P2") return elms ? "P2E" : "P2";
    if (s.includes("LMP3") || s === "P3") return "P3";
    if (s.includes("GT3")) return elms ? "GT3E" : "GT3";
    if (s.includes("GTE")) return "GTE";
    return "OTHER";
  }
  const clsLabel = (id) => CLASS_LABEL[id] || id;
  const clsBadge = (id) => `<span class="badge cls ${id}">${esc(clsLabel(id))}</span>`;
  const SESSION_IT = { practice: "Prove", qualify: "Qualifica", race: "Gara", warmup: "Warm-up", testday: "Test" };
  const GRIP_IT = ["Verde", "Bassa", "Media", "Alta", "Satura"];

  const params = new URLSearchParams(location.search);
  const saved = (() => { try { return JSON.parse(localStorage.getItem("lmu-ui") || "{}"); } catch { return {}; } })();

  const state = {
    mode: params.has("demo") ? "demo" : "live",
    tab: saved.tab || "board",
    trackId: saved.trackId ?? null,
    cls: CLASS_LABEL[saved.cls] ? saved.cls : "all",
    perDriver: saved.perDriver ?? true,
    selKey: null,
    data: null,
    raw: null,           // dati grezzi dell'ultimo caricamento (per aggiungere i giri nuovi)
    moves: new Map(),    // chiave riga -> { gain, at }: posizioni guadagnate di recente
    seenAt: new Map(),   // id giro -> quando l'app l'ha visto arrivare
    history: new Map(),
    laps: new Map(),     // tutti i giri per chiave pilota|pista|auto
    traces: new Map(),   // telemetria decodificata per chiave
    view: null,          // { type: "giri" | "confronto" | "reset", key, ref }
    era: null,           // id del reset da cui vedere l'archivio (null = classifica attuale)
    validOnly: false,
    openLap: null,
  };

  function persist() {
    try {
      localStorage.setItem("lmu-ui", JSON.stringify({ tab: state.tab, trackId: state.trackId, cls: state.cls, perDriver: state.perDriver }));
    } catch { /* non importa */ }
  }

  // ---------------------------------------------------------------- utilità
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  function fmtLap(t) {
    if (t == null || !isFinite(t)) return "--:--.---";
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, "0")}`;
  }
  function fmtSec(t) {
    if (t == null || !isFinite(t)) return "--.---";
    return t >= 60 ? fmtLap(t) : t.toFixed(3);
  }
  function fmtGap(d) {
    if (d == null || !isFinite(d)) return "";
    if (Math.abs(d) < 0.0005) return "—";
    return (d > 0 ? "+" : "−") + Math.abs(d).toFixed(3);
  }
  function ago(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return "ora";
    if (d < 3600) return `${Math.floor(d / 60)} min fa`;
    if (d < 86400) return `${Math.floor(d / 3600)} h fa`;
    if (d < 86400 * 2) return "ieri";
    if (d < 86400 * 30) return `${Math.floor(d / 86400)} gg fa`;
    return new Date(iso).toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
  }
  const km = (m) => (m ? (m / 1000).toLocaleString("it-IT", { maximumFractionDigits: 3 }) + " km" : "");
  const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");

  // ---------------------------------------------------------------- dati
  async function api(path) {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: cfg.publishableKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function rpc(fn, body) {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: cfg.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const comboKey = (x) => `${x.driver_id}|${x.track_id}|${x.car_id}`;
  const enc = encodeURIComponent;

  // Stessa logica delle viste SQL, per la demo
  function aggregate(laps) {
    const groups = new Map();
    for (const l of laps) {
      if (!l.valid) continue;
      const k = `${l.driver_id}|${l.track_id}|${l.car_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    const pb = [];
    const best = [];
    for (const list of groups.values()) {
      const b = list.reduce((a, x) => (x.lap_time < a.lap_time || (x.lap_time === a.lap_time && x.driven_at < a.driven_at) ? x : a));
      const s = [0, 1, 2].map((i) => Math.min(...list.map((x) => x["s" + (i + 1)])));
      pb.push({
        ...b,
        best_lap: b.lap_time, best_s1: s[0], best_s2: s[1], best_s3: s[2],
        theoretical: Math.round((s[0] + s[1] + s[2]) * 1000) / 1000,
        valid_laps: list.length, last_driven: list.reduce((a, x) => (x.driven_at > a ? x.driven_at : a), ""),
        lap_id: b.id, has_trace: true, era_id: 0, is_current: true,
      });
    }
    const recent = [...laps].sort((a, b) => (a.driven_at < b.driven_at ? 1 : -1)).slice(0, 400);
    return { pb, recent, resets: [], legacy: false };
  }

  const Live = {
    async overview() {
      const recentP = api("v_laps?select=*&order=driven_at.desc&limit=400");
      try {
        const [pb, resets] = await Promise.all([
          state.era ? api(`v_pb_archive?select=*&archived_by=eq.${state.era}`) : api("v_pb?select=*&is_current=is.true"),
          api("resets?select=*&order=id.desc"),
        ]);
        return { pb, recent: await recentP, resets, legacy: false };
      } catch (e) {
        if (state.era) throw e;
        // database non ancora aggiornato: viste di prima, niente telemetria / archivio / reset
        const [pb, best] = await Promise.all([api("v_personal_best?select=*"), api("v_best_laps?select=*")]);
        const bm = new Map(best.map((b) => [comboKey(b), b]));
        const merged = pb.map((p) => {
          const b = bm.get(comboKey(p)) || {};
          return { ...b, ...p, lap_id: b.id, has_trace: false, era_id: 0 };
        });
        return { pb: merged, recent: await recentP, resets: [], legacy: true };
      }
    },
    history(r) {
      return api(`v_laps?select=lap_time,driven_at,valid&driver_id=eq.${r.driver_id}&track_id=eq.${r.track_id}&car_id=eq.${r.car_id}&valid=is.true&order=driven_at.asc&limit=1000`);
    },
    laps(r) {
      const era = state.data.legacy ? "" : `&era_id=eq.${r.era}`;
      return api(`v_laps?select=*&driver_id=eq.${r.driver_id}&track_id=eq.${r.track_id}&car_id=eq.${r.car_id}${era}&order=driven_at.desc&limit=5000`);
    },
    async trace(r) {
      const rows = await api(`lap_traces?select=lap_id,step_m,points,data&lap_id=eq.${r.lapId}`);
      if (!rows.length) throw new Error("telemetria mancante");
      return window.LMU_COMPARE.decode(rows[0]);
    },
    reset(body) {
      return rpc("reset_leaderboards", body);
    },
    deleteLap(body) {
      return rpc("delete_lap", body);
    },
  };

  let demoLaps = null;
  const Demo = {
    async overview() {
      demoLaps = demoLaps || window.LMU_DEMO.generate();
      return aggregate(demoLaps);
    },
    async history(r) {
      return demoLaps
        .filter((l) => l.valid && l.driver_id === r.driver_id && l.track_id === r.track_id && l.car_id === r.car_id)
        .sort((a, b) => (a.driven_at < b.driven_at ? -1 : 1));
    },
    async laps(r) {
      return demoLaps
        .filter((l) => l.driver_id === r.driver_id && l.track_id === r.track_id && l.car_id === r.car_id)
        .sort((a, b) => (a.driven_at < b.driven_at ? 1 : -1));
    },
    async trace(r) {
      return window.LMU_DEMO.trace({ track_id: r.track_id, driver_id: r.driver_id, car_id: r.car_id, length_m: r.lap.length, best: r.best });
    },
    async reset() {
      return { ok: false, error: "demo" };
    },
    async deleteLap() {
      return { ok: false, error: "demo" };
    },
  };
  const source = () => (state.mode === "demo" ? Demo : Live);

  function build({ pb, recent, resets, legacy }) {
    const rows = pb.map((p) => {
      const key = comboKey(p);
      const lap = p;
      return {
        key,
        driver_id: p.driver_id, nick: p.nick,
        track_id: p.track_id, track: p.track_display,
        car_id: p.car_id, car: p.car, cls: clsId(p.car_class), rawCls: p.car_class,
        best: num(p.best_lap),
        pbS: [num(p.best_s1), num(p.best_s2), num(p.best_s3)],
        theo: num(p.theoretical),
        laps: p.valid_laps, last: p.last_driven,
        era: p.era_id ?? 0, lapId: p.lap_id, hasTrace: !!p.has_trace,
        lap: {
          s: [num(lap.s1), num(lap.s2), num(lap.s3)],
          fuel: num(lap.fuel_start), ve: num(lap.ve_start), tyre: lap.tyre_front,
          trackTemp: num(lap.track_temp), airTemp: num(lap.air_temp), grip: lap.grip_level,
          session: lap.session_type, online: lap.online, version: lap.game_version,
          when: lap.driven_at, length: num(lap.length_m),
        },
      };
    });

    const tracks = new Map();
    for (const r of rows) {
      if (!tracks.has(r.track_id)) tracks.set(r.track_id, { id: r.track_id, name: r.track, length: r.lap.length, rows: [], last: "" });
      const t = tracks.get(r.track_id);
      t.rows.push(r);
      if (r.last > t.last) t.last = r.last;
      if (!t.length && r.lap.length) t.length = r.lap.length;
    }
    const trackList = [...tracks.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
    const maxLen = Math.max(...trackList.map((t) => t.length || 0), 1);
    return { rows, tracks: trackList, maxLen, recent, resets: resets || [], legacy: !!legacy, byKey: new Map(rows.map((r) => [r.key, r])) };
  }

  // ---------------------------------------------------------------- live
  // Ogni pochi secondi chiede solo i giri con id più alto dell'ultimo visto: se non c'è niente
  // di nuovo la risposta è "[]". Quando arriva un giro scarica solo i record toccati da quel giro.
  const LIVE_POLL_MS = 4000;
  const FULL_RELOAD_MS = 5 * 60000;   // ricarica completa di sicurezza (telemetrie, ban, reset)
  const ON_TRACK_MS = 6 * 60000;      // "in pista" se ha chiuso un giro negli ultimi 6 minuti
  const MOVE_SHOW_MS = 3 * 60000;     // per quanto restano le frecce delle posizioni
  const FLASH_MS = 8000;              // evidenziazione della riga appena migliorata
  let lastFull = 0;
  let polling = false;

  async function pollLive() {
    if (polling || state.mode !== "live" || state.era || state.view || !state.raw || state.raw.legacy) return;
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastFull > FULL_RELOAD_MS) return load(true);
    polling = true;
    try {
      const raw = state.raw;
      const lastId = raw.recent.reduce((m, l) => Math.max(m, l.id || 0), 0);
      const fresh = await api(`v_laps?select=*&id=gt.${lastId}&order=id.asc&limit=200`);
      if (!fresh.length || state.raw !== raw || state.era || state.view) return;
      const now = Date.now();
      for (const l of fresh) state.seenAt.set(l.id, now);
      const combos = [...new Map(fresh.filter((l) => l.valid).map((l) => [comboKey(l), l])).values()];
      if (combos.length) {
        const or = combos.map((l) => `and(driver_id.eq.${l.driver_id},track_id.eq.${l.track_id},car_id.eq.${l.car_id})`).join(",");
        const pbs = await api(`v_pb?select=*&is_current=is.true&or=(${or})`);
        const byKey = new Map(raw.pb.map((p) => [comboKey(p), p]));
        for (const p of pbs) byKey.set(comboKey(p), p);
        raw.pb = [...byKey.values()];
      }
      raw.recent = [...fresh.reverse(), ...raw.recent].slice(0, 400);
      applyData(raw, true);
    } catch {
      /* rete assente: riprova al giro successivo */
    } finally {
      polling = false;
    }
  }

  // Confronta la classifica di prima con quella nuova, con i filtri che sta usando chi guarda
  function markMoves(prev, next) {
    const now = Date.now();
    const id = (r) => (state.perDriver ? r.driver_id : r.key);
    for (const t of next.tracks) {
      const old = prev.tracks.find((x) => x.id === t.id);
      if (!old) continue;
      const before = new Map(boardRows(old).map((r, i) => [id(r), { pos: i, best: r.best }]));
      boardRows(t).forEach((r, i) => {
        const b = before.get(id(r));
        if (!b) state.moves.set(r.key, { gain: null, at: now });
        else if (r.best < b.best - 0.0005) state.moves.set(r.key, { gain: b.pos - i, at: now });
      });
    }
    for (const [k, m] of state.moves) if (now - m.at > MOVE_SHOW_MS) state.moves.delete(k);
  }

  // Pilota -> ultimo giro, per chi ha girato negli ultimi minuti
  function onTrackNow() {
    const res = new Map();
    if (state.mode !== "live" || state.era || !state.data) return res;
    const now = Date.now();
    for (const l of state.data.recent) {
      if (res.has(l.driver_id)) continue;
      let at = new Date(l.driven_at).getTime();
      if (at > now + 60000) at = 0; // orologio del PC avanti: non ci si fida
      at = Math.max(at, state.seenAt.get(l.id) || 0);
      if (now - at < ON_TRACK_MS) res.set(l.driver_id, l);
    }
    return res;
  }

  // ---------------------------------------------------------------- posizioni guadagnate/perse
  // Il browser ricorda il giro migliore di ogni pilota/auto visto all'ultima visita. All'inizio di
  // una visita nuova (dopo VISIT_GAP_MS senza aprire l'app) quella foto diventa il riferimento:
  // la classifica di allora si ricalcola con gli stessi filtri e si confrontano le posizioni.
  const VISIT_GAP_MS = 30 * 60000;
  const POS_KEY = "lmu-pos";

  function readPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch { return null; }
  }
  function writePos(v) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(v)); } catch { /* non importa */ }
  }
  const bestsOf = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.best]));

  function updateBaseline(raw) {
    state.base = null;
    if (state.era) return;
    if (state.mode === "demo") {
      // la demo finge che l'ultima visita sia stata prima dell'ultimo quarto dei giri
      const dates = demoLaps.map((l) => l.driven_at).sort();
      const cut = dates[Math.floor(dates.length * 0.75)];
      const old = build(aggregate(demoLaps.filter((l) => l.driven_at < cut)));
      state.base = { at: Date.parse(cut), best: bestsOf(old.rows) };
      return;
    }
    const resetId = raw.resets?.[0]?.id ?? 0;
    const now = Date.now();
    let s = readPos();
    if (!s || s.reset !== resetId) s = { reset: resetId };      // dopo un reset si riparte da zero
    if (s.seen && now - s.seen.at > VISIT_GAP_MS) s.base = s.seen; // visita nuova
    s.seen = { at: now, best: bestsOf(state.data.rows) };
    writePos(s);
    state.base = s.base || null;
  }

  // Posizione di ogni riga (pilota o pilota+auto, come la classifica) nella classifica di allora
  function basePositions(track) {
    const base = state.base.best;
    let rows = track.rows
      .filter((r) => (state.cls === "all" || r.cls === state.cls) && base[r.key] != null)
      .map((r) => ({ id: state.perDriver ? r.driver_id : r.key, best: base[r.key] }));
    if (state.perDriver) {
      const by = new Map();
      for (const r of rows) if (!by.has(r.id) || r.best < by.get(r.id).best) by.set(r.id, r);
      rows = [...by.values()];
    }
    rows.sort((a, b) => a.best - b.best);
    return new Map(rows.map((r, i) => [r.id, i]));
  }

  function moveHtml(r, pos, before) {
    if (!before) return "";
    const when = new Date(state.base.at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    const was = before.get(state.perDriver ? r.driver_id : r.key);
    if (was == null) return `<span class="move new" title="Nuovo in classifica rispetto alla tua visita del ${when}">NEW</span>`;
    const d = was - pos;
    if (!d) return "";
    const n = Math.abs(d);
    return d > 0
      ? `<span class="move up" title="${n} posizion${n === 1 ? "e guadagnata" : "i guadagnate"} rispetto alla tua visita del ${when}">▲${n}</span>`
      : `<span class="move down" title="${n} posizion${n === 1 ? "e persa" : "i perse"} rispetto alla tua visita del ${when}">▼${n}</span>`;
  }

  // ---------------------------------------------------------------- classifica
  function boardRows(track) {
    let rows = track.rows.filter((r) => state.cls === "all" || r.cls === state.cls);
    if (state.perDriver) {
      const byDriver = new Map();
      for (const r of rows) {
        const cur = byDriver.get(r.driver_id);
        if (!cur || r.best < cur.best) byDriver.set(r.driver_id, r);
      }
      rows = [...byDriver.values()];
    }
    return rows.sort((a, b) => a.best - b.best);
  }

  function renderBoard() {
    const d = state.data;
    if (!d.tracks.length) return renderEmpty();

    let track = d.tracks.find((t) => t.id === state.trackId) || d.tracks[0];
    state.trackId = track.id;
    const rows = boardRows(track);
    if (!rows.find((r) => r.key === state.selKey)) state.selKey = rows[0]?.key ?? null;

    const leader = rows[0];
    const bestSec = [0, 1, 2].map((i) => Math.min(...rows.map((r) => r.pbS[i] ?? Infinity)));
    const groupIdeal = bestSec.every(isFinite) ? bestSec.reduce((a, b) => a + b, 0) : null;
    const totalLaps = rows.reduce((a, r) => a + (r.laps || 0), 0);
    const classesHere = new Set(track.rows.map((r) => r.cls));
    // Le 6 categorie fisse, più eventuali altre (es. LMGTE) solo se presenti nei dati
    const extra = [...new Set(d.rows.map((r) => r.cls))].filter((c) => !CLASSES.includes(c));
    const live = onTrackNow();
    const liveHere = [...live.values()].filter((l) => l.track_id === track.id);

    const trackCards = d.tracks.map((t) => {
      const tr = t.rows.filter((r) => state.cls === "all" || r.cls === state.cls);
      const rec = tr.reduce((a, r) => (!a || r.best < a.best ? r : a), null);
      const drivers = new Set(t.rows.map((r) => r.driver_id)).size;
      const nOn = [...live.values()].filter((l) => l.track_id === t.id).length;
      return `
        <button class="track-card ${t.id === track.id ? "active" : ""}" data-track="${esc(t.id)}">
          <div class="t-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="len-bar"><i style="width:${Math.round(((t.length || 0) / d.maxLen) * 100)}%"></i></div>
          <div class="t-meta"><span>${km(t.length)}</span>${nOn ? `<span class="on-track">${nOn} in pista</span>` : `<span>${drivers} pilot${drivers === 1 ? "a" : "i"}</span>`}</div>
          <div class="t-meta"><span class="t-rec">${rec ? fmtLap(rec.best) : "—"}</span><span>${rec ? esc(rec.nick) : ""}</span></div>
        </button>`;
    }).join("");

    const clsButtons = [["all", "Tutte"], ...[...CLASSES, ...extra].map((c) => [c, clsLabel(c)])]
      .map(([v, label]) => `<button data-cls="${v}" class="${state.cls === v ? "active" : ""}" ${v !== "all" && !classesHere.has(v) ? "disabled title='Nessun tempo su questa pista'" : ""}>${v !== "all" ? `<span class="dot ${v}"></span>` : ""}${esc(label)}</button>`)
      .join("");

    // Il viola va sul settore più veloce tra quelli mostrati (giri migliori): il miglior settore
    // assoluto (bestSec) può venire da un altro giro e allora non comparirebbe mai in tabella.
    const shownBest = [0, 1, 2].map((i) => Math.min(...rows.map((r) => r.lap.s[i] ?? Infinity)));
    const before = state.base ? basePositions(track) : null;
    const body = rows.map((r, i) => {
      const gap = i === 0 ? null : r.best - leader.best;
      const secs = r.lap.s.map((s, si) => {
        let c = "";
        if (s != null && Math.abs(s - shownBest[si]) < 0.0005) c = "purple";
        else if (s != null && r.pbS[si] != null && Math.abs(s - r.pbS[si]) < 0.0005) c = "green";
        return `<td class="r col-sec"><span class="sec ${c}">${fmtSec(s)}</span></td>`;
      }).join("");
      const mv = state.moves.get(r.key);
      const flash = mv && Date.now() - mv.at < FLASH_MS ? "flash" : "";
      const onT = live.get(r.driver_id);
      const dot = onT && onT.track_id === r.track_id ? `<span class="live-dot" title="In pista ora · ${esc(onT.car)}"></span>` : "";
      return `
        <tr data-key="${esc(r.key)}" class="${r.key === state.selKey ? "sel" : ""} ${flash}">
          <td class="pos ${i < 3 ? "p" + (i + 1) : ""}">${i + 1}</td>
          <td><div class="driver"><span class="cls-bar ${esc(r.cls)}"></span><div style="min-width:0">
            <div class="nick">${esc(r.nick)}${moveHtml(r, i, before)}${dot}</div><div class="car">${esc(r.car)}</div></div></div></td>
          <td class="r"><span class="time">${fmtLap(r.best)}</span></td>
          <td class="r"><span class="gap">${i === 0 ? "" : fmtGap(gap)}</span></td>
          ${secs}
          <td class="r col-ideal"><span class="ideal">${fmtLap(r.theo)}</span></td>
          <td class="r col-laps"><span class="gap">${r.laps}</span></td>
          <td class="r col-when"><span class="gap">${ago(r.last)}</span></td>
        </tr>`;
    }).join("");

    // la pagina si ridisegna da sola quando arriva un giro: non perdere lo scorrimento delle piste
    const prevScroll = $app.querySelector(".tracks")?.scrollLeft || 0;
    $app.innerHTML = `
      <div class="section-label">Piste</div>
      <div class="tracks">${trackCards}</div>

      <div class="filters">
        <div class="seg" id="cls">${clsButtons}</div>
        <label class="switch"><input type="checkbox" id="perDriver" ${state.perDriver ? "checked" : ""}>Solo la miglior auto di ogni pilota</label>
        ${eraSelectHtml()}
      </div>

      <section class="hero">
        <div>
          <div class="section-label" style="margin:0 0 4px">${state.era ? `<span class="badge arch">ARCHIVIO</span> ` : ""}${state.cls === "all" ? "Tutte le classi" : esc(clsLabel(state.cls))}</div>
          <h1>${esc(track.name)}</h1>
          <div class="h-sub">${km(track.length)} · ${rows.length} in classifica · ${totalLaps} giri validi</div>
          ${liveHere.length ? `<div class="h-live"><span class="live-dot"></span>In pista ora: ${liveHere.map((l) => esc(l.nick)).join(", ")}</div>` : ""}
        </div>
        <div class="stat"><div class="k">Record</div><div class="v">${leader ? fmtLap(leader.best) : "—"}</div><div class="d">${leader ? esc(leader.nick) + " · " + esc(leader.car) : ""}</div></div>
        <div class="stat"><div class="k">Ideale del gruppo</div><div class="v purple">${fmtLap(groupIdeal)}</div><div class="d">migliori settori di tutti</div></div>
        <div class="stat"><div class="k">Ultima attività</div><div class="v" style="font-size:18px">${track.last ? ago(track.last) : "—"}</div><div class="d">${track.last ? new Date(track.last).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" }) : ""}</div></div>
      </section>

      <div class="grid">
        <div class="panel">
          <div class="panel-head"><h2>Classifica</h2><span class="hint"><span class="sec purple">viola</span> = settore migliore · <span class="sec green">verde</span> = record personale${state.base ? ` · <span class="move up">▲</span><span class="move down" style="margin-left:2px">▼</span> = posizioni dalla tua visita precedente` : ""}</span></div>
          ${rows.length ? `
          <div style="overflow-x:auto">
          <table class="board">
            <thead><tr>
              <th>#</th><th>Pilota</th><th class="r">Tempo</th><th class="r">Distacco</th>
              <th class="r col-sec">S1</th><th class="r col-sec">S2</th><th class="r col-sec">S3</th>
              <th class="r col-ideal">Ideale</th><th class="r col-laps">Giri</th><th class="r col-when">Quando</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table></div>` : `<div class="empty" style="padding:40px">Nessun tempo in questa classe.</div>`}
        </div>
        <div class="panel" id="detail">${renderDetailHtml(rows, leader)}</div>
      </div>`;

    const $tracks = $app.querySelector(".tracks");
    if ($tracks) $tracks.scrollLeft = prevScroll;
    bindBoard(rows, leader);
    loadHistory();
  }

  function renderDetailHtml(rows, leader) {
    const r = rows.find((x) => x.key === state.selKey);
    if (!r) return `<div class="empty" style="padding:40px">Seleziona un pilota</div>`;
    const isLeader = r === leader;
    const deltas = r.lap.s.map((s, i) => (s != null && leader.lap.s[i] != null ? s - leader.lap.s[i] : null));
    const maxAbs = Math.max(0.25, ...deltas.filter((x) => x != null).map(Math.abs));
    const potential = r.best != null && r.theo != null ? r.best - r.theo : null;

    const sectorRows = deltas.map((d, i) => {
      const w = d == null ? 0 : Math.min(50, (Math.abs(d) / maxAbs) * 50);
      const cls = d == null ? "" : Math.abs(d) < 0.0005 ? "zero" : d > 0 ? "slow" : "fast";
      return `
        <div class="sector-row">
          <span class="s-n">S${i + 1}</span>
          <div class="delta-track">${cls === "slow" || cls === "fast" ? `<i class="${cls}" style="width:${w}%"></i>` : ""}</div>
          <span class="delta-val ${cls}">${isLeader ? fmtSec(r.lap.s[i]) : d == null ? "—" : fmtGap(d)}</span>
        </div>`;
    }).join("");

    const fuelMax = 100;
    const lap = r.lap;
    const chips = [
      lap.tyre && `<span class="chip">Gomme <b>${esc(lap.tyre)}</b></span>`,
      lap.trackTemp != null && `<span class="chip">Pista <b>${Math.round(lap.trackTemp)}°C</b></span>`,
      lap.airTemp != null && `<span class="chip">Aria <b>${Math.round(lap.airTemp)}°C</b></span>`,
      lap.grip != null && `<span class="chip">Grip <b>${GRIP_IT[lap.grip] ?? lap.grip}</b></span>`,
      lap.session && `<span class="chip">${esc(SESSION_IT[lap.session] || lap.session)}${lap.online ? " · online" : ""}</span>`,
      lap.when && `<span class="chip">${new Date(lap.when).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}</span>`,
    ].filter(Boolean).join("");

    return `
      <div class="panel-head"><h2>Dettaglio</h2>${clsBadge(r.cls)}</div>
      <div class="detail">
        <div class="d-head">
          <div><div class="nick">${esc(r.nick)}</div><div class="car">${esc(r.car)}</div></div>
          <div class="d-time"><span class="time">${fmtLap(r.best)}</span><span class="gap">${isLeader ? "Record della pista" : fmtGap(r.best - leader.best) + " dal primo"}</span></div>
        </div>
        ${detailActionsHtml(r)}

        <div>
          <div class="sub-label"><span>${isLeader ? "Settori del giro record" : "Settori rispetto al primo"}</span><span>${isLeader ? "" : esc(leader.nick)}</span></div>
          ${sectorRows}
        </div>

        <div class="ideal-box">
          <div class="mini"><div class="k">Giro ideale</div><div class="v accent">${fmtLap(r.theo)}</div></div>
          <div class="mini"><div class="k">Potenziale</div><div class="v">${potential == null ? "—" : potential < 0.0005 ? "0.000" : "−" + potential.toFixed(3)}</div></div>
        </div>

        <div class="fuel">
          <div class="sub-label"><span>Al momento del giro migliore</span></div>
          <div class="gauge-row"><span>Benzina</span><div class="gauge"><i style="width:${lap.fuel == null ? 0 : Math.min(100, (lap.fuel / fuelMax) * 100)}%"></i></div><b>${lap.fuel == null ? "—" : lap.fuel.toFixed(1) + " L"}</b></div>
          ${lap.ve ? `<div class="gauge-row"><span>Energia</span><div class="gauge ve"><i style="width:${Math.min(100, lap.ve * 100)}%"></i></div><b>${pct(lap.ve)}</b></div>` : ""}
          <div class="chips" style="margin-top:6px">${chips}</div>
        </div>

        <div>
          <div class="sub-label"><span>Progressi</span><span id="histInfo"></span></div>
          <div id="chart"><div class="loading" style="padding:30px"><div class="spinner"></div></div></div>
        </div>
      </div>`;
  }

  async function loadHistory() {
    const r = state.data.byKey.get(state.selKey);
    const $chart = document.getElementById("chart");
    if (!r || !$chart) return;
    let laps = state.history.get(r.key);
    if (!laps) {
      try {
        laps = await source().history(r);
        state.history.set(r.key, laps);
      } catch {
        $chart.innerHTML = `<div class="hint" style="color:var(--faint)">Storico non disponibile</div>`;
        return;
      }
    }
    if (state.selKey !== r.key) return; // nel frattempo è stato selezionato un altro
    $chart.innerHTML = chartSvg(laps.map((l) => ({ t: num(l.lap_time), at: new Date(l.driven_at).getTime() })));
    const info = document.getElementById("histInfo");
    if (info) info.textContent = `${laps.length} giri validi`;
  }

  function chartSvg(points) {
    if (points.length < 2) return `<div class="hint" style="color:var(--faint);font-size:13px">Servono almeno 2 giri per il grafico</div>`;
    const W = 340, H = 150, L = 46, R = 8, T = 10, B = 22;
    const ts = points.map((p) => p.t);
    const minT = Math.min(...ts);
    const p90 = [...ts].sort((a, b) => a - b)[Math.floor(ts.length * 0.9)] || Math.max(...ts);
    const maxT = Math.max(minT + 0.5, p90);
    const x0 = points[0].at, x1 = points[points.length - 1].at;
    const sx = (at) => L + ((at - x0) / Math.max(1, x1 - x0)) * (W - L - R);
    const sy = (t) => T + ((Math.min(t, maxT) - minT) / (maxT - minT)) * (H - T - B);

    let pb = Infinity;
    const step = [];
    for (const p of points) {
      if (p.t < pb) {
        if (step.length) step.push([sx(p.at), sy(pb)]);
        pb = p.t;
        step.push([sx(p.at), sy(pb)]);
      }
    }
    step.push([sx(x1), sy(pb)]);
    const path = step.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = path + ` L ${sx(x1).toFixed(1)} ${H - B} L ${step[0][0].toFixed(1)} ${H - B} Z`;
    const dots = points.map((p) => `<circle class="dot-lap" cx="${sx(p.at).toFixed(1)}" cy="${sy(p.t).toFixed(1)}" r="2" opacity="${p.t > maxT ? 0.25 : 0.55}"/>`).join("");
    const pbDots = step.slice(0, -1).filter((_, i) => i % 2 === 0 || i === 0).map((p) => `<circle class="pb-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"/>`).join("");
    const d = (at) => new Date(at).toLocaleDateString("it-IT", { day: "2-digit", month: "short" });

    return `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento dei tempi">
        <defs><linearGradient id="pbGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd100" stop-opacity="0.22"/><stop offset="1" stop-color="#ffd100" stop-opacity="0"/></linearGradient></defs>
        <line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
        <text class="lbl" x="${L - 6}" y="${T + 4}" text-anchor="end">${fmtLap(minT)}</text>
        <text class="lbl" x="${L - 6}" y="${H - B}" text-anchor="end">${fmtLap(maxT)}</text>
        <text class="lbl" x="${L}" y="${H - 6}">${d(x0)}</text>
        <text class="lbl" x="${W - R}" y="${H - 6}" text-anchor="end">${d(x1)}</text>
        <path class="area" d="${area}"/>
        ${dots}
        <path class="pb-line" d="${path}"/>
        ${pbDots}
      </svg>`;
  }

  function bindBoard(rows, leader) {
    $app.querySelectorAll("[data-track]").forEach((b) =>
      b.addEventListener("click", () => {
        state.trackId = isNaN(+b.dataset.track) ? b.dataset.track : +b.dataset.track;
        state.selKey = null;
        persist();
        render();
      })
    );
    $app.querySelectorAll("[data-cls]").forEach((b) =>
      b.addEventListener("click", () => { state.cls = b.dataset.cls; state.selKey = null; persist(); render(); })
    );
    const pd = document.getElementById("perDriver");
    if (pd) pd.addEventListener("change", () => { state.perDriver = pd.checked; persist(); render(); });
    const era = document.getElementById("era");
    if (era) era.addEventListener("change", () => {
      state.era = era.value ? +era.value : null;
      state.selKey = null;
      state.moves.clear();
      clearCaches();
      load();
    });
    $app.querySelectorAll("tr[data-key]").forEach((tr) =>
      tr.addEventListener("click", () => {
        state.selKey = tr.dataset.key;
        $app.querySelectorAll("tr[data-key]").forEach((x) => x.classList.toggle("sel", x === tr));
        document.getElementById("detail").innerHTML = renderDetailHtml(rows, leader);
        loadHistory();
        if (window.innerWidth <= 1100) document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
  }

  // ---------------------------------------------------------------- ultimi giri
  function renderFeed() {
    const d = state.data;
    if (!d.recent.length) return renderEmpty();
    // Record personali e record della pista (per classe) per i badge
    const pbBest = new Map(d.rows.map((r) => [r.key, r.best]));
    const trackRec = new Map();
    for (const r of d.rows) {
      const k = `${r.track_id}|${r.cls}`;
      if (!trackRec.has(k) || r.best < trackRec.get(k)) trackRec.set(k, r.best);
    }
    // Raggruppa i giri in sessioni: stesso pilota/pista/auto e pause sotto i 30 minuti
    const sessions = [];
    for (const l of d.recent) {
      const key = `${l.driver_id}|${l.track_id}|${l.car_id}`;
      const at = new Date(l.driven_at).getTime();
      const s = sessions.find((x) => x.key === key && (x.uid ? x.uid === l.session_uid : Math.abs(x.first - at) < 30 * 60000));
      if (s) {
        s.laps.push(l);
        s.first = Math.min(s.first, at);
      } else {
        sessions.push({ key, uid: l.session_uid, first: at, last: at, lap: l, laps: [l] });
      }
    }
    const items = sessions.map((s) => {
      const l = s.lap;
      const valid = s.laps.filter((x) => x.valid);
      const best = valid.length ? Math.min(...valid.map((x) => num(x.lap_time))) : null;
      const isPb = best != null && Math.abs(best - (pbBest.get(s.key) ?? -1)) < 0.0005;
      const isRec = best != null && Math.abs(best - (trackRec.get(`${l.track_id}|${clsId(l.car_class)}`) ?? -1)) < 0.0005;
      return `
        <li>
          <span class="when">${ago(new Date(s.last).toISOString())}</span>
          <div class="what">
            <div class="l1">${esc(l.nick)} ${clsBadge(clsId(l.car_class))}
              ${isRec ? `<span class="badge rec">RECORD</span>` : isPb ? `<span class="badge pb">PERSONALE</span>` : ""}
              ${l.session_type ? `<span class="badge">${esc(SESSION_IT[l.session_type] || l.session_type)}</span>` : ""}</div>
            <div class="l2">${esc(l.track_display || l.track)} · ${esc(l.car)} · ${s.laps.length} giri, ${valid.length} validi</div>
          </div>
          <div style="text-align:right">
            <span class="time ${best == null ? "invalid" : ""}">${fmtLap(best)}</span>
            <div class="gap" style="font-size:11px">miglior giro</div>
          </div>
        </li>`;
    }).join("");
    $app.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Ultime sessioni</h2><span class="hint">${sessions.length} sessioni dagli ultimi ${d.recent.length} giri</span></div>
        <ul class="feed">${items}</ul>
      </div>`;
  }

  // ---------------------------------------------------------------- piloti
  function renderDrivers() {
    const d = state.data;
    if (!d.rows.length) return renderEmpty();
    const drivers = new Map();
    for (const r of d.rows) {
      if (!drivers.has(r.driver_id)) drivers.set(r.driver_id, { nick: r.nick, rows: [], laps: 0, last: "" });
      const x = drivers.get(r.driver_id);
      x.rows.push(r);
      x.laps += r.laps || 0;
      if (r.last > x.last) x.last = r.last;
    }
    // Record di pista per classe vinti
    const rec = new Map();
    for (const r of d.rows) {
      const k = `${r.track_id}|${r.cls}`;
      if (!rec.has(k) || r.best < rec.get(k).best) rec.set(k, r);
    }
    const recCount = new Map();
    for (const r of rec.values()) recCount.set(r.driver_id, (recCount.get(r.driver_id) || 0) + 1);

    const cards = [...drivers.entries()]
      .sort((a, b) => (recCount.get(b[0]) || 0) - (recCount.get(a[0]) || 0) || b[1].laps - a[1].laps)
      .map(([id, x]) => {
        const tracks = new Set(x.rows.map((r) => r.track_id)).size;
        const carCount = new Map();
        x.rows.forEach((r) => carCount.set(r.car, (carCount.get(r.car) || 0) + (r.laps || 0)));
        const fav = [...carCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
        return `
          <div class="dcard">
            <div class="top">
              <div class="avatar">${esc(x.nick.slice(0, 1).toUpperCase())}</div>
              <div style="min-width:0"><div class="name">${esc(x.nick)}</div><div class="meta">attivo ${ago(x.last)} · ${esc(fav)}</div></div>
            </div>
            <div class="dstats">
              <div class="mini"><div class="k">Record</div><div class="v" style="color:var(--purple)">${recCount.get(id) || 0}</div></div>
              <div class="mini"><div class="k">Piste</div><div class="v">${tracks}</div></div>
              <div class="mini"><div class="k">Giri</div><div class="v">${x.laps}</div></div>
            </div>
          </div>`;
      }).join("");
    $app.innerHTML = `<div class="section-label">Piloti del gruppo · ordinati per record di pista (per classe)</div><div class="drivers">${cards}</div>`;
  }

  // ---------------------------------------------------------------- pagine (#giri, #confronto, #reset)
  function parseHash() {
    const [type, a, b] = decodeURIComponent(location.hash.slice(1)).split("/");
    state.view = ["giri", "confronto", "reset", "cancella"].includes(type) ? { type, key: a || null, ref: b || null } : null;
    state.openLap = null;
  }
  function goHome() {
    history.pushState(null, "", location.pathname + location.search);
    state.view = null;
    render();
  }
  function clearCaches() {
    state.history.clear();
    state.laps.clear();
    state.traces.clear();
  }

  function eraSelectHtml() {
    const d = state.data;
    if (!d.resets.length) return "";
    const opts = d.resets.map((x) => {
      const when = new Date(x.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
      return `<option value="${x.id}" ${state.era === x.id ? "selected" : ""}>Archivio: prima di «${esc(x.label)}» · ${esc(x.car_class ? clsLabel(clsId(x.car_class)) : "tutte le classi")} · ${when}</option>`;
    }).join("");
    return `<label class="era"><span>Classifica</span><select id="era"><option value="">Attuale</option>${opts}</select></label>`;
  }

  function detailActionsHtml(r) {
    const d = state.data;
    if (d.legacy) return "";
    const peers = d.rows.filter((x) => x.track_id === r.track_id && x.hasTrace && x.key !== r.key);
    const lapsBtn = state.era ? "" : `<a class="btn ghost sm" href="#giri/${enc(r.key)}">Tutti i giri</a>`;
    let tel;
    if (!r.hasTrace) tel = `<span class="d-note">Telemetria: arriva con il prossimo record personale</span>`;
    else if (!peers.length) tel = `<span class="d-note">Telemetria pronta: manca un altro pilota con cui confrontarla</span>`;
    else tel = `<a class="btn sm" href="#confronto/${enc(r.key)}">Confronta telemetria</a>`;
    const del = state.mode === "live" && r.lapId != null ? `<a class="btn ghost sm del" href="#cancella/${enc(r.lapId)}">Cancella tempo</a>` : "";
    return `<div class="d-actions">${lapsBtn}${tel}${del}</div>`;
  }

  function viewHead(title, sub) {
    return `<div class="view-head"><a class="back" href="#">← Classifiche</a>
      <div><h1>${title}</h1>${sub ? `<div class="h-sub">${sub}</div>` : ""}</div></div>`;
  }
  function renderMissing() {
    $app.innerHTML = viewHead("Non trovato") + `<div class="empty" style="padding:40px"><p>Questo pilota non è più nella classifica che stai guardando.</p></div>`;
  }

  // Serata = data locale con cambio giorno alle 6 del mattino (come la pulizia nel database)
  const eveningOf = (iso) => new Date(new Date(iso).getTime() - 6 * 3600000).toLocaleDateString("sv-SE");
  const eveningLabel = (day) => new Date(day + "T12:00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });

  async function renderLaps() {
    const r = state.data.byKey.get(state.view.key);
    if (!r) return renderMissing();
    const head = viewHead(`${esc(r.nick)} · tutti i giri`, `${esc(r.track)} · ${esc(r.car)} ${clsBadge(r.cls)}`);
    let laps = state.laps.get(r.key);
    if (!laps) {
      $app.innerHTML = head + `<div class="loading"><div class="spinner"></div>Carico i giri…</div>`;
      try {
        laps = (await source().laps(r)).map((l) => ({ ...l, lap_time: num(l.lap_time), s1: num(l.s1), s2: num(l.s2), s3: num(l.s3) }));
        state.laps.set(r.key, laps);
      } catch {
        $app.innerHTML = head + `<div class="empty" style="padding:40px"><p>Giri non disponibili. Controlla la connessione e riprova.</p></div>`;
        return;
      }
      if (state.view?.type !== "giri" || state.view.key !== r.key) return;
    }

    const shown = state.validOnly ? laps.filter((l) => l.valid) : laps;
    const evenings = new Map();
    for (const l of shown) {
      const k = eveningOf(l.driven_at);
      if (!evenings.has(k)) evenings.set(k, []);
      evenings.get(k).push(l);
    }
    const valid = laps.filter((l) => l.valid);
    const avg = valid.length ? valid.reduce((a, l) => a + l.lap_time, 0) / valid.length : null;
    const wears = laps.map(wearAvg).filter((w) => w != null);
    const wearMean = wears.length ? wears.reduce((a, w) => a + w, 0) / wears.length : null;

    const groups = [...evenings.entries()].map(([day, list]) => {
      list.sort((a, b) => (a.driven_at < b.driven_at ? -1 : 1));
      const clean = list.filter((l) => l.valid && !l.pit_lap);
      const bestSec = [1, 2, 3].map((i) => Math.min(...clean.map((l) => l["s" + i] ?? Infinity)));
      const bestEv = clean.length ? Math.min(...clean.map((l) => l.lap_time)) : null;
      const rowsHtml = list.map((l) => {
        const isPb = l.id === r.lapId;
        const tc = isPb ? "purple" : l.valid && bestEv != null && Math.abs(l.lap_time - bestEv) < 0.0005 ? "green" : "";
        const secs = [1, 2, 3].map((i) => {
          const v = l["s" + i];
          const g = l.valid && !l.pit_lap && v != null && Math.abs(v - bestSec[i - 1]) < 0.0005;
          return `<td class="r col-sec"><span class="sec ${g ? "green" : ""}">${fmtSec(v)}</span></td>`;
        }).join("");
        const used = l.fuel_start != null && l.fuel_end != null ? Math.max(0, l.fuel_start - l.fuel_end) : null;
        const wear = wearAvg(l);
        const tags = (l.pit_lap ? `<span class="badge">BOX</span>` : "") + (!l.valid && !l.pit_lap ? `<span class="badge bad">NON VALIDO</span>` : "") + (isPb ? `<span class="badge rec">MIGLIORE</span>` : "");
        const open = state.openLap === l.id;
        const del = l.valid && state.mode === "live" ? `<a class="btn ghost sm del" href="#cancella/${enc(l.id)}">Cancella questo giro</a>` : "";
        const extra = open ? `<tr class="lap-ex"><td colspan="9"><div class="chips">${lapChips(l)}${del}</div></td></tr>` : "";
        return `<tr class="lap-row ${l.valid ? "" : "inv"} ${open ? "open" : ""}" data-lap="${esc(l.id)}">
            <td><span class="lap-n">${l.lap_no ?? "—"}</span>${tags}</td>
            <td class="r"><span class="time ${tc}">${fmtLap(l.lap_time)}</span></td>
            <td class="r"><span class="gap">${l.valid ? (isPb ? "" : fmtGap(l.lap_time - r.best)) : ""}</span></td>
            ${secs}
            <td class="r col-tyre"><span class="gap">${esc(l.tyre_front || "—")}</span></td>
            <td class="r col-fuel"><span class="gap">${used == null ? "—" : used.toFixed(1) + " L"}</span></td>
            <td class="r col-wear"><span class="gap">${wear == null ? "—" : fmtWear(wear)}</span></td>
          </tr>${extra}`;
      }).join("");
      return `<div class="panel ev">
          <div class="panel-head"><h2>${esc(eveningLabel(day))}</h2><span class="hint">${list.length} giri · migliore ${fmtLap(bestEv)}</span></div>
          <div style="overflow-x:auto"><table class="board laps">
            <thead><tr><th>Giro</th><th class="r">Tempo</th><th class="r">Distacco</th><th class="r col-sec">S1</th><th class="r col-sec">S2</th><th class="r col-sec">S3</th><th class="r col-tyre">Gomme</th><th class="r col-fuel">Benzina</th><th class="r col-wear" title="Gomma consumata nel giro, media delle 4 gomme">Usura</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table></div></div>`;
    }).join("");

    const exported = new Date().toLocaleString("it-IT", { dateStyle: "long", timeStyle: "short" });
    $app.innerHTML = head + `
      <div class="print-only print-head">LMU Telemetry · esportato il ${esc(exported)}${state.validOnly ? " · solo giri validi" : ""}
        · viola = giro migliore, verde = migliore della serata, barrato = non valido</div>
      <div class="lap-stats">
        <div class="mini"><div class="k">Giro migliore</div><div class="v" style="color:var(--purple)">${fmtLap(r.best)}</div></div>
        <div class="mini"><div class="k">Giri</div><div class="v">${laps.length}</div></div>
        <div class="mini"><div class="k">Media validi</div><div class="v">${fmtLap(avg)}</div></div>
        ${wearMean != null ? `<div class="mini"><div class="k">Usura media al giro</div><div class="v">${fmtWear(wearMean)}</div></div>` : ""}
        <div class="mini"><div class="k">Serate</div><div class="v">${new Set(laps.map((l) => eveningOf(l.driven_at))).size}</div></div>
      </div>
      <div class="filters">
        <label class="switch"><input type="checkbox" id="validOnly" ${state.validOnly ? "checked" : ""}>Solo giri validi</label>
        <span class="hint"><span class="sec purple">viola</span> giro migliore · <span class="sec green">verde</span> migliore della serata · tocca un giro per i dettagli</span>
        <button class="btn ghost sm" id="lapsPdf">Esporta PDF</button>
      </div>
      ${groups || `<div class="empty" style="padding:40px"><p>Nessun giro da mostrare.</p></div>`}
      <p class="foot-note">I giri si azzerano il giorno 1 di ogni mese; il giro migliore resta per sempre.</p>`;

    document.getElementById("validOnly").addEventListener("change", (e) => { state.validOnly = e.target.checked; renderLaps(); });
    // PDF: la finestra di stampa del browser ("Salva come PDF"), con un foglio di stile chiaro (@media print).
    // Il titolo della pagina diventa il nome proposto per il file.
    document.getElementById("lapsPdf").addEventListener("click", () => {
      const title = document.title;
      const day = new Date().toLocaleDateString("sv-SE");
      document.title = `LMU giri - ${r.nick} - ${r.track} - ${r.car} - ${day}`.replace(/[\\/:*?"<>|]/g, "");
      const restore = () => { document.title = title; window.removeEventListener("afterprint", restore); };
      window.addEventListener("afterprint", restore);
      window.print();
      setTimeout(restore, 1000); // alcuni browser non mandano afterprint
    });
    $app.querySelectorAll("tr.lap-row").forEach((tr) => tr.addEventListener("click", () => {
      const id = isNaN(+tr.dataset.lap) ? tr.dataset.lap : +tr.dataset.lap;
      state.openLap = state.openLap === id ? null : id;
      renderLaps();
    }));
  }

  // Usura gomme del giro: array di 4 percentuali (ant. sx, ant. dx, post. sx, post. dx)
  function wearList(l) {
    const w = Array.isArray(l.tyre_wear) ? l.tyre_wear.map(num) : null;
    return w && w.length === 4 && w.every((x) => x != null && isFinite(x)) ? w : null;
  }
  function wearAvg(l) {
    const w = wearList(l);
    return w ? (w[0] + w[1] + w[2] + w[3]) / 4 : null;
  }
  const fmtWear = (x) => (x < 1 ? x.toFixed(2) : x.toFixed(1)) + "%";

  function lapChips(l) {
    const used = (a, b, f) => (a != null && b != null ? f(a, b) : null);
    const w = wearList(l);
    return [
      `<span class="chip">${esc(SESSION_IT[l.session_type] || l.session_type || "")}${l.online ? " · online" : ""}</span>`,
      `<span class="chip">Ora <b>${new Date(l.driven_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</b></span>`,
      l.tyre_front && `<span class="chip">Gomme <b>${esc(l.tyre_front)}${l.tyre_rear && l.tyre_rear !== l.tyre_front ? " / " + esc(l.tyre_rear) : ""}</b></span>`,
      l.fuel_start != null && `<span class="chip">Benzina <b>${num(l.fuel_start).toFixed(1)} → ${l.fuel_end != null ? num(l.fuel_end).toFixed(1) : "—"} L</b></span>`,
      l.ve_start ? `<span class="chip">Energia <b>${pct(num(l.ve_start))} → ${pct(num(l.ve_end))}</b>${used(l.ve_start, l.ve_end, (a, b) => ` (−${((a - b) * 100).toFixed(1)}%)`) || ""}</span>` : "",
      w && `<span class="chip">Usura gomme <b>AS ${fmtWear(w[0])} · AD ${fmtWear(w[1])} · PS ${fmtWear(w[2])} · PD ${fmtWear(w[3])}</b></span>`,
      l.stint_lap != null && `<span class="chip">Giro stint <b>${l.stint_lap}</b></span>`,
      (l.tc != null || l.abs != null) && `<span class="chip">TC <b>${l.tc ?? "—"}</b> ABS <b>${l.abs ?? "—"}</b></span>`,
      l.track_temp != null && `<span class="chip">Pista <b>${Math.round(l.track_temp)}°C</b> Aria <b>${l.air_temp != null ? Math.round(l.air_temp) : "—"}°C</b></span>`,
      l.grip_level != null && `<span class="chip">Grip <b>${GRIP_IT[l.grip_level] ?? l.grip_level}</b></span>`,
    ].filter(Boolean).join("");
  }

  async function getTrace(r) {
    if (state.traces.has(r.key)) return state.traces.get(r.key);
    const t = await source().trace(r);
    state.traces.set(r.key, t);
    return t;
  }

  async function renderCompare() {
    const v = state.view;
    const d = state.data;
    const r = d.byKey.get(v.key);
    if (!r) return renderMissing();
    const peers = d.rows.filter((x) => x.track_id === r.track_id && x.hasTrace && x.key !== r.key).sort((a, b) => a.best - b.best);
    const classRec = Math.min(...d.rows.filter((x) => x.track_id === r.track_id && x.cls === r.cls).map((x) => x.best));
    const ref = (v.ref && d.byKey.get(v.ref)) || peers.find((x) => x.cls === r.cls) || peers[0];
    const head = viewHead(`Telemetria · ${esc(r.nick)}${ref ? " vs " + esc(ref.nick) : ""}`, `${esc(r.track)} · ${esc(r.car)}${ref && ref.car !== r.car ? " / " + esc(ref.car) : ""}`);
    if (!r.hasTrace || !ref) {
      $app.innerHTML = head + `<div class="empty" style="padding:40px"><p>${!r.hasTrace ? "Per questo giro migliore non c'è la telemetria: arriva con il prossimo record personale fatto con il tracker aggiornato." : "Nessun altro pilota ha la telemetria su questa pista."}</p></div>`;
      return;
    }
    $app.innerHTML = head + `<div id="cmp"><div class="loading"><div class="spinner"></div>Carico la telemetria…</div></div>`;
    let A, B;
    try {
      [A, B] = await Promise.all([getTrace(r), getTrace(ref)]);
    } catch (e) {
      const unsupported = typeof DecompressionStream === "undefined";
      document.getElementById("cmp").innerHTML = `<div class="empty" style="padding:40px"><p>${unsupported ? "Questo browser è troppo vecchio per leggere la telemetria: aggiorna Chrome o Safari." : "Telemetria non disponibile. Controlla la connessione e riprova."}</p></div>`;
      return;
    }
    if (state.view !== v) return;
    window.LMU_COMPARE.render(document.getElementById("cmp"),
      { trace: A, nick: r.nick, lap: r.best },
      { trace: B, nick: ref.nick, lap: ref.best },
      {
        refKey: ref.key,
        refIsRecord: Math.abs(ref.best - classRec) < 0.0005 && ref.cls === r.cls,
        others: peers.map((p) => ({ key: p.key, label: `${p.nick} · ${p.car} · ${fmtLap(p.best)}` })),
        onPickOther: (k) => { location.hash = `#confronto/${enc(r.key)}/${enc(k)}`; },
      });
  }

  function renderReset() {
    const d = state.data;
    const head = viewHead("Reset classifiche", "Quando un aggiornamento di LMU cambia la fisica o il BoP");
    if (state.mode === "demo" || d.legacy) {
      $app.innerHTML = head + `<div class="empty" style="padding:40px"><p>${state.mode === "demo" ? "Non disponibile nella demo." : "Prima va eseguito l'aggiornamento del database (002_telemetria_reset.sql)."}</p></div>`;
      return;
    }
    // Il reset lavora sul nome di classe del gioco (es. "Hyper"), mostrato col nome leggibile
    const classes = [...new Set(d.rows.map((r) => r.rawCls))].filter(Boolean).sort();
    $app.innerHTML = head + `
      <div class="panel reset">
        <div class="reset-body" id="rsBody">
          <p>Le classifiche scelte ripartono da zero. I record di adesso <b>non vengono cancellati</b>: restano consultabili dal menu <b>Classifica → Archivio</b>.</p>
          <label>Cosa azzerare<select id="rsClass"><option value="">Tutte le classi</option>${classes.map((c) => `<option value="${esc(c)}">Solo ${esc(clsLabel(clsId(c)))}</option>`).join("")}</select></label>
          <label>Nome del reset<input id="rsLabel" maxlength="60" placeholder="Patch 1.3" autocomplete="off"></label>
          <label>PIN<input id="rsPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off"></label>
          <div class="rs-msg" id="rsMsg"></div>
          <div class="rs-actions"><button class="btn" id="rsCheck">Continua</button></div>
        </div>
      </div>`;
    const $msg = document.getElementById("rsMsg");
    const say = (t, bad = true) => { $msg.textContent = t; $msg.className = "rs-msg " + (bad ? "bad" : "good"); };
    const errText = (res) => {
      if (res.error === "wrong_pin") return `PIN sbagliato. Tentativi rimasti: ${res.remaining}.`;
      if (res.error === "locked") return `Troppi tentativi sbagliati: reset bloccato fino alle ${new Date(res.until).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`;
      if (res.error === "no_pin") return "PIN non ancora impostato: impostalo dal SQL Editor con set_reset_pin.";
      if (res.error === "class") return "Classe non trovata.";
      return "Errore: riprova.";
    };
    const btn = document.getElementById("rsCheck");
    btn.addEventListener("click", async () => {
      const body = {
        p_pin: document.getElementById("rsPin").value.trim(),
        p_class: document.getElementById("rsClass").value || null,
        p_label: document.getElementById("rsLabel").value.trim() || null,
        p_confirm: false,
      };
      if (!/^[0-9]{6,12}$/.test(body.p_pin)) return say("Il PIN è di 6-12 cifre.");
      btn.disabled = true;
      say("Controllo il PIN…", false);
      let res;
      try { res = await source().reset(body); } catch { btn.disabled = false; return say("Server non raggiungibile."); }
      btn.disabled = false;
      if (!res.ok) return say(errText(res));
      const scope = body.p_class ? `della classe ${body.p_class}` : "di tutte le classi";
      document.getElementById("rsBody").innerHTML = `
        <div class="rs-confirm">
          <h2>Confermi il reset?</h2>
          <p>Verranno archiviati <b>${res.records}</b> giri migliori ${esc(scope)}${body.p_label ? ` con il nome «${esc(body.p_label)}»` : ""}. Da adesso le classifiche ${esc(scope)} ripartono da zero.</p>
          <div class="rs-msg" id="rsMsg2"></div>
          <div class="rs-actions"><button class="btn danger" id="rsGo">Sì, resetta</button><a class="btn ghost" href="#">Annulla</a></div>
        </div>`;
      const go = document.getElementById("rsGo");
      go.addEventListener("click", async () => {
        go.disabled = true;
        const $m2 = document.getElementById("rsMsg2");
        let done;
        try { done = await source().reset({ ...body, p_confirm: true }); } catch { go.disabled = false; $m2.textContent = "Server non raggiungibile."; $m2.className = "rs-msg bad"; return; }
        if (!done.ok) { go.disabled = false; $m2.textContent = errText(done); $m2.className = "rs-msg bad"; return; }
        document.getElementById("rsBody").innerHTML = `<div class="rs-confirm"><h2>Reset fatto</h2>
          <p>Le classifiche ${esc(scope)} ripartono da zero. I ${done.records} record di prima sono nell'archivio.</p>
          <div class="rs-actions"><a class="btn" href="#">Vai alle classifiche</a></div></div>`;
        clearCaches();
        state.era = null;
        state.reloadOnHome = true; // i dati si ricaricano tornando alle classifiche
      });
    });
  }

  // Cancella un giro preciso: il server lo segna "non valido"; se era il migliore sale il migliore rimasto
  function pinErrText(res) {
    if (res.error === "wrong_pin") return `PIN sbagliato. Tentativi rimasti: ${res.remaining}.`;
    if (res.error === "locked") return `Troppi tentativi sbagliati: bloccato fino alle ${new Date(res.until).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`;
    if (res.error === "no_pin") return "PIN non ancora impostato: impostalo dal SQL Editor con set_reset_pin.";
    if (res.error === "missing") return "Giro non trovato (forse è già stato cancellato).";
    if (res.error === "not_valid") return "Questo giro è già non valido: non è in classifica.";
    if (res.error === "demo") return "Non disponibile nella demo.";
    return "Errore: riprova.";
  }

  function renderDelete() {
    const lapId = Number(state.view.key);
    const head = viewHead("Cancella tempo", "Per togliere un tempo sbagliato dalla classifica");
    if (state.mode === "demo" || state.data.legacy || !Number.isFinite(lapId)) {
      $app.innerHTML = head + `<div class="empty" style="padding:40px"><p>${state.mode === "demo" ? "Non disponibile nella demo." : "Non disponibile."}</p></div>`;
      return;
    }
    const r = state.data.rows.find((x) => x.lapId === lapId);
    const what = r ? `il tempo <b>${fmtLap(r.best)}</b> di <b>${esc(r.nick)}</b> (${esc(r.track)} · ${esc(r.car)})` : "questo giro";
    $app.innerHTML = head + `
      <div class="panel reset">
        <div class="reset-body" id="dlBody">
          <p>Stai per cancellare ${what}. Il giro diventa <b>non valido</b>: se era il giro migliore, al suo posto sale il miglior giro rimasto del pilota.</p>
          <label>PIN (lo stesso del reset)<input id="dlPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off"></label>
          <div class="rs-msg" id="dlMsg"></div>
          <div class="rs-actions"><button class="btn" id="dlCheck">Continua</button><a class="btn ghost" href="#">Annulla</a></div>
        </div>
      </div>`;
    const $msg = document.getElementById("dlMsg");
    const say = (t, bad = true) => { $msg.textContent = t; $msg.className = "rs-msg " + (bad ? "bad" : "good"); };
    const btn = document.getElementById("dlCheck");
    const $pin = document.getElementById("dlPin");
    $pin.focus();
    $pin.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
    btn.addEventListener("click", async () => {
      const body = { p_pin: $pin.value.trim(), p_lap_id: lapId, p_confirm: false };
      if (!/^[0-9]{6,12}$/.test(body.p_pin)) return say("Il PIN è di 6-12 cifre.");
      btn.disabled = true;
      say("Controllo il PIN…", false);
      let res;
      try { res = await source().deleteLap(body); } catch (e) { btn.disabled = false; return say(/HTTP 404/.test(e.message) ? "Prima va eseguito l'aggiornamento del database (004_cancella_tempi.sql)." : "Server non raggiungibile."); }
      btn.disabled = false;
      if (!res.ok) return say(pinErrText(res));
      const when = new Date(res.driven_at).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
      const after = !res.is_best
        ? "Non è il giro migliore: il tempo in classifica non cambia."
        : res.next != null
          ? `In classifica al suo posto va il suo miglior giro rimasto: <b>${fmtLap(num(res.next))}</b>.`
          : "Non ha altri giri validi: esce da questa classifica.";
      document.getElementById("dlBody").innerHTML = `
        <div class="rs-confirm">
          <h2>Confermi?</h2>
          <p>Cancello il giro <b>${fmtLap(num(res.lap_time))}</b> di <b>${esc(res.nick)}</b> · ${esc(res.track)} · ${esc(res.car)} · ${esc(when)}.</p>
          <p>${after}</p>
          <div class="rs-msg" id="dlMsg2"></div>
          <div class="rs-actions"><button class="btn danger" id="dlGo">Sì, cancella</button><a class="btn ghost" href="#">Annulla</a></div>
        </div>`;
      const go = document.getElementById("dlGo");
      go.addEventListener("click", async () => {
        go.disabled = true;
        const $m2 = document.getElementById("dlMsg2");
        let done;
        try { done = await source().deleteLap({ ...body, p_confirm: true }); } catch { go.disabled = false; $m2.textContent = "Server non raggiungibile."; $m2.className = "rs-msg bad"; return; }
        if (!done.ok) { go.disabled = false; $m2.textContent = pinErrText(done); $m2.className = "rs-msg bad"; return; }
        const msg = done.removed ? "Il pilota esce da questa classifica." : done.new_best != null ? `Nuovo giro migliore del pilota: ${fmtLap(num(done.new_best))}.` : "La classifica è aggiornata.";
        document.getElementById("dlBody").innerHTML = `<div class="rs-confirm"><h2>Tempo cancellato</h2>
          <p>${esc(msg)}</p>
          <div class="rs-actions"><a class="btn" href="#">Vai alle classifiche</a></div></div>`;
        clearCaches();
        state.reloadOnHome = true; // i dati si ricaricano tornando alle classifiche
      });
    });
  }

  // ---------------------------------------------------------------- generale
  function renderEmpty() {
    $app.innerHTML = `
      <div class="empty">
        <img src="icons/icon-192.png" alt="" width="64" height="64" style="border-radius:16px;opacity:.9">
        <h2>Nessun giro ancora</h2>
        <p>Avvia <b>LMU-Tracker</b>, scendi in pista e fai qualche giro: i tempi compariranno qui da soli.</p>
        <button class="btn" id="goDemo">Guarda la demo</button>
      </div>`;
    document.getElementById("goDemo").addEventListener("click", () => setMode("demo"));
  }

  function render() {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", !state.view && t.dataset.tab === state.tab));
    if (!state.data) return;
    if (state.view?.type === "giri") renderLaps();
    else if (state.view?.type === "confronto") renderCompare();
    else if (state.view?.type === "reset") renderReset();
    else if (state.view?.type === "cancella") renderDelete();
    else if (state.tab === "feed") renderFeed();
    else if (state.tab === "drivers") renderDrivers();
    else renderBoard();
  }

  function setStatus() {
    if (state.mode === "demo") {
      $status.className = "status demo";
      $status.innerHTML = `DEMO <a href="?" style="color:inherit;opacity:.7;margin-left:4px">esci</a>`;
    } else {
      $status.className = "status live";
      $status.textContent = "LIVE";
    }
  }

  function setMode(mode) {
    state.mode = mode;
    const url = new URL(location.href);
    if (mode === "demo") url.searchParams.set("demo", "1");
    else url.searchParams.delete("demo");
    history.replaceState(null, "", url);
    clearCaches();
    state.trackId = null;
    state.era = null;
    load();
  }

  function applyData(raw, compare) {
    const prev = state.data;
    state.raw = raw;
    state.data = build(raw);
    updateBaseline(raw);
    if (compare && prev && state.mode === "live" && !state.era) markMoves(prev, state.data);
    setStatus();
    $updated.textContent = `Aggiornato alle ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    // nelle pagine di dettaglio non si ridisegna: i dati nuovi si vedono tornando alla classifica
    if (!state.view || !compare) render();
  }

  async function load(silent) {
    lastFull = Date.now();
    $refresh.classList.add("spin");
    if (!silent && !state.data) $app.innerHTML = `<div class="loading"><div class="spinner"></div>Carico i tempi…</div>`;
    try {
      const raw = await source().overview();
      applyData(raw, !!silent);
    } catch (e) {
      $status.className = "status error";
      $status.textContent = "OFFLINE";
      if (!state.data) {
        $app.innerHTML = `<div class="empty"><h2>Server non raggiungibile</h2><p>Controlla la connessione e riprova.</p>
          <div style="display:flex;gap:8px"><button class="btn" id="retry">Riprova</button><button class="btn ghost" id="goDemo">Guarda la demo</button></div></div>`;
        document.getElementById("retry").addEventListener("click", () => load());
        document.getElementById("goDemo").addEventListener("click", () => setMode("demo"));
      }
    } finally {
      $refresh.classList.remove("spin");
    }
  }

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      state.tab = t.dataset.tab;
      persist();
      if (state.view) goHome();
      else render();
    })
  );
  $refresh.addEventListener("click", () => { clearCaches(); load(true); });
  window.addEventListener("hashchange", () => {
    parseHash();
    window.scrollTo(0, 0);
    if (!state.view && state.reloadOnHome) {
      state.reloadOnHome = false;
      state.data = null;
      return load();
    }
    render();
  });
  parseHash();
  setInterval(pollLive, LIVE_POLL_MS);
  // tornando sull'app (telefono sbloccato, scheda riaperta) controlla subito
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollLive(); });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  load();
})();
