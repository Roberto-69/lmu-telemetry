// Dati finti ma realistici per vedere l'app senza giri nel database (?demo=1 oppure pulsante "Demo").
// Producono gli stessi campi della vista v_laps di Supabase.
(function () {
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TRACKS = [
    { name: "Circuit de la Sarthe", len: 13626, base: 204.2, split: [0.19, 0.46, 0.35] },
    { name: "Circuit de Spa-Francorchamps", len: 7004, base: 122.4, split: [0.31, 0.36, 0.33] },
    { name: "Autodromo Nazionale Monza", len: 5793, base: 96.1, split: [0.33, 0.33, 0.34] },
    { name: "Fuji Speedway", len: 4563, base: 88.6, split: [0.38, 0.3, 0.32] },
    { name: "Bahrain International Circuit", len: 5412, base: 106.3, split: [0.3, 0.4, 0.3] },
    { name: "Autodromo Enzo e Dino Ferrari", len: 4909, base: 92.4, split: [0.34, 0.34, 0.32] },
    { name: "Autódromo Internacional do Algarve", len: 4653, base: 91.2, split: [0.33, 0.35, 0.32] },
    { name: "Circuit of the Americas", len: 5513, base: 107.1, split: [0.3, 0.38, 0.32] },
    { name: "Sebring International Raceway", len: 6019, base: 108.4, split: [0.33, 0.34, 0.33] },
    { name: "Lusail International Circuit", len: 5380, base: 100.2, split: [0.34, 0.33, 0.33] },
  ];

  const CARS = [
    { model: "Ferrari 499P", cls: "Hypercar", k: 1.0 },
    { model: "Porsche 963", cls: "Hypercar", k: 1.002 },
    { model: "Toyota GR010 Hybrid", cls: "Hypercar", k: 1.001 },
    { model: "Cadillac V-Series.R", cls: "Hypercar", k: 1.003 },
    { model: "BMW M Hybrid V8", cls: "Hypercar", k: 1.004 },
    { model: "Alpine A424", cls: "Hypercar", k: 1.003 },
    { model: "Peugeot 9X8", cls: "Hypercar", k: 1.005 },
    { model: "Oreca 07 Gibson", cls: "LMP2", k: 1.062 },
    { model: "Ferrari 296 LMGT3", cls: "LMGT3", k: 1.134 },
    { model: "Porsche 911 GT3 R LMGT3", cls: "LMGT3", k: 1.136 },
    { model: "BMW M4 LMGT3", cls: "LMGT3", k: 1.137 },
    { model: "Aston Martin Vantage AMR LMGT3", cls: "LMGT3", k: 1.138 },
    { model: "Corvette Z06 LMGT3.R", cls: "LMGT3", k: 1.135 },
    { model: "McLaren 720S LMGT3 Evo", cls: "LMGT3", k: 1.137 },
  ];

  const DRIVERS = [
    { nick: "SIXTYNINE", skill: 0.004 },
    { nick: "Albo", skill: 0.009 },
    { nick: "Brake_Late", skill: 0.006 },
    { nick: "Ghigo", skill: 0.014 },
    { nick: "Nebbia", skill: 0.011 },
    { nick: "RedLine", skill: 0.007 },
    { nick: "Kappa", skill: 0.018 },
    { nick: "Tox", skill: 0.012 },
  ];

  const TYRES = ["Soft", "Medium", "Medium", "Hard"];

  function generate() {
    const r = rng(6919);
    const now = Date.now();
    const laps = [];
    let id = 1;

    DRIVERS.forEach((d, di) => {
      const driverId = "demo-d" + di;
      const fav = CARS.filter((c) => c.cls === "Hypercar")[Math.floor(r() * 7)];
      const gt3 = CARS.filter((c) => c.cls === "LMGT3")[Math.floor(r() * 6)];
      TRACKS.forEach((t, ti) => {
        if (r() < 0.22 && d.nick !== "SIXTYNINE") return; // non tutti girano ovunque
        const cars = [fav];
        if (r() < 0.45) cars.push(gt3);
        if (r() < 0.18) cars.push(CARS[7]);
        cars.forEach((c) => {
          const carId = CARS.indexOf(c) + 1;
          const sessions = 1 + Math.floor(r() * 4);
          for (let s = 0; s < sessions; s++) {
            const daysAgo = Math.floor(r() * 55) + (sessions - s) * 3;
            const sessionStart = now - daysAgo * 86400000 - Math.floor(r() * 20) * 3600000;
            const learning = (sessions - s - 1) * 0.0025; // si migliora sessione dopo sessione
            const laps_n = 5 + Math.floor(r() * 10);
            const temp = 18 + Math.floor(r() * 22);
            let fuel = 30 + r() * 55;
            let ve = c.cls === "LMP2" ? 0 : 0.55 + r() * 0.45;
            const tyre = TYRES[Math.floor(r() * TYRES.length)];
            for (let n = 1; n <= laps_n; n++) {
              const pit = n === 1;
              const noise = (r() - 0.35) * 0.012 + (r() < 0.1 ? r() * 0.02 : 0);
              const lt = t.base * c.k * (1 + d.skill + learning + noise + (pit ? 0.06 : 0));
              const sn = t.split.map((p) => p * (1 + (r() - 0.5) * 0.012));
              const sum = sn.reduce((a, b) => a + b, 0);
              const s1 = (lt * sn[0]) / sum;
              const s2 = (lt * sn[1]) / sum;
              const s3 = lt - s1 - s2;
              const invalid = !pit && r() < 0.1;
              const round3 = (x) => Math.round(x * 1000) / 1000;
              laps.push({
                id: id++,
                driver_id: driverId,
                nick: d.nick,
                track_id: ti + 1,
                track: t.name,
                length_m: t.len,
                track_display: t.name,
                car_id: carId,
                car: c.model,
                car_class: c.cls,
                session_type: s % 3 === 2 ? "qualify" : "practice",
                online: r() < 0.3,
                game_version: 1250,
                lap_no: n,
                lap_time: round3(lt),
                s1: round3(s1),
                s2: round3(s2),
                s3: round3(s3),
                valid: !pit && !invalid,
                invalidated: invalid,
                pit_lap: pit,
                fuel_start: Math.round(fuel * 10) / 10,
                ve_start: Math.round(ve * 1000) / 1000,
                tyre_front: tyre,
                tyre_rear: tyre,
                tyre_wear: pit ? null : [0, 1, 2, 3].map((i) => Math.round(t.len / 1000 * (i < 2 ? 0.16 : 0.12) * (0.85 + r() * 0.3) * 1000) / 1000),
                air_temp: temp - 8,
                track_temp: temp,
                grip_level: Math.min(4, 1 + Math.floor(n / 4)),
                driven_at: new Date(sessionStart + n * lt * 1000).toISOString(),
              });
              fuel = Math.max(2, fuel - t.len / 1000 * 0.38);
              if (ve) ve = Math.max(0.02, ve - t.len / 1000 * 0.0105);
            }
          }
        });
      });
    });
    return laps;
  }

  // Telemetria finta del giro migliore: pista inventata (fissa per pista), stile di guida diverso per pilota.
  // Restituisce lo stesso oggetto di LMU_COMPARE.decode().
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function trace(row) {
    const len = row.length_m || 5000;
    const STEP = 5;
    const tr = rng(hash("track" + row.track_id));
    // pista: rettilinei e curve con curvatura casuale, chiusa a forza alla fine
    const segs = [];
    let used = 0;
    while (used < len) {
      const straight = 150 + tr() * 650;
      const corner = 60 + tr() * 160;
      const radius = (tr() < 0.75 ? 1 : -1) * (25 + tr() * 140);
      segs.push([straight, 0], [corner, 1 / radius]);
      used += straight + corner;
    }
    const k = len / used;
    let turn = 0;
    segs.forEach((sg) => { sg[0] *= k; turn += sg[0] * sg[1]; });
    const fix = (2 * Math.PI) / turn;
    segs.forEach((sg) => (sg[1] *= fix));
    const n = Math.floor(len / STEP) + 1;
    const curv = new Float64Array(n), corner = new Int32Array(n);
    const x = new Float64Array(n), z = new Float64Array(n);
    let si = 0, left = segs[0][0], h = 0, px = 0, pz = 0, cn = 0;
    for (let i = 0; i < n; i++) {
      while (left <= 0 && si < segs.length - 1) { si++; left += segs[si][0]; if (segs[si][1]) cn++; }
      curv[i] = segs[si][1];
      corner[i] = segs[si][1] ? cn : 0;
      h += curv[i] * STEP;
      px += Math.cos(h) * STEP; pz += Math.sin(h) * STEP;
      x[i] = px; z[i] = pz;
      left -= STEP;
    }
    for (let i = 0; i < n; i++) { x[i] -= (px * i) / n; z[i] -= (pz * i) / n; }
    // pilota: aderenza diversa curva per curva, frenata più o meno decisa
    const dr = rng(hash("drv" + row.driver_id + "|" + row.car_id + "|" + row.track_id));
    const lat = [];
    for (let c = 0; c <= cn; c++) lat.push(28 + dr() * 3.5);
    const brakeDecel = 31 + dr() * 6;
    const vmax = 88;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = curv[i] ? Math.min(vmax, Math.sqrt(lat[corner[i]] / Math.abs(curv[i]))) : vmax;
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * brakeDecel * STEP));
    const o = new Float64Array(n);
    o[0] = Math.min(v[0], 70);
    for (let i = 0; i < n - 1; i++) {
      const acc = 11 * (1 - o[i] / 95);
      o[i + 1] = Math.min(v[i + 1], Math.sqrt(o[i] ** 2 + 2 * acc * STEP));
    }
    const t = new Float64Array(n);
    for (let i = 1; i < n; i++) t[i] = t[i - 1] + (2 * STEP) / (o[i] + o[i - 1]);
    const scale = (row.best || row.lap_time || t[n - 1]) / (t[n - 1] + STEP / o[n - 1]);
    const speed = new Float64Array(n), thr = new Float64Array(n), brk = new Float64Array(n);
    const steer = new Float64Array(n), gear = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] *= scale;
      const ms = o[i] / scale;
      speed[i] = ms * 3.6;
      const j = Math.min(i, n - 2);
      const a = (o[j + 1] ** 2 - o[j] ** 2) / (2 * STEP);
      brk[i] = a < -1 ? Math.min(1, -a / brakeDecel) : 0;
      thr[i] = a < -1 ? 0 : a > 0.4 ? 1 : 0.5;
      steer[i] = Math.max(-1, Math.min(1, curv[i] * 30));
      gear[i] = Math.max(1, Math.min(7, Math.ceil(speed[i] / 45)));
    }
    return { n, step: STEP, t, speed, thr, brk, steer, gear, x, z };
  }

  window.LMU_DEMO = { generate, trace };
})();
