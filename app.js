/* LMU Telemetry - app classifiche
 * Dati: viste Supabase v_personal_best, v_best_laps, v_laps (solo lettura con chiave publishable).
 * Demo: ?demo=1 oppure pulsante, con dati generati da demo.js.
 */
(function () {
  "use strict";

  const cfg = window.LMU_CONFIG;
  const $app = document.getElementById("app");
  const $status = document.getElementById("status");
  const $updated = document.getElementById("updated");
  const $refresh = document.getElementById("refresh");

  const CLASSES = ["Hypercar", "LMP2", "LMGT3"];
  const SESSION_IT = { practice: "Prove", qualify: "Qualifica", race: "Gara", warmup: "Warm-up", testday: "Test" };
  const GRIP_IT = ["Verde", "Bassa", "Media", "Alta", "Satura"];

  const params = new URLSearchParams(location.search);
  const saved = (() => { try { return JSON.parse(localStorage.getItem("lmu-ui") || "{}"); } catch { return {}; } })();

  const state = {
    mode: params.has("demo") ? "demo" : "live",
    tab: saved.tab || "board",
    trackId: saved.trackId ?? null,
    cls: saved.cls || "all",
    perDriver: saved.perDriver ?? true,
    selKey: null,
    data: null,
    history: new Map(),
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
        driver_id: b.driver_id, nick: b.nick, track_id: b.track_id, track_display: b.track_display,
        car_id: b.car_id, car: b.car, car_class: b.car_class,
        best_lap: b.lap_time, best_s1: s[0], best_s2: s[1], best_s3: s[2],
        theoretical: Math.round((s[0] + s[1] + s[2]) * 1000) / 1000,
        valid_laps: list.length, last_driven: list.reduce((a, x) => (x.driven_at > a ? x.driven_at : a), ""),
      });
      best.push(b);
    }
    const recent = [...laps].sort((a, b) => (a.driven_at < b.driven_at ? 1 : -1)).slice(0, 400);
    return { pb, best, recent };
  }

  const Live = {
    async overview() {
      const [pb, best, recent] = await Promise.all([
        api("v_personal_best?select=*"),
        api("v_best_laps?select=*"),
        api("v_laps?select=*&order=driven_at.desc&limit=400"),
      ]);
      return { pb, best, recent };
    },
    history(r) {
      return api(`v_laps?select=lap_time,driven_at,valid&driver_id=eq.${r.driver_id}&track_id=eq.${r.track_id}&car_id=eq.${r.car_id}&valid=is.true&order=driven_at.asc&limit=1000`);
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
  };
  const source = () => (state.mode === "demo" ? Demo : Live);

  function build({ pb, best, recent }) {
    const bestMap = new Map(best.map((b) => [`${b.driver_id}|${b.track_id}|${b.car_id}`, b]));
    const rows = pb.map((p) => {
      const key = `${p.driver_id}|${p.track_id}|${p.car_id}`;
      const lap = bestMap.get(key) || {};
      return {
        key,
        driver_id: p.driver_id, nick: p.nick,
        track_id: p.track_id, track: p.track_display,
        car_id: p.car_id, car: p.car, cls: p.car_class,
        best: num(p.best_lap),
        pbS: [num(p.best_s1), num(p.best_s2), num(p.best_s3)],
        theo: num(p.theoretical),
        laps: p.valid_laps, last: p.last_driven,
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
    return { rows, tracks: trackList, maxLen, recent, byKey: new Map(rows.map((r) => [r.key, r])) };
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
    const classesHere = CLASSES.filter((c) => track.rows.some((r) => r.cls === c));

    const trackCards = d.tracks.map((t) => {
      const tr = t.rows.filter((r) => state.cls === "all" || r.cls === state.cls);
      const rec = tr.reduce((a, r) => (!a || r.best < a.best ? r : a), null);
      const drivers = new Set(t.rows.map((r) => r.driver_id)).size;
      return `
        <button class="track-card ${t.id === track.id ? "active" : ""}" data-track="${esc(t.id)}">
          <div class="t-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="len-bar"><i style="width:${Math.round(((t.length || 0) / d.maxLen) * 100)}%"></i></div>
          <div class="t-meta"><span>${km(t.length)}</span><span>${drivers} pilot${drivers === 1 ? "a" : "i"}</span></div>
          <div class="t-meta"><span class="t-rec">${rec ? fmtLap(rec.best) : "—"}</span><span>${rec ? esc(rec.nick) : ""}</span></div>
        </button>`;
    }).join("");

    const clsButtons = [["all", "Tutte"], ...CLASSES.map((c) => [c, c])]
      .map(([v, label]) => `<button data-cls="${v}" class="${state.cls === v ? "active" : ""}" ${v !== "all" && !classesHere.includes(v) ? "disabled style='opacity:.35'" : ""}>${v !== "all" ? `<span class="dot ${v}"></span>` : ""}${label}</button>`)
      .join("");

    const body = rows.map((r, i) => {
      const gap = i === 0 ? null : r.best - leader.best;
      const secs = r.lap.s.map((s, si) => {
        let c = "";
        if (s != null && Math.abs(s - bestSec[si]) < 0.0005) c = "purple";
        else if (s != null && r.pbS[si] != null && Math.abs(s - r.pbS[si]) < 0.0005) c = "green";
        return `<td class="r col-sec"><span class="sec ${c}">${fmtSec(s)}</span></td>`;
      }).join("");
      return `
        <tr data-key="${esc(r.key)}" class="${r.key === state.selKey ? "sel" : ""}">
          <td class="pos ${i < 3 ? "p" + (i + 1) : ""}">${i + 1}</td>
          <td><div class="driver"><span class="cls-bar ${esc(r.cls)}"></span><div style="min-width:0">
            <div class="nick">${esc(r.nick)}</div><div class="car">${esc(r.car)}</div></div></div></td>
          <td class="r"><span class="time">${fmtLap(r.best)}</span></td>
          <td class="r"><span class="gap">${i === 0 ? "" : fmtGap(gap)}</span></td>
          ${secs}
          <td class="r col-ideal"><span class="ideal">${fmtLap(r.theo)}</span></td>
          <td class="r col-laps"><span class="gap">${r.laps}</span></td>
          <td class="r col-when"><span class="gap">${ago(r.last)}</span></td>
        </tr>`;
    }).join("");

    $app.innerHTML = `
      <div class="section-label">Piste</div>
      <div class="tracks">${trackCards}</div>

      <div class="filters">
        <div class="seg" id="cls">${clsButtons}</div>
        <label class="switch"><input type="checkbox" id="perDriver" ${state.perDriver ? "checked" : ""}>Solo la miglior auto di ogni pilota</label>
      </div>

      <section class="hero">
        <div>
          <div class="section-label" style="margin:0 0 4px">${state.cls === "all" ? "Tutte le classi" : esc(state.cls)}</div>
          <h1>${esc(track.name)}</h1>
          <div class="h-sub">${km(track.length)} · ${rows.length} in classifica · ${totalLaps} giri validi</div>
        </div>
        <div class="stat"><div class="k">Record</div><div class="v">${leader ? fmtLap(leader.best) : "—"}</div><div class="d">${leader ? esc(leader.nick) + " · " + esc(leader.car) : ""}</div></div>
        <div class="stat"><div class="k">Ideale del gruppo</div><div class="v purple">${fmtLap(groupIdeal)}</div><div class="d">migliori settori di tutti</div></div>
        <div class="stat"><div class="k">Ultima attività</div><div class="v" style="font-size:18px">${track.last ? ago(track.last) : "—"}</div><div class="d">${track.last ? new Date(track.last).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" }) : ""}</div></div>
      </section>

      <div class="grid">
        <div class="panel">
          <div class="panel-head"><h2>Classifica</h2><span class="hint"><span class="sec purple">viola</span> = settore migliore · <span class="sec green">verde</span> = record personale</span></div>
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
      <div class="panel-head"><h2>Dettaglio</h2><span class="badge cls ${esc(r.cls)}">${esc(r.cls)}</span></div>
      <div class="detail">
        <div class="d-head">
          <div><div class="nick">${esc(r.nick)}</div><div class="car">${esc(r.car)}</div></div>
          <div class="d-time"><span class="time">${fmtLap(r.best)}</span><span class="gap">${isLeader ? "Record della pista" : fmtGap(r.best - leader.best) + " dal primo"}</span></div>
        </div>

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
      const isRec = best != null && Math.abs(best - (trackRec.get(`${l.track_id}|${l.car_class}`) ?? -1)) < 0.0005;
      return `
        <li>
          <span class="when">${ago(new Date(s.last).toISOString())}</span>
          <div class="what">
            <div class="l1">${esc(l.nick)} <span class="badge cls ${esc(l.car_class)}">${esc(l.car_class)}</span>
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
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
    if (!state.data) return;
    if (state.tab === "feed") renderFeed();
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
    state.history.clear();
    state.trackId = null;
    load();
  }

  async function load(silent) {
    $refresh.classList.add("spin");
    if (!silent && !state.data) $app.innerHTML = `<div class="loading"><div class="spinner"></div>Carico i tempi…</div>`;
    try {
      const raw = await source().overview();
      state.data = build(raw);
      setStatus();
      $updated.textContent = `Aggiornato alle ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
      render();
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
    t.addEventListener("click", () => { state.tab = t.dataset.tab; persist(); render(); })
  );
  $refresh.addEventListener("click", () => { state.history.clear(); load(true); });
  setInterval(() => { if (state.mode === "live" && document.visibilityState === "visible") load(true); }, (cfg.refreshSeconds || 60) * 1000);

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  load();
})();
