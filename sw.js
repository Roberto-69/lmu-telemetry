// Cache dell'app per aprirla anche senza rete. I dati (Supabase) passano sempre dalla rete.
const CACHE = "lmu-app-v14";
const SHELL = ["./", "index.html", "licenze.html", "styles.css", "app.js", "config.js", "demo.js", "compare.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Supabase e font: rete normale
  // Prima la rete (così gli aggiornamenti arrivano subito), poi la cache se offline.
  // "no-cache": il browser chiede sempre al server se il file è cambiato (se no non lo riscarica),
  // invece di usare per ~10 minuti la copia tenuta da GitHub Pages.
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
