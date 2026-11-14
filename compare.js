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

  // ---------------------------------------------------------------- disegno
  const fmt = (t) => {
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
  };
  const sign = (d) => (d > 0.0005 ? "+" : d < -0.0005 ? "−" : "");
  const col = (g) => (Math.abs(g) < 0.005 ? "var(--faint)" : g > 0 ? "var(--red)" : "var(--green)");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** me, ref: { trace, nick, lap } ; el: contenitore ; opts.onPickOther(key) */
  function render(el, me, ref, opts = {}) {
    const A = me.trace, B = ref.trace;
    const n = Math.min(A.n, B.n);
    const step = B.step;
    const D = new Float64Array(n);
    for (let i = 0; i < n; i++) D[i] = A.t[i] - B.t[i];
    const MS = microsectors(B, n);
    MS.forEach((m) => (m.g = D[m.b] - D[m.a]));
    const gap = me.lap - ref.lap;

    // mappa (vista dall'alto: x a destra, z verso l'alto)
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
      mnx = Math.min(mnx, B.x[i]); mxx = Math.max(mxx, B.x[i]);
      mnz = Math.min(mnz, B.z[i]); mxz = Math.max(mxz, B.z[i]);
    }
    const MW = 400, MH = 300, pad = 14;
    const k = Math.min((MW - 2 * pad) / Math.max(1, mxx - mnx), (MH - 2 * pad) / Math.max(1, mxz - mnz));
    const ox = (MW - (mxx - mnx) * k) / 2, oy = (MH - (mxz - mnz) * k) / 2;
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
    const others = opts.others || [];

    // traiettoria: vista ingrandita in metri (X = x, Y = -z), linea di mezzo tra i due giri per la fascia della pista
    const TW = 400, TH = 300, TRACK_W = 13;
    const midX = (i) => (A.x[i] + B.x[i]) / 2, midY = (i) => -(A.z[i] + B.z[i]) / 2;
    let tv = { cx: 0, cy: 0, w: 160 }, tmode = "drv";
    const ZOOMS = [50, 80, 120, 160, 240, 360, 540, 800];
    const circ = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };

    el.innerHTML = `
      <div class="cmp-head">
        <div class="mini"><div class="k"><span class="sw me"></span>${esc(me.nick)}</div><div class="v">${fmt(me.lap)}</div></div>
        <div class="mini"><div class="k"><span class="sw ref"></span>${esc(ref.nick)}${opts.refIsRecord ? " · record" : ""}</div><div class="v">${fmt(ref.lap)}</div></div>
        <div class="mini"><div class="k">Distacco</div><div class="v" style="color:${col(gap)}">${sign(gap)}${Math.abs(gap).toFixed(3)}</div></div>
        ${others.length ? `<label class="cmp-pick"><span>Confronta con</span><select id="cmpOther">${others.map((o) => `<option value="${esc(o.key)}" ${o.key === opts.refKey ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="cmp-top">
        <div class="panel cmp-map"><svg id="cmpMap" viewBox="0 0 ${MW} ${MH}"></svg>
          <div class="cmp-steps"><button class="sbtn" data-d="1" aria-label="Avanti di un passo" title="Avanti (→) · tieni premuto per scorrere">▲</button><button class="sbtn" data-d="-1" aria-label="Indietro di un passo" title="Indietro (←) · tieni premuto per scorrere">▼</button></div></div>
        <div class="panel cmp-traj">
          <div class="panel-head"><h2>Traiettoria</h2>
            <div class="traj-tools">
              <span class="seg"><button data-c="drv" class="on">Piloti</button><button data-c="ped">Gas/freno</button></span>
              <button class="zbtn" data-z="1" aria-label="Allontana">−</button><button class="zbtn" data-z="-1" aria-label="Avvicina">+</button>
            </div>
          </div>
          <svg id="cmpTraj" viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="xMidYMid meet"></svg>
          <div class="traj-leg" id="trajLeg"></div>
        </div>
        <div class="panel cmp-ms">
          <div class="panel-head"><h2>Microsettori</h2><span class="hint">tocca per ingrandire</span></div>
          <div id="cmpList"></div>
        </div>
      </div>
      <div class="cmp-readout" id="cmpRead">Passa sul grafico o trascina il pallino sulla pista per leggere i valori</div>
      <div class="panel cmp-charts" id="cmpCharts"></div>
      <div class="cmp-legend"><span><i class="sw me"></i>${esc(me.nick)}</span><span><i class="sw ref"></i>${esc(ref.nick)}</span><span><i class="sq" style="background:var(--green)"></i>guadagni</span><span><i class="sq" style="background:var(--red)"></i>perdi</span></div>`;

    const pick = document.getElementById("cmpOther");
    if (pick && opts.onPickOther) pick.addEventListener("change", () => opts.onPickOther(pick.value));

    function drawMap() {
      let s = `<polyline points="${pts(0, n - 1)}" fill="none" stroke="var(--line-2)" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>`;
      MS.forEach((m, i) => {
        s += `<polyline data-i="${i}" points="${pts(m.a, m.b)}" fill="none" stroke="${col(m.g)}" stroke-width="${sel === i ? 6 : 4}" stroke-linejoin="round" stroke-linecap="round" opacity="${sel === null || sel === i ? 1 : 0.3}" style="cursor:pointer"/>`;
      });
      MS.forEach((m, i) => {
        if (m.apex == null) return;
        s += `<text x="${(mx(m.apex) + 9).toFixed(1)}" y="${(my(m.apex) - 7).toFixed(1)}" class="cmp-num">${i + 1}</text>`;
      });
      s += `<rect x="${(mx(0) - 2).toFixed(1)}" y="${(my(0) - 9).toFixed(1)}" width="4" height="18" fill="var(--text)"/>`;
      s += `<rect id="cmpView" fill="none" stroke="var(--text)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`;
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
        s += `<polyline points="${pts2(bx, by, 0, n - 1)}" stroke="var(--purple)" stroke-width="2.4" ${ln}/>
          <polyline points="${pts2(ax, ay, 0, n - 1)}" stroke="var(--accent)" stroke-width="2.4" ${ln}/>`;
      } else {
        // verde gas pieno, rosso freno, bianco rilascio o gas parziale; il riferimento è tratteggiato
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
        s += runs(B, bx, by, `stroke-width="2" stroke-dasharray="5 4"`) + runs(A, ax, ay, `stroke-width="2.6"`);
      }
      s += `<circle id="trajRef" fill="var(--purple)" stroke="var(--bg)"/><circle id="trajMe" fill="var(--accent)" stroke="var(--bg)"/>`;
      // nome del pilota accanto al suo pallino, nello stesso colore
      const lbl = `font-weight="700" stroke="var(--bg)" paint-order="stroke" stroke-linejoin="round" dominant-baseline="middle"`;
      s += `<text id="trajRefLbl" fill="var(--purple)" ${lbl}>${esc(ref.nick)}</text><text id="trajMeLbl" fill="var(--accent)" ${lbl}>${esc(me.nick)}</text>`;
      document.getElementById("cmpTraj").innerHTML = s;
      document.getElementById("trajLeg").innerHTML = tmode === "drv"
        ? `<span><i class="sw me"></i>${esc(me.nick)}</span><span><i class="sw ref"></i>${esc(ref.nick)}</span><span class="traj-note">bordi pista indicativi</span>`
        : `<span><i class="sq" style="background:var(--green)"></i>gas pieno</span><span><i class="sq" style="background:#e8ecf3"></i>rilascio / parziale</span><span><i class="sq" style="background:var(--red)"></i>freno</span><span>linea piena ${esc(me.nick)}, tratteggio ${esc(ref.nick)}</span>`;
      setView(tv.cx, tv.cy, tv.w);
      placeDots();
    }

    function setView(cx, cy, w) {
      tv = { cx, cy, w };
      const h = (w * TH) / TW;
      const svg = document.getElementById("cmpTraj");
      svg.setAttribute("viewBox", `${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);
      const r = (w / TW) * 6;
      for (const id of ["trajMe", "trajRef"]) {
        const c = document.getElementById(id);
        if (c) { c.setAttribute("r", (id === "trajMe" ? r : r * 0.8).toFixed(2)); c.setAttribute("stroke-width", (r / 3).toFixed(2)); }
        const t = document.getElementById(id + "Lbl");
        if (t) { t.setAttribute("font-size", (r * 2).toFixed(2)); t.setAttribute("stroke-width", (r / 2).toFixed(2)); }
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
      set("trajMe", A.x[cur], -A.z[cur]);
      set("trajRef", B.x[cur], -B.z[cur]);
      set("cmpDot", mx(cur), my(cur));
      // etichette ai lati opposti: chi sta più a destra ha il nome a destra
      const r = (tv.w / TW) * 6, meRight = A.x[cur] >= B.x[cur];
      const lab = (id, x, y, right) => {
        const t = document.getElementById(id);
        if (!t) return;
        t.setAttribute("x", (x + (right ? 1 : -1) * r * 1.8).toFixed(2));
        t.setAttribute("y", y.toFixed(2));
        t.setAttribute("text-anchor", right ? "start" : "end");
      };
      lab("trajMeLbl", A.x[cur], -A.z[cur], meRight);
      lab("trajRefLbl", B.x[cur], -B.z[cur], !meRight);
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
          <span class="ms-n">${esc(m.name)}</span>
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
          for (let i = r0; i <= r1; i++) { lo = Math.min(lo, D[i]); hi = Math.max(hi, D[i]); }
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
            <path d="${line(D, lo, hi, c.h)}" fill="none" stroke="var(--text)" stroke-width="1.6"/>
            <text x="${L - 6}" y="${Y(hi) + 12}" text-anchor="end" class="lbl">+${hi.toFixed(2)}</text>
            <text x="${L - 6}" y="${z + 4}" text-anchor="end" class="lbl">0</text>
            <text x="${L - 6}" y="${Y(lo) - 2}" text-anchor="end" class="lbl">${lo.toFixed(2)}</text>`;
        } else {
          const pair = c.id === "v" ? [B.speed, A.speed] : c.id === "th" ? [B.thr, A.thr] : c.id === "s" ? [B.steer, A.steer] : [B.brk, A.brk];
          let lo = c.id === "s" ? -1.05 : 0, hi = 1.05;
          if (c.id === "v") {
            lo = Infinity; hi = -Infinity;
            for (let i = r0; i <= r1; i++) { lo = Math.min(lo, pair[0][i], pair[1][i]); hi = Math.max(hi, pair[0][i], pair[1][i]); }
            lo = Math.max(0, lo - 10); hi += 10;
          }
          const mid = 5 + (1 - (0 - lo) / (hi - lo)) * (c.h - 10);
          body = (c.id === "s" ? `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" stroke="var(--line-2)"/>` : "") +
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
        `${Math.round(i * step)} m · ${me.nick} ${Math.round(A.speed[i])} km/h ${A.gear[i]}ª · ${ref.nick} ${Math.round(B.speed[i])} km/h ${B.gear[i]}ª · Δ ${D[i] >= 0 ? "+" : ""}${D[i].toFixed(3)} s${br} · sterzo ${st(A.steer[i])} / ${st(B.steer[i])} · linea ${me.nick}: ${lateral(i)}`;
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
    const nudge = (d) => hover(Math.max(0, Math.min(n - 1, cur + d)), "drag");
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
