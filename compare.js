/* LMU Telemetry - confronto della telemetria tra due giri migliori.
 * decode(): legge il formato 1 scritto dal tracker (vedi lmu_tracker/trace.py).
 * render(): mappa con microsettori, distacco lungo il giro, velocità, gas, freno.
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

    let sel = null, r0 = 0, r1 = n - 1;
    const others = opts.others || [];

    el.innerHTML = `
      <div class="cmp-head">
        <div class="mini"><div class="k"><span class="sw me"></span>${esc(me.nick)}</div><div class="v">${fmt(me.lap)}</div></div>
        <div class="mini"><div class="k"><span class="sw ref"></span>${esc(ref.nick)}${opts.refIsRecord ? " · record" : ""}</div><div class="v">${fmt(ref.lap)}</div></div>
        <div class="mini"><div class="k">Distacco</div><div class="v" style="color:${col(gap)}">${sign(gap)}${Math.abs(gap).toFixed(3)}</div></div>
        ${others.length ? `<label class="cmp-pick"><span>Confronta con</span><select id="cmpOther">${others.map((o) => `<option value="${esc(o.key)}" ${o.key === opts.refKey ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="cmp-top">
        <div class="panel cmp-map"><svg id="cmpMap" viewBox="0 0 ${MW} ${MH}"></svg></div>
        <div class="panel cmp-ms">
          <div class="panel-head"><h2>Microsettori</h2><span class="hint">tocca per ingrandire</span></div>
          <div id="cmpList"></div>
        </div>
      </div>
      <div class="cmp-readout" id="cmpRead">Passa sul grafico (o tocca) per leggere i valori</div>
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
      s += `<circle id="cmpDot" r="6" cx="-20" cy="-20" fill="var(--accent)" stroke="var(--bg)" stroke-width="2"/>`;
      const svg = document.getElementById("cmpMap");
      svg.innerHTML = s;
      svg.querySelectorAll("polyline[data-i]").forEach((p) => p.addEventListener("click", () => select(+p.dataset.i)));
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
          const pair = c.id === "v" ? [B.speed, A.speed] : c.id === "th" ? [B.thr, A.thr] : [B.brk, A.brk];
          let lo = 0, hi = 1.05;
          if (c.id === "v") {
            lo = Infinity; hi = -Infinity;
            for (let i = r0; i <= r1; i++) { lo = Math.min(lo, pair[0][i], pair[1][i]); hi = Math.max(hi, pair[0][i], pair[1][i]); }
            lo = Math.max(0, lo - 10); hi += 10;
          }
          body = `<path d="${line(pair[0], lo, hi, c.h)}" fill="none" stroke="var(--purple)" stroke-width="1.6"/>
            <path d="${line(pair[1], lo, hi, c.h)}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>` +
            (c.id === "v"
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
        s.addEventListener("pointerleave", () => hover(null));
      });
    }

    function hover(i) {
      document.querySelectorAll("#cmpCharts .cur").forEach((l) => {
        const xx = i === null ? -5 : X(i);
        l.setAttribute("x1", xx); l.setAttribute("x2", xx);
      });
      const dot = document.getElementById("cmpDot");
      if (!dot) return;
      if (i === null) { dot.setAttribute("cx", -20); return; }
      dot.setAttribute("cx", mx(i)); dot.setAttribute("cy", my(i));
      const br = A.brk[i] > 0.03 || B.brk[i] > 0.03 ? ` · freno ${Math.round(A.brk[i] * 100)}% / ${Math.round(B.brk[i] * 100)}%` : "";
      document.getElementById("cmpRead").textContent =
        `${Math.round(i * step)} m · ${esc(me.nick)} ${Math.round(A.speed[i])} km/h ${A.gear[i]}ª · ${esc(ref.nick)} ${Math.round(B.speed[i])} km/h ${B.gear[i]}ª · Δ ${D[i] >= 0 ? "+" : ""}${D[i].toFixed(3)} s${br}`;
    }

    function select(i) {
      sel = sel === i ? null : i;
      if (sel === null) { r0 = 0; r1 = n - 1; }
      else {
        const m = MS[sel];
        r0 = Math.max(0, m.a - Math.round(60 / step));
        r1 = Math.min(n - 1, m.b + Math.round(20 / step));
      }
      drawMap(); drawList(); drawCharts();
    }

    drawMap(); drawList(); drawCharts();
    let lastW = el.clientWidth;
    const onResize = () => {
      if (!document.body.contains(el) || !document.getElementById("cmpCharts")) return window.removeEventListener("resize", onResize);
      if (Math.abs(el.clientWidth - lastW) > 8) { lastW = el.clientWidth; drawCharts(); }
    };
    window.addEventListener("resize", onResize);
  }

  window.LMU_COMPARE = { decode, render, microsectors };
})();
