# Remote access

ComputeDash includes administrative actions such as credential changes, benchmarks, updates, power controls and model control. The server binds to `127.0.0.1:5555` by default. Variable names keep sparkDash's `SPARKDASH_*` prefix for upstream compatibility.

- [Security model](#security-model)
- [Create the access token](#create-the-access-token)
- [Safest path: local browser or SSH tunnel](#safest-path-local-browser-or-ssh-tunnel)
- [Shared remote access](#shared-remote-access)
- [Embedding the kiosk (Home Assistant)](#embedding-the-kiosk-home-assistant)
- [Docker: privileges and the secrets key](#docker-privileges-and-the-secrets-key)
- [Existing Docker installations](#existing-docker-installations)
- [SSH key mount](#ssh-key-mount)

## Security model

The server tells two kinds of request apart:

- **Direct local**: the request arrives on a loopback socket and carries no proxy forwarding headers (such as `X-Forwarded-For`, `Forwarded` or `Tailscale-User-*`), and its `Host` and `Origin`, when sent, are loopback names (`localhost`, `*.localhost`, `127.x` or `[::1]`). That is a browser on the dashboard machine itself, or an SSH tunnel to it (whoever opens the tunnel already has an SSH login on that machine).
- **Through a proxy**: everything else, including Tailscale Serve and any reverse proxy, which reach the server over loopback but add forwarding headers.

Authentication is a single bearer token, `SPARKDASH_TOKEN`.

| | No `SPARKDASH_TOKEN` | `SPARKDASH_TOKEN` set |
|---|---|---|
| Direct local, reads | Allowed | Allowed |
| Direct local, changes | Allowed | Token required |
| Through a proxy, reads (monitoring) | Allowed | Token required |
| Through a proxy, changes (shutdown, wake, launcher start/stop, settings, adding units…) | Refused: `403 token_required` | Token required |
| Model control (Models page switch/start/stop, clusters, smart-routing proxy), from anywhere | Refused: `403 token_required` | Token required |
| Non-loopback bind (`BIND_HOST=0.0.0.0`) | Refuses to start | Starts; every request outside direct local needs the token |

Details:

- **The browser asks once.** When a request or the live connection is turned away, the dashboard opens an **Access token** dialog. The token is checked against the server and stored in that browser; **Settings → Access token** shows, changes or clears it.
- **How the token is sent.** `Authorization: Bearer <token>` on HTTP requests. `?token=` in a URL is accepted only on the WebSocket (`/ws`), where a browser cannot set a header; it is ignored on every other path, so tokens do not end up in proxy logs or browser history.
- **Model control always needs the token.** Without one, the Models page shows a banner and locks its controls. `SPARKDASH_FLEET_ALLOW_NO_TOKEN=1` lifts this on a single-user host that nothing else can reach; it is not recommended ([FLEET-MODELS.md](FLEET-MODELS.md#security)).
- **Fail-closed remote bind.** A non-loopback bind without a token refuses to start. `SPARKDASH_ALLOW_OPEN_REMOTE=1` restores the old open behaviour (anyone who can reach the port can change settings and power units off); it is not recommended. Older releases started such a bind open by default.
- **Origin checks** compare scheme, host and port exactly: a page on another port of the same host is a different origin.
- **Security headers.** Responses carry a Content-Security-Policy, and `frame-ancestors 'none'` stops other sites from framing the dashboard unless you allow them (see [Embedding the kiosk](#embedding-the-kiosk-home-assistant)).
- **Failed-auth limiter.** After 20 different wrong tokens from one client within 5 minutes, further attempts are refused with `429 auth_rate_limited` until the oldest failure ages out.
- **Credentials follow their host.** Changing a unit's SSH host, user or port drops its stored SSH password; changing its LLM host drops its stored LLM API keys. Enter them again for the new target. A stored secret is never sent to a host it was not entered for.
- `GET /api/health` reports the startup mode as `authMode` (`loopback-open`, `bearer`, `open-remote` or `required-missing`).

## Create the access token

On the dashboard machine, in the repository:

```bash
npm run setup
```

It creates `.env` from `.env.example` when it is missing and adds a random 32-byte `SPARKDASH_TOKEN` when none is set. It never replaces an existing token and leaves the rest of `.env` as it was. It prints where the token is; `npm run setup -- --print-token` prints the value to paste into the browser. Restart the dashboard after it changes `.env`. Without npm, generate one in any shell and add `SPARKDASH_TOKEN=<value>` to `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

With Docker Compose, `.env` next to `docker-compose.yml` supplies `SPARKDASH_TOKEN` to the container; recreate it with `docker compose up -d`.

## Safest path: local browser or SSH tunnel

On the dashboard machine, start it (`npm start`, or `docker compose up --build -d`) and open `http://127.0.0.1:5555` locally.

From another machine, create a tunnel:

```bash
ssh -N -L 5555:127.0.0.1:5555 user@dashboard-host
```

Then open `http://127.0.0.1:5555` on the client. The dashboard remains loopback-only on the server, and the tunnel counts as direct local.

## Shared remote access

Keep `BIND_HOST=127.0.0.1`, set `SPARKDASH_TOKEN`, and publish the loopback service through one of these front doors:

- **Tailscale Serve** (recommended): `tailscale serve --bg 5555` publishes `https://<machine>.<tailnet>.ts.net` to your tailnet only, with a real certificate and no open port. Use `sudo` on Linux if it reports access denied. See the README's [Tailscale Serve](../README.md#tailscale-serve-https) section.
- An HTTPS reverse proxy that requires identity before proxying HTTP and WebSocket traffic.

The front door must proxy both `/api/*` and `/ws` and preserve WebSocket upgrades. With no token, a front door gives read-only monitoring; with a token, every client also needs the token. Do not publish the dashboard with `tailscale funnel` or an unauthenticated public proxy: without `SPARKDASH_TOKEN` that is a public, read-only dashboard (inventories, logs, hostnames), and even with a token the login page is public. A TCP-level forward that adds no proxy headers (`tailscale serve --tcp`, `socat`, `ssh -L` to another host) reaches the server from loopback; it is treated as local only when the browser uses `localhost` or `127.0.0.1`, so set a token before using one. Restrict who reaches it with the front door's identity policy (Tailscale ACLs or grants, or the proxy's authentication) as well.

Tailscale Serve needs nothing more. Behind a reverse proxy on a custom domain, list that domain in `SPARKDASH_ALLOWED_HOSTS` (comma-separated); a loopback bind refuses names it does not recognise, and the refusal page says which name to add.

Browser requests must also come from an allowed **origin**: the same host and port as the address in the address bar, this machine's Tailscale or host name, an `SPARKDASH_ALLOWED_HOSTS` entry (port-exact when it names a port), or `localhost`/`127.0.0.1` on the dashboard's own port. Anything else gets `403 origin_not_allowed`, and a change sent from another site (`Sec-Fetch-Site: cross-site` or `same-site`) gets `403 cross_site`. That blocks other local web apps (ComfyUI on port 8188, another dev server, any page you browse) from driving the dashboard. To trust an extra front end, list its full origin in `SPARKDASH_ALLOWED_ORIGINS`, for example `https://dash.example.com`.

`GET /api/auth/status` reports `tokenRequired`, `authenticated` and `canMutate` (whether this request could make changes), so a client can tell "read-only from here" from "enter the token".

Direct `BIND_HOST=0.0.0.0` needs `SPARKDASH_TOKEN` and then sends the token in plain HTTP across the network; prefer a front door with TLS. A firewall-only or "trusted LAN" deployment is not a supported substitute.

## Embedding the kiosk (Home Assistant)

By default the dashboard refuses to be shown in a frame (`frame-ancestors 'none'`). To embed `/kiosk` in a Home Assistant iframe card or another page you control, set `SPARKDASH_FRAME_ANCESTORS` to the embedding origin(s), space-separated as in a CSP `frame-ancestors` source list (a comma or semicolon makes the server ignore the value and keep `'none'`):

```ini
SPARKDASH_FRAME_ANCESTORS=https://homeassistant.tailnet.ts.net
```

List only origins you control: any listed page can frame the dashboard with the viewer's stored token.

## Docker: privileges and the secrets key

The production Compose file runs the container `privileged: true` with `pid: host`, `network_mode: host`, and the host's `/`, `/proc` and `/sys` mounted read-only. These are what the local collectors and host power controls need on a DGX Spark, and they make the container effectively **root on the host**: anyone who can control the dashboard, or code that compromises it, can act as root on that machine. Therefore:

- Keep the loopback bind and set `SPARKDASH_TOKEN`; treat the token like a root credential.
- On a machine that is not itself monitored as the local unit (a Windows workstation, a Mac, an x86 box that only watches remote units), run natively with `npm start` instead of the privileged container; nothing is lost, since remote units are read over SSH.
- **Keep the secrets key out of `config/`.** Stored SSH passwords, LLM API keys and alert channel URLs are encrypted with AES-256-GCM in `config/sparks-secrets.json`. The key comes from `SPARKDASH_SECRETS_KEY` (a passphrase, or 64 hex characters used as the raw key) when it is set, and otherwise from `config/.secrets-key`, generated on first use. With the generated file, a copy or backup of `config/` holds both the ciphertext and its key. To separate them:
  1. Copy the contents of `config/.secrets-key` (64 hex characters) into `SPARKDASH_SECRETS_KEY` in `.env` or in your service manager's secret store. The environment value takes precedence over the file.
  2. For Docker, make sure the service's `environment:` forwards it (`- SPARKDASH_SECRETS_KEY=${SPARKDASH_SECRETS_KEY:-}`) if your Compose file does not already.
  3. Restart and check that the units with stored passwords still connect, then move `config/.secrets-key` to an offline backup.

  Losing the key makes the stored credentials unreadable; they then have to be entered again.

## Existing Docker installations

Previous Compose files exposed `http://<host-ip>:5555`. After upgrading:

1. Leave `BIND_HOST` unset (or set it to `127.0.0.1`).
2. Run `npm run setup` (or add `SPARKDASH_TOKEN` to `.env` by hand), then recreate the service: `docker compose up --build -d`.
3. Use the SSH tunnel above immediately, or configure Tailscale Serve or an authenticated reverse proxy.

A `.env` copied from an older `.env.example` may contain `SPARKDASH_ALLOW_OPEN_REMOTE=1`; remove it. `npm run setup` points it out.

To recover from a mistaken non-loopback setting in one command:

```bash
BIND_HOST=127.0.0.1 docker compose up -d --force-recreate
```

## SSH key mount

Remote unit checks run inside the container. Mount one private key read-only at `/root/.ssh/id_ed25519`, or set `SSH_IDENTITY_FILE` to its in-container path. The host key file must be mode `600`:

```bash
chmod 600 "$HOME/.ssh/id_ed25519"
```

A native install (`npm start`) uses the operator's own keys: `~/.ssh` on Linux and macOS, `%USERPROFILE%\.ssh` on Windows.

Startup preflight reports the bind/auth mode, config writability, secrets-key state, SSH identity state and, on a Linux host, the local collector paths (in the container: the `/proc` and `/sys` host mounts). Windows and macOS hosts skip the `/proc`, `/sys` and container-mount checks. Two conditions stop startup: a config directory that is not writable, and a non-loopback bind without `SPARKDASH_TOKEN` (unless `SPARKDASH_ALLOW_OPEN_REMOTE=1`). Everything else is a warning about a degraded optional feature.
