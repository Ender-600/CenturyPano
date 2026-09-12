# Predictive walking mobile access

Current HTTPS entry: https://grant-relying-pleasant-column.trycloudflare.com/world/

This serves the full app with predictive panorama generation enabled. Open it
in Safari or Chrome, allow location access, and connect using the existing
app access code in Settings. Then choose **Start panorama walk**. Provider API
keys must not be entered in this page.

The current link is a temporary Cloudflare tunnel. The development computer,
backend, gateway, and tunnel must remain running. A new tunnel gets a new URL.
No access code is stored in this document.

The running backend is on `127.0.0.1:8001`. The dedicated phone gateway forwards
the browser's authorization to that backend and exposes only the world app:

```bash
.venv/bin/python scripts/serve_world_access.py --port 8004 --upstream http://127.0.0.1:8001
/private/tmp/century-cloudflared/cloudflared tunnel --url http://127.0.0.1:8004 --metrics 127.0.0.1:20246 --no-autoupdate --protocol http2
```

Public verification: HTML, JavaScript, prediction controller, and CSS match the
workspace; `/world-config` reports prefetch available. Protected routes require
authorization, `/world-session` returns 403, and legacy APIs are not exposed.
These checks did not submit an image generation request.
