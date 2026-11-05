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

  window.LMU_DEMO = { generate };
})();
