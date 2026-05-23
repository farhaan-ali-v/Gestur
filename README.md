# Gestur

Gestur is a zero-knowledge, kinetic CAPTCHA MVP. The browser performs all gesture recognition client-side via MediaPipe Tasks, while a lightweight Express gatekeeper issues JWT passes.

## Run locally

1. Start the gatekeeper API:
	```bash
	npm run server
	```
2. Start the Vite frontend:
	```bash
	npm run dev
	```

The frontend proxies `/api` to the gatekeeper running on port `3001`.

## Optional configuration

- `JWT_SECRET`: Override the randomly generated JWT signing secret.
- `PORT`: Change the gatekeeper port (defaults to `3001`).
