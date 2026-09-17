// Service worker simples — permite "Instalar" a app no telemóvel (PWA).
// Faz cache só da casca da aplicação (HTML/CSS/JS/ícones), nunca dos
// pedidos ao Supabase — esses vão sempre à rede, para os dados serem
// sempre atuais.
//
// IMPORTANTE: sempre que se muda index.html/app.js/style.css/config.js,
// é preciso subir a versão deste número (ex: v3 -> v4) e voltar a subir
// este ficheiro ao GitHub também. Sem isso, o browser não deteta que o
// service worker mudou, continua a usar a cache antiga, e quem já tem a
// app aberta/instalada não vê as novidades (mesmo depois de o site já
// estar atualizado no GitHub) até fechar e reabrir várias vezes.
const CACHE_NAME = "ponto-proqual-shell-v9";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-apple-touch.png",
  "./favicon.png",
  "./logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  // Nunca fazer cache de pedidos ao Supabase (dados/autenticação/fotos têm de ser sempre em tempo real)
  if (url.includes("supabase.co")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
