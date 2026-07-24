// Dev talks directly to the local backend port; a real build talks to
// the public API path nginx proxies to it -- see
// installer/assets/nginx-panel.conf.template's `location /api/` block
// (proxy_pass http://127.0.0.1:4000/), the only public-facing path to
// the backend that exists today.
export const API_BASE_URL = import.meta.env.DEV ? "http://localhost:4000" : "https://connect.neoxify.com/api";
