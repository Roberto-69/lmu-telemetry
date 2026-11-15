/* LMU Telemetry - confronto della telemetria tra due giri migliori.
 * decode(): legge il formato 1 scritto dal tracker (vedi lmu_tracker/trace.py).
 * render(): mappa con microsettori, distacco lungo il giro, velocità, gas, freno, sterzo.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- formato dati
  async function decode(row) {
    const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"));
    const dv = new DataView(await new Response(stream).arrayBuffer());
    const n = row.points;
    let off = 8;
    const col = (size, get) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = get(off + i * size);
      off += size * n;
      return a;
    };
    const dt = col(2, (o) => dv.getUint16(o, true));
    const speed = col(2, (o) => dv.getUint16(o, true) / 10);
    const thr = col(1, (o) => dv.getUint8(o) / 255);
    const brk = col(1, (o) => dv.getUint8(o) / 255);
    const steer = col(1, (o) => dv.getInt8(o) / 127);
    const gear = col(1, (o) => dv.getInt8(o));
    const dx = col(2, (o) => dv.getInt16(o, true));
    const dz = col(2, (o) => dv.getInt16(o, true));
    const t = new Float64Array(n), x = new Float64Array(n), z = new Float64Array(n);
    let tt = 0, xx = dv.getInt32(0, true), zz = dv.getInt32(4, true);
    for (let i = 0; i < n; i++) {
      tt += dt[i]; xx += dx[i]; zz += dz[i];
      t[i] = tt / 1000; x[i] = xx / 10; z[i] = zz / 10;
    }
    return { n, step: row.step_m, t, speed, thr, brk, steer, gear, x, z };
  }

  // ---------------------------------------------------------------- microsettori
  // Curve trovate sul giro di riferimento: minimi di velocità con una frenata vera prima.
  // Ogni microsettore va dal punto più veloce prima della curva a quello prima della curva dopo.
  function microsectors(ref, n) {
    const v = ref.speed;
    const W = Math.max(1, Math.round(150 / ref.step));      // curve distanti almeno 150 m
    const back = Math.max(1, Math.round(400 / ref.step));   // la frenata si cerca nei 400 m prima
    const mins = [];
    for (let i = 1; i < n - 1; i++) {
      let isMin = true;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
        if (v[j] < v[i] || (v[j] === v[i] && j < i)) { isMin = false; break; }
      }
      if (!isMin) continue;
      let pre = 0;
      for (let j = Math.max(0, i - back); j < i; j++) pre = Math.max(pre, v[j]);
      if (pre - v[i] >= 20) mins.push(i);
    }
    if (mins.length < 2) {
      const k = 10, out = [];
      for (let i = 0; i < k; i++) out.push({ name: `Tratto ${i + 1}`, a: Math.round((i * (n - 1)) / k), b: Math.round(((i + 1) * (n - 1)) / k), apex: null });
      return out;
    }
    const bounds = [0];
    for (let k = 0; k < mins.length - 1; k++) {
      let best = mins[k];
      for (let j = mins[k]; j <= mins[k + 1]; j++) if (v[j] > v[best]) best = j;
      bounds.push(best);
    }
    bounds.push(n - 1);
    return mins.map((m, k) => ({ name: `Curva ${k + 1}`, a: bounds[k], b: bounds[k + 1], apex: m }));
  }

  // ---------------------------------------------------------------- nomi delle curve
  // Per pista: lunghezza del giro (m) e curve reali come [metri dal traguardo, nome].
  // Le posizioni sono state misurate sui giri veri del gruppo (apice delle curve trovate da microsectors).
  // Una curva trovata prende il nome della curva reale più vicina entro NAME_TOL metri; le altre restano "Curva N".
  const NAME_TOL = 200;
  const SPA = { len: 6982, c: [[280, "La Source"], [1270, "Raidillon"], [2385, "Les Combes"], [2560, "Malmedy"], [2955, "Rivage"], [3160, "Bruxelles"], [3720, "Pouhon"], [4390, "Fagnes"], [4560, "Campus"], [4830, "Stavelot"], [6690, "Bus Stop"]] };
  const CORNERS = {
    "Autodromo Nazionale Monza": { len: 5781, c: [[975, "Rettifilo"], [2150, "Roggia"], [2555, "Lesmo 1"], [2885, "Lesmo 2"], [3955, "Ascari"], [5195, "Parabolica"]] },
    "Monza Curva Grande Circuit": { len: 5745, c: [[2125, "Roggia"], [2505, "Lesmo 1"], [2845, "Lesmo 2"], [3910, "Ascari"], [5145, "Parabolica"]] },
    "Autodromo Enzo e Dino Ferrari": { len: 4901, c: [[705, "Tamburello"], [1425, "Villeneuve"], [1715, "Tosa"], [2330, "Piratella"], [2855, "Acque Minerali"], [3390, "Variante Alta"], [4135, "Rivazza"]] },
    "Circuit de Spa-Francorchamps": SPA,
    "Circuit de Spa-Francorchamps Endurance": SPA,
    "Circuit de la Sarthe": { len: 13624, c: [[845, "Dunlop"], [1480, "Esses"], [1925, "Tertre Rouge"], [4115, "Playstation"], [6090, "Michelin"], [7740, "Mulsanne"], [9855, "Indianapolis"], [10170, "Arnage"], [11560, "Porsche"], [12245, "Corvette"], [12430, "Maison Blanche"], [13450, "Ford"]] },
    "Bahrain International Circuit": { len: 5387, c: [[745, "Curva 1"], [1530, "Curva 4"], [1895, "Curve 5-7"], [2250, "Curva 8"], [2720, "Curva 10"], [3450, "Curva 11"], [4110, "Curva 13"], [4920, "Curva 14"]] },
    "Daytona International Speedway Road Course": { len: 5734, c: [[460, "Curva 1"], [960, "Int. Horseshoe"], [1770, "Curva 5"], [2155, "West Horseshoe"], [3935, "Bus Stop"]] },
    "Michelin Raceway Road Atlanta": { len: 4084, c: [[465, "Curva 1"], [850, "Esses"], [1420, "Curva 6"], [2155, "Curva 7"], [3530, "Chicane 10"]] },
    "Silverstone National Circuit": { len: 2634, c: [[375, "Copse"], [1050, "Becketts"], [2130, "Luffield"]] },
  };

  // dà il nome reale ai microsettori della pista (se la conosciamo e il giro ha la lunghezza giusta)
  function nameCorners(MS, track, step, n) {
    const t = CORNERS[track];
    if (!t || Math.abs(n * step - t.len) > t.len * 0.03) return;
    const used = new Set();
    for (const m of MS) {
      if (m.apex == null) continue;
      const d = m.apex * step;
      let best = null;
      for (const c of t.c) if (!used.has(c) && Math.abs(c[0] - d) <= NAME_TOL && (!best || Math.abs(c[0] - d) < Math.abs(best[0] - d))) best = c;
      if (best) { used.add(best); m.real = best[1]; }
    }
  }

  // ---------------------------------------------------------------- disegno
  const fmt = (t) => {
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
  };
  const sign = (d) => (d > 0.0005 ? "+" : d < -0.0005 ? "−" : "");
  const col = (g) => (Math.abs(g) < 0.005 ? "var(--faint)" : g > 0 ? "var(--red)" : "var(--green)");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // colori dei piloti aggiunti oltre a te (giallo) e al riferimento (viola)
  const XC = ["#22d3ee", "#ff8a3d", "#ff6fb5", "#a3e635"];
  const gearTxt = (g) => (g > 0 ? g + "ª" : g === 0 ? "N" : "R");

  /** me, ref: { trace, nick, lap } ; el: contenitore
   *  opts.extra: altri piloti [{ trace, nick, lap, key }], confrontati anche loro col riferimento
   *  opts.onPickOther(key) cambia il riferimento, opts.onSetExtra(keys) cambia gli altri piloti */
  function render(el, me, ref, opts = {}) {
    const A = me.trace, B = ref.trace;
    const extra = opts.extra || [];
    // tutti i piloti mostrati: tu, il riferimento, gli altri. Il distacco di ognuno è rispetto al riferimento
    const DR = [
      { T: A, nick: me.nick, c: "var(--accent)" },
      { T: B, nick: ref.nick, c: "var(--purple)" },
      ...extra.map((e, j) => ({ T: e.trace, nick: e.nick, c: XC[j % XC.length], lap: e.lap, key: e.key })),
    ];
    const XD = DR.slice(2);
    const n = Math.min(...DR.map((d) => d.T.n));
    const step = B.step;
    const D = new Float64Array(n);
    for (let i = 0; i < n; i++) D[i] = A.t[i] - B.t[i];
    const MS = microsectors(B, n);
    MS.forEach((m) => (m.g = D[m.b] - D[m.a]));
    nameCorners(MS, opts.track, step, n);
    const gap = me.lap - ref.lap;

    // mappa (vista dall'alto: x a destra, z verso l'alto)
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
      mnx = Math.min(mnx, B.x[i]); mxx = Math.max(mxx, B.x[i]);
      mnz = Math.min(mnz, B.z[i]); mxz = Math.max(mxz, B.z[i]);
    }
    // il riquadro del disegno ha le proporzioni della pista: lo svg la allarga quanto più può nel pannello
    const pad = 16;
    const k = 400 / Math.max(1, mxx - mnx, mxz - mnz);
    const MW = Math.round((mxx - mnx) * k + 2 * pad), MH = Math.round((mxz - mnz) * k + 2 * pad);
    const ox = pad, oy = pad;
    const mx = (i) => ox + (B.x[i] - mnx) * k;
    const my = (i) => oy + (mxz - B.z[i]) * k;
    const pts = (a, b) => {
      const s = [];
      const every = Math.max(1, Math.floor((b - a) / 200));
      for (let i = a; i <= b; i += every) s.push(mx(i).toFixed(1) + "," + my(i).toFixed(1));
      s.push(mx(b).toFixed(1) + "," + my(b).toFixed(1));
      return s.join(" ");
    };

    let sel = null, r0 = 0, r1 = n - 1, cur = 0;
    const xLeg = () => XD.map((d) => `<span><i class="sw" style="background:${d.c}"></i>${esc(d.nick)}</span>`).join("");
    const others = opts.others || [];

    // traiettoria: vista ingrandita in metri (X = x, Y = -z), linea di mezzo tra i due giri per la fascia della pista
    const TW = 400, TH = 300, TRACK_W = 13;
    const midX = (i) => (A.x[i] + B.x[i]) / 2, midY = (i) => -(A.z[i] + B.z[i]) / 2;
    let tv = { cx: 0, cy: 0, w: 160 }, tmode = "drv";
    const ZOOMS = [10, 15, 20, 30, 50, 80, 120, 160, 240, 360, 540, 800]; // larghezza della vista in metri
    const circ = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };

    el.innerHTML = `
      <div class="cmp-head">
        <div class="mini"><div class="k"><span class="sw me"></span>${esc(me.nick)}</div><div class="v">${fmt(me.lap)}</div></div>
        <div class="mini"><div class="k"><span class="sw ref"></span>${esc(ref.nick)}${opts.refIsRecord ? " · record" : ""}</div><div class="v">${fmt(ref.lap)}</div></div>
        <div class="mini"><div class="k">Distacco</div><div class="v" style="color:${col(gap)}">${sign(gap)}${Math.abs(gap).toFixed(3)}</div></div>
        ${others.length ? `<label class="cmp-pick"><span>Confronta con</span><select id="cmpOther">${others.map((o) => `<option value="${esc(o.key)}" ${o.key === opts.refKey ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>` : ""}
      </div>
      ${extraRow()}
      <div class="cmp-top">
        <div class="panel cmp-map"><svg id="cmpMap" viewBox="0 0 ${MW} ${MH}" preserveAspectRatio="xMidYMid meet"></svg>
          <div class="cmp-steps"><button class="sbtn" data-d="1" aria-label="Avanti di un passo" title="Avanti (→) · tieni premuto per scorrere">▲</button><button class="sbtn" data-d="-1" aria-label="Indietro di un passo" title="Indietro (←) · tieni premuto per scorrere">▼</button></div></div>
        <div class="panel cmp-traj">
          <div class="panel-head"><h2>Traiettoria</h2>
            <div class="traj-tools">
              <span class="seg"><button data-c="drv" class="on">Piloti</button><button data-c="ped">Gas/freno</button></span>
              <button class="zbtn" data-z="1" aria-label="Allontana">−</button><button class="zbtn" data-z="-1" aria-label="Avvicina">+</button>
            </div>
          </div>
          <div class="traj-wrap"><svg id="cmpTraj" viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="xMidYMid meet"></svg>
            <div class="traj-data" id="trajData" aria-live="off"></div></div>
          <div class="traj-leg" id="trajLeg"></div>
        </div>
        <div class="panel cmp-ms">
          <div class="panel-head"><h2>Microsettori</h2><span class="hint">tocca per ingrandire</span></div>
          <div id="cmpList"></div>
        </div>
      </div>
      <div class="cmp-readout" id="cmpRead">Passa sul grafico o trascina il pallino sulla pista per leggere i valori</div>
      <div class="panel cmp-charts" id="cmpCharts"></div>
      <div class="cmp-legend"><span><i class="sw me"></i>${esc(me.nick)}</span><span><i class="sw ref"></i>${esc(ref.nick)}</span>${xLeg()}<span><i class="sq" style="background:var(--green)"></i>guadagni</span><span><i class="sq" style="background:var(--red)"></i>perdi</span></div>`;

    const pick = document.getElementById("cmpOther");
    if (pick && opts.onPickOther) pick.addEventListener("change", () => opts.onPickOther(pick.value));
    const xKeys = XD.map((d) => d.key);
    const addSel = document.getElementById("cmpAdd");
    if (addSel && opts.onSetExtra) addSel.addEventListener("change", () => addSel.value && opts.onSetExtra([...xKeys, addSel.value]));
    el.querySelectorAll(".xchip button").forEach((b) => b.addEventListener("click", () => opts.onSetExtra && opts.onSetExtra(xKeys.filter((k) => k !== b.dataset.k))));

    // riga degli altri piloti: un'etichetta per ognuno (× per toglierlo) e il menu per aggiungerne
    function extraRow() {
      const free = others.filter((o) => o.key !== opts.refKey && !XD.some((d) => d.key === o.key));
      const canAdd = opts.onSetExtra && free.length && XD.length < (opts.maxExtra || XC.length);
      if (!XD.length && !canAdd) return "";
      const chips = XD.map((d) => {
        const g = d.lap - ref.lap;
        return `<span class="xchip"><i class="sw" style="background:${d.c}"></i>${esc(d.nick)} <b>${fmt(d.lap)}</b> <span style="color:${col(g)}">${sign(g)}${Math.abs(g).toFixed(3)}</span>${opts.onSetExtra ? `<button data-k="${esc(d.key)}" aria-label="Togli ${esc(d.nick)}" title="Togli dal confronto">×</button>` : ""}</span>`;
      }).join("");
      const add = canAdd ? `<select id="cmpAdd" aria-label="Aggiungi un pilota al confronto"><option value="">+ Aggiungi pilota</option>${free.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("")}</select>` : "";
      return `<div class="cmp-extra">${chips}${add}</div>`;
    }

    function drawMap() {
      let s = `<polyline points="${pts(0, n - 1)}" fill="none" stroke="var(--line-2)" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>`;
      MS.forEach((m, i) => {
        s += `<polyline data-i="${i}" points="${pts(m.a, m.b)}" fill="none" stroke="${col(m.g)}" stroke-width="${sel === i ? 6 : 4}" stroke-linejoin="round" stroke-linecap="round" opacity="${sel === null || sel === i ? 1 : 0.3}" style="cursor:pointer"/>`;
      });
      MS.forEach((m, i) => {
        if (m.apex == null) return;
        s += `<text x="${(mx(m.apex) + 9).toFixed(1)}" y="${(my(m.apex) - 7).toFixed(1)}" class="cmp-num">${i + 1}</text>`;
      });
      // traguardo di traverso alla pista
      const fa = (Math.atan2(my(Math.min(3, n - 1)) - my(0), mx(Math.min(3, n - 1)) - mx(0)) * 180) / Math.PI;
      s += `<rect x="${(mx(0) - 2).toFixed(1)}" y="${(my(0) - 9).toFixed(1)}" width="4" height="18" fill="var(--text)" transform="rotate(${fa.toFixed(1)} ${mx(0).toFixed(1)} ${my(0).toFixed(1)})"/>`;
      s += `<circle id="cmpDot" r="6" cx="${mx(cur).toFixed(1)}" cy="${my(cur).toFixed(1)}" fill="var(--accent)" stroke="var(--bg)" stroke-width="2"/>`;
      document.getElementById("cmpMap").innerHTML = s;
      showViewBox();
    }

    // ---- traiettoria
    function drawTraj() {
      const pts2 = (fx, fy, a, b) => {
        let s = "";
        for (let i = a; i <= b; i++) s += fx(i).toFixed(2) + "," + fy(i).toFixed(2) + " ";
        return s;
      };
      const ax = (i) => A.x[i], ay = (i) => -A.z[i], bx = (i) => B.x[i], by = (i) => -B.z[i];
      const ln = `fill="none" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"`;
      let s = `<polyline points="${pts2(midX, midY, 0, n - 1)}" fill="none" stroke="var(--line-2)" stroke-width="${TRACK_W + 0.8}" stroke-linejoin="round"/>
        <polyline points="${pts2(midX, midY, 0, n - 1)}" fill="none" stroke="var(--surface-2)" stroke-width="${TRACK_W}" stroke-linejoin="round"/>
        <rect x="${(midX(0) - 0.6).toFixed(2)}" y="${(midY(0) - TRACK_W / 2).toFixed(2)}" width="1.2" height="${TRACK_W}" fill="var(--text)" opacity="0.6"
          transform="rotate(${((Math.atan2(midY(1) - midY(0), midX(1) - midX(0)) * 180) / Math.PI).toFixed(1)} ${midX(0).toFixed(2)} ${midY(0).toFixed(2)})"/>`;
      if (tmode === "drv") {
        for (const d of XD) s += `<polyline points="${pts2((i) => d.T.x[i], (i) => -d.T.z[i], 0, n - 1)}" stroke="${d.c}" stroke-width="2" ${ln}/>`;
        s += `<polyline points="${pts2(bx, by, 0, n - 1)}" stroke="var(--purple)" stroke-width="2.4" ${ln}/>
          <polyline points="${pts2(ax, ay, 0, n - 1)}" stroke="var(--accent)" stroke-width="2.4" ${ln}/>`;
      } else {
        // verde gas pieno, rosso freno, bianco rilascio o gas parziale;
        // ogni linea ha attorno un bordo nel colore del pilota per riconoscerla (tu sopra a tutti)
        const cat = (T, i) => (T.brk[i] > 0.05 ? 2 : T.thr[i] >= 0.95 ? 0 : 1);
        const PC = ["var(--green)", "#e8ecf3", "var(--red)"];
        const runs = (T, fx, fy, extra) => {
          let out = "", a = 0;
          for (let i = 1; i <= n; i++) {
            if (i < n && cat(T, i) === cat(T, a)) continue;
            out += `<polyline points="${pts2(fx, fy, a, Math.min(i, n - 1))}" stroke="${PC[cat(T, a)]}" ${extra} ${ln}/>`;
            a = i;
          }
          return out;
        };
        for (let k = DR.length - 1; k >= 0; k--) {
          const d = DR[k], fx = (i) => d.T.x[i], fy = (i) => -d.T.z[i];
          s += `<polyline points="${pts2(fx, fy, 0, n - 1)}" stroke="${d.c}" stroke-width="${k === 0 ? 7 : 6}" ${ln}/>` +
            runs(d.T, fx, fy, `stroke-width="${k === 0 ? 3 : 2.4}"`);
        }
      }
      // pallini (il tuo sopra a tutti); nomi e dati stanno fissi nel riquadro a lato
      for (let k = DR.length - 1; k >= 0; k--) s += `<circle id="trajD${k}" fill="${DR[k].c}" stroke="var(--bg)"/>`;
      document.getElementById("cmpTraj").innerHTML = s;
      document.getElementById("trajLeg").innerHTML = tmode === "drv"
        ? `<span><i class="sw me"></i>${esc(me.nick)}</span><span><i class="sw ref"></i>${esc(ref.nick)}</span>${xLeg()}<span class="traj-note">bordi pista indicativi</span>`
        : `<span><i class="sq" style="background:var(--green)"></i>gas pieno</span><span><i class="sq" style="background:#e8ecf3"></i>rilascio / parziale</span><span><i class="sq" style="background:var(--red)"></i>freno</span><span>bordo:</span>${DR.map((d) => `<span><i class="sw" style="background:${d.c}"></i>${esc(d.nick)}</span>`).join("")}`;
      setView(tv.cx, tv.cy, tv.w);
      placeDots();
    }

    function setView(cx, cy, w) {
      tv = { cx, cy, w };
      const h = (w * TH) / TW;
      const svg = document.getElementById("cmpTraj");
      svg.setAttribute("viewBox", `${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);
      const r = (w / TW) * 6;
      for (let k = 0; k < DR.length; k++) {
        const id = "trajD" + k;
        const c = document.getElementById(id);
        if (c) { c.setAttribute("r", (k === 0 ? r : r * 0.8).toFixed(2)); c.setAttribute("stroke-width", (r / 3).toFixed(2)); }
      }
      placeDots();
      showViewBox();
    }

    // riquadro tratteggiato sulla mappa intera: la zona mostrata nella traiettoria
    function showViewBox() {
      const rc = document.getElementById("cmpView");
      if (!rc) return;
      const h = (tv.w * TH) / TW;
      rc.setAttribute("x", (ox + (tv.cx - tv.w / 2 - mnx) * k).toFixed(1));
      rc.setAttribute("y", (oy + (mxz + tv.cy - h / 2) * k).toFixed(1));
      rc.setAttribute("width", Math.max(2, tv.w * k).toFixed(1));
      rc.setAttribute("height", Math.max(2, h * k).toFixed(1));
    }

    function placeDots() {
      const set = (id, x, y) => { const c = document.getElementById(id); if (c) { c.setAttribute("cx", x.toFixed(2)); c.setAttribute("cy", y.toFixed(2)); } };
      set("cmpDot", mx(cur), my(cur));
      DR.forEach((d, k) => set("trajD" + k, d.T.x[cur], -d.T.z[cur]));
      // riquadro fisso: per ogni pilota nick nel colore del pallino, distacco in quel punto, marcia, velocità
      const box = document.getElementById("trajData");
      if (box) box.innerHTML = DR.map((d, k) => {
        const dd = k === 1 ? -D[cur] : d.T.t[cur] - B.t[cur]; // il riferimento si confronta con te
        return `<i style="background:${d.c}"></i><b style="color:${d.c}">${esc(d.nick)}</b>` +
          `<span style="color:${col(dd)}">${dd >= 0 ? "+" : "−"}${Math.abs(dd).toFixed(3)}</span>` +
          `<span>${gearTxt(d.T.gear[cur])}</span><span>${Math.round(d.T.speed[cur])}<small> km/h</small></span>`;
      }).join("");
    }

    // i pallini restano sempre al centro: è la pista a scorrere sotto
    const center = () => setView(midX(cur), midY(cur), tv.w);

    function fitRange(a, b) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = a; i <= b; i++) { x0 = Math.min(x0, midX(i)); x1 = Math.max(x1, midX(i)); y0 = Math.min(y0, midY(i)); y1 = Math.max(y1, midY(i)); }
      // centrata sul pallino: larga abbastanza da contenere tutto il tratto anche da lì
      const cx = midX(cur), cy = midY(cur);
      const w = Math.max(50, Math.max(2 * Math.max(x1 - cx, cx - x0), (2 * Math.max(y1 - cy, cy - y0) * TW) / TH) * 1.1 + TRACK_W);
      setView(cx, cy, w);
    }

    // punto della pista più vicino al dito; a parità preferisce i punti vicini al pallino (tornanti, incroci)
    function nearest(fx, fy, px, py, penalty) {
      let best = cur, bc = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = fx(i) - px, dy = fy(i) - py, p = circ(i, cur) * penalty;
        const c = dx * dx + dy * dy + p * p;
        if (c < bc) { bc = c; best = i; }
      }
      return best;
    }

    // trascinamento su un svg: tocco breve senza movimento = onTap, altrimenti scorre lungo la pista.
    // pan: invece di inseguire il dito si trascina la pista stessa (la vista è sempre centrata sul pallino)
    function scrub(svg, toIndex, onTap, pan) {
      let down = null;
      const at = (e) => {
        const p = svg.createSVGPoint();
        p.x = e.clientX; p.y = e.clientY;
        return p.matrixTransform(svg.getScreenCTM().inverse());
      };
      svg.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // niente selezione del testo né scorrimento della pagina durante il trascinamento
        down = { x: e.clientX, y: e.clientY, moved: false, target: e.target, cx: midX(cur), cy: midY(cur), s: svg.getScreenCTM().a || 1 };
        svg.setPointerCapture(e.pointerId);
      });
      svg.addEventListener("pointermove", (e) => {
        if (!down) return;
        if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
        down.moved = true;
        if (pan) { hover(toIndex(down.cx - (e.clientX - down.x) / down.s, down.cy - (e.clientY - down.y) / down.s), "drag"); return; }
        const p = at(e);
        hover(toIndex(p.x, p.y), "drag");
      });
      const up = (e) => {
        if (down && !down.moved && !(onTap && onTap(down.target))) { const p = at(e); hover(toIndex(p.x, p.y), "drag"); }
        down = null;
      };
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", () => (down = null));
    }

    // distanza tra le due linee nel punto: più interna / più esterna in curva
    function lateral(i) {
      let bd = Infinity, side = 0, bj = i;
      for (let j = Math.max(0, i - 15); j < Math.min(n - 1, i + 15); j++) {
        const dx = B.x[j + 1] - B.x[j], dz = B.z[j + 1] - B.z[j], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((A.x[i] - B.x[j]) * dx + (A.z[i] - B.z[j]) * dz) / L2));
        const vx = A.x[i] - (B.x[j] + t * dx), vz = A.z[i] - (B.z[j] + t * dz), d = Math.hypot(vx, vz);
        if (d < bd) { bd = d; side = Math.sign(dx * vz - dz * vx); bj = j; }
      }
      if (bd < 0.3) return "stessa linea";
      const j0 = Math.max(0, bj - 4), j1 = Math.min(n - 1, bj + 4);
      const h1x = B.x[bj] - B.x[j0], h1z = B.z[bj] - B.z[j0], h2x = B.x[j1] - B.x[bj], h2z = B.z[j1] - B.z[bj];
      const turn = Math.asin(Math.max(-1, Math.min(1, (h1x * h2z - h1z * h2x) / ((Math.hypot(h1x, h1z) * Math.hypot(h2x, h2z)) || 1))));
      const curv = turn / Math.max(1, (j1 - j0) * step * 0.5);
      if (Math.abs(curv) < 1 / 400) return `${bd.toFixed(1)} m di lato`;
      return `${bd.toFixed(1)} m più ${side === Math.sign(curv) ? "interna" : "esterna"}`;
    }

    function drawList() {
      const mxg = Math.max(0.001, ...MS.map((m) => Math.abs(m.g)));
      const order = [...MS.keys()];
      document.getElementById("cmpList").innerHTML = order.map((i) => {
        const m = MS[i];
        const w = (Math.abs(m.g) / mxg) * 50;
        return `<button class="ms ${sel === i ? "on" : ""}" data-i="${i}">
          <span class="ms-n" title="${esc(m.real || m.name)}">${m.real ? `<i class="ms-k">${i + 1}</i>${esc(m.real)}` : esc(m.name)}</span>
          <span class="ms-bar"><i style="background:${col(m.g)};${m.g > 0 ? "left:50%" : "right:50%"};width:${w}%"></i></span>
          <span class="ms-v" style="color:${col(m.g)}">${sign(m.g)}${Math.abs(m.g).toFixed(3)}</span></button>`;
      }).join("");
      document.querySelectorAll("#cmpList .ms").forEach((b) => b.addEventListener("click", () => select(+b.dataset.i)));
    }

    let W = 1000;
    const L = 46, R = 8;
    const CH = [
      { id: "d", t: "Distacco (s) · sopra lo zero perdi", h: 120 },
      { id: "v", t: "Velocità (km/h)", h: 170 },
      { id: "th", t: "Gas", h: 80 },
      { id: "b", t: "Freno", h: 80 },
      { id: "s", t: "Sterzo · sopra destra, sotto sinistra", h: 100 },
    ];
    const X = (i) => L + ((i - r0) / Math.max(1, r1 - r0)) * (W - L - R);
    const line = (arr, lo, hi, h) => {
      let s = "";
      const every = Math.max(1, Math.floor((r1 - r0) / 700));
      for (let i = r0; i <= r1; i += every) s += (i === r0 ? "M" : "L") + X(i).toFixed(1) + "," + (5 + (1 - (arr[i] - lo) / (hi - lo)) * (h - 10)).toFixed(1);
      return s;
    };

    function drawCharts() {
      const box = document.getElementById("cmpCharts");
      if (!box) return;
      W = Math.max(300, Math.round(box.clientWidth - 24)); // disegno alla larghezza vera: scritte non deformate
      let out = "";
      for (const c of CH) {
        let body = "";
        if (c.id === "d") {
          let lo = -0.02, hi = 0.02;
          const XDl = XD.map((d) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = d.T.t[i] - B.t[i]; return a; });
          for (let i = r0; i <= r1; i++) { lo = Math.min(lo, D[i]); hi = Math.max(hi, D[i]); for (const a of XDl) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } }
          const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
          const Y = (v) => 5 + (1 - (v - lo) / (hi - lo)) * (c.h - 10);
          const z = Y(0);
          let pos = `M${X(r0)},${z}`, neg = pos;
          const every = Math.max(1, Math.floor((r1 - r0) / 700));
          for (let i = r0; i <= r1; i += every) {
            pos += `L${X(i).toFixed(1)},${Y(Math.max(0, D[i])).toFixed(1)}`;
            neg += `L${X(i).toFixed(1)},${Y(Math.min(0, D[i])).toFixed(1)}`;
          }
          pos += `L${X(r1)},${z}Z`; neg += `L${X(r1)},${z}Z`;
          body = `<path d="${pos}" fill="var(--red)" opacity="0.28"/><path d="${neg}" fill="var(--green)" opacity="0.28"/>
            <line x1="${L}" x2="${W - R}" y1="${z}" y2="${z}" stroke="var(--line-2)"/>
            ${XDl.map((a, j) => `<path d="${line(a, lo, hi, c.h)}" fill="none" stroke="${XD[j].c}" stroke-width="1.3" opacity="0.9"/>`).join("")}
            <path d="${line(D, lo, hi, c.h)}" fill="none" stroke="var(--text)" stroke-width="1.6"/>
            <text x="${L - 6}" y="${Y(hi) + 12}" text-anchor="end" class="lbl">+${hi.toFixed(2)}</text>
            <text x="${L - 6}" y="${z + 4}" text-anchor="end" class="lbl">0</text>
            <text x="${L - 6}" y="${Y(lo) - 2}" text-anchor="end" class="lbl">${lo.toFixed(2)}</text>`;
        } else {
          const f = c.id === "v" ? "speed" : c.id === "th" ? "thr" : c.id === "s" ? "steer" : "brk";
          const pair = [B[f], A[f]], xs = XD.map((d) => d.T[f]);
          let lo = c.id === "s" ? -1.05 : 0, hi = 1.05;
          if (c.id === "v") {
            lo = Infinity; hi = -Infinity;
            for (let i = r0; i <= r1; i++) for (const a of [...pair, ...xs]) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
            lo = Math.max(0, lo - 10); hi += 10;
          }
          const mid = 5 + (1 - (0 - lo) / (hi - lo)) * (c.h - 10);
          body = (c.id === "s" ? `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" stroke="var(--line-2)"/>` : "") +
            xs.map((a, j) => `<path d="${line(a, lo, hi, c.h)}" fill="none" stroke="${XD[j].c}" stroke-width="1.3" opacity="0.9"/>`).join("") +
            `<path d="${line(pair[0], lo, hi, c.h)}" fill="none" stroke="var(--purple)" stroke-width="1.6"/>
            <path d="${line(pair[1], lo, hi, c.h)}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>` +
            (c.id === "s"
              ? `<text x="${L - 6}" y="16" text-anchor="end" class="lbl">Dx</text><text x="${L - 6}" y="${mid + 4}" text-anchor="end" class="lbl">0</text><text x="${L - 6}" y="${c.h - 4}" text-anchor="end" class="lbl">Sx</text>`
              : c.id === "v"
              ? `<text x="${L - 6}" y="16" text-anchor="end" class="lbl">${Math.round(hi)}</text><text x="${L - 6}" y="${c.h - 4}" text-anchor="end" class="lbl">${Math.round(lo)}</text>`
              : `<text x="${L - 6}" y="16" text-anchor="end" class="lbl">100%</text>`);
        }
        out += `<div class="sub-label"><span>${c.t}</span>${c.id === "d" ? `<span>${Math.round(r0 * step)}–${Math.round(r1 * step)} m${sel !== null ? ` · <a href="#" id="cmpAll">giro intero</a>` : ""}</span>` : ""}</div>
          <svg class="cmp-chart" viewBox="0 0 ${W} ${c.h}" width="${W}" height="${c.h}">
            <rect x="${L}" y="0" width="${W - L - R}" height="${c.h}" rx="6" fill="var(--bg-2)"/>${body}
            <line class="cur" x1="-5" x2="-5" y1="0" y2="${c.h}" stroke="var(--text)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
      }
      box.innerHTML = out;
      const all = document.getElementById("cmpAll");
      if (all) all.addEventListener("click", (e) => { e.preventDefault(); select(sel); });
      box.querySelectorAll("svg.cmp-chart").forEach((s) => {
        const move = (e) => {
          const r = s.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.max(r0, Math.min(r1, Math.round(r0 + ((px - L) / (W - L - R)) * (r1 - r0))));
          hover(i);
        };
        s.addEventListener("pointermove", move);
        s.addEventListener("pointerdown", move);
      });
      hover(cur, "init");
    }

    // src: "chart" (cursore sui grafici), "drag" (pallino sulla pista), "init"
    function hover(i, src = "chart") {
      if (i == null) return;
      cur = i;
      if (sel !== null && (i < r0 || i > r1)) { sel = null; r0 = 0; r1 = n - 1; drawMap(); drawList(); drawCharts(); }
      document.querySelectorAll("#cmpCharts .cur").forEach((l) => {
        const xx = X(i);
        l.setAttribute("x1", xx); l.setAttribute("x2", xx);
      });
      placeDots();
      if (src !== "init") center();
      const st = (v) => (Math.abs(v) < 0.02 ? "0" : `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? "dx" : "sx"}`);
      const br = A.brk[i] > 0.03 || B.brk[i] > 0.03 ? ` · freno ${Math.round(A.brk[i] * 100)}% / ${Math.round(B.brk[i] * 100)}%` : "";
      document.getElementById("cmpRead").textContent =
        `${Math.round(i * step)} m · ${me.nick} ${Math.round(A.speed[i])} km/h ${A.gear[i]}ª · ${ref.nick} ${Math.round(B.speed[i])} km/h ${B.gear[i]}ª · Δ ${D[i] >= 0 ? "+" : ""}${D[i].toFixed(3)} s${XD.map((d) => { const x = d.T.t[i] - B.t[i]; return ` · ${d.nick} ${Math.round(d.T.speed[i])} km/h ${gearTxt(d.T.gear[i])} Δ ${x >= 0 ? "+" : ""}${x.toFixed(3)} s`; }).join("")}${br} · sterzo ${st(A.steer[i])} / ${st(B.steer[i])} · linea ${me.nick}: ${lateral(i)}`;
    }

    function select(i) {
      sel = sel === i ? null : i;
      if (sel === null) { r0 = 0; r1 = n - 1; }
      else {
        const m = MS[sel];
        r0 = Math.max(0, m.a - Math.round(60 / step));
        r1 = Math.min(n - 1, m.b + Math.round(20 / step));
        cur = m.apex ?? Math.round((m.a + m.b) / 2);
        fitRange(m.a, m.b);
      }
      drawMap(); drawList(); drawCharts();
    }

    // partenza: la curva dove si perde di più, già ingrandita
    const worst = MS.reduce((w, m) => (m.g > w.g ? m : w), MS[0]);
    cur = worst.apex ?? Math.round((worst.a + worst.b) / 2);
    fitRange(Math.max(0, cur - Math.round(120 / step)), Math.min(n - 1, cur + Math.round(120 / step)));
    drawMap(); drawTraj(); drawList(); drawCharts();

    scrub(document.getElementById("cmpMap"), (px, py) => nearest(mx, my, px, py, step * k * 0.05),
      (t) => { if (t.dataset && t.dataset.i != null) { select(+t.dataset.i); return true; } return false; });
    scrub(document.getElementById("cmpTraj"), (px, py) => nearest(midX, midY, px, py, step * 0.1), null, true);
    el.querySelectorAll(".cmp-traj .seg button").forEach((b) => b.addEventListener("click", () => {
      tmode = b.dataset.c;
      el.querySelectorAll(".cmp-traj .seg button").forEach((x) => x.classList.toggle("on", x === b));
      drawTraj();
    }));
    el.querySelectorAll(".cmp-traj .zbtn").forEach((b) => b.addEventListener("click", () => {
      let z = ZOOMS.findIndex((w) => w >= tv.w - 0.5);
      if (z < 0) z = ZOOMS.length - 1;
      else if (ZOOMS[z] > tv.w + 0.5 && +b.dataset.z > 0) z--; // da una vista "su misura" il primo − porta al livello sopra
      z = Math.max(0, Math.min(ZOOMS.length - 1, z + +b.dataset.z));
      setView(midX(cur), midY(cur), ZOOMS[z]);
    }));
    // avanti/indietro di un campione alla volta; tenendo premuto scorre sempre più veloce
    // il giro è un anello: dal traguardo indietro si va alla fine, dalla fine avanti si riparte
    const nudge = (d) => hover((((cur + d) % n) + n) % n, "drag");
    el.querySelectorAll(".cmp-steps .sbtn").forEach((b) => {
      let t = null;
      const stop = () => { clearTimeout(t); t = null; };
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const d = +b.dataset.d;
        let k = 0;
        nudge(d);
        const rep = () => { k++; nudge(d); t = setTimeout(rep, k > 20 ? 25 : 70); };
        t = setTimeout(rep, 400);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, stop));
    });
    const onKey = (e) => {
      if (!document.body.contains(el)) return window.removeEventListener("keydown", onKey);
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
      e.preventDefault();
      nudge(e.key === "ArrowLeft" ? -1 : 1);
    };
    if (el._cmpKey) window.removeEventListener("keydown", el._cmpKey); // ridisegno nello stesso contenitore
    el._cmpKey = onKey;
    window.addEventListener("keydown", onKey);
    let lastW = el.clientWidth;
    const onResize = () => {
      if (!document.body.contains(el) || !document.getElementById("cmpCharts")) return window.removeEventListener("resize", onResize);
      if (Math.abs(el.clientWidth - lastW) > 8) { lastW = el.clientWidth; drawCharts(); }
    };
    window.addEventListener("resize", onResize);
  }

  window.LMU_COMPARE = { decode, render, microsectors };
})();
