# Remote access

sparkDash includes administrative actions such as credential changes, benchmarks, updates, power controls and model control. The server binds to `127.0.0.1` by default.

Authentication is a single bearer token, `SPARKDASH_TOKEN`. When it is set, every mutating request and every WebSocket connection must carry it (`Authorization: Bearer <token>`, or `?token=` where a header cannot be sent), and so must every API read on a non-loopback bind. On a loopback bind, API reads (`GET`) are never token-checked, even with a token set. Anything that forwards to loopback (Tailscale Serve, a reverse proxy, an SSH tunnel) therefore passes its clients straight through for reads: on a loopback bind the token protects writes and the WebSocket, and reads rely on the front door's identity policy. Without a token, a loopback-bound server accepts every request that reaches it, writes included. Fleet model control is the exception: its operations, cancel, cluster changes and the smart-routing proxy answer `403 token_required` until a token is set ([FLEET-MODELS.md](FLEET-MODELS.md#security)).

## Safest path: local browser or SSH tunnel

On the sparkDash host:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:5555` locally. From another machine, create a tunnel:

```bash
ssh -N -L 5555:127.0.0.1:5555 user@sparkdash-host
```

Then open `http://127.0.0.1:5555` on the client. The dashboard remains loopback-only on the server.

## Shared remote access

Keep `BIND_HOST=127.0.0.1`, set `SPARKDASH_TOKEN`, and publish the loopback service through one of these authenticated front doors:

- an HTTPS reverse proxy that requires identity before proxying HTTP and WebSocket traffic;
- Tailscale Serve with tailnet identity/access policy.

The front door must proxy both `/api/*` and `/ws`, preserve WebSocket upgrades, and require authentication for every path. TLS without authentication is not sufficient.

Tailscale Serve needs nothing more. Behind a reverse proxy on a custom domain, list that domain in `SPARKDASH_ALLOWED_HOSTS` (comma-separated); a loopback bind refuses other sites and names it does not recognise, and the refusal page says which name to add.

Direct `BIND_HOST=0.0.0.0` needs `SPARKDASH_TOKEN`. Without a token a non-loopback bind is **open**: anyone who can reach the port can read, change settings and power units off, and startup only warns. Set `SPARKDASH_ALLOW_OPEN_REMOTE=0` to make such a startup fail instead. A firewall-only or “trusted LAN” deployment is not a supported substitute.

## Existing Docker installations

Previous Compose files exposed `http://<host-ip>:5555`. After upgrading:

1. Leave `BIND_HOST` unset (or set it to `127.0.0.1`).
2. Recreate the service: `docker compose up --build -d`.
3. Use the SSH tunnel above immediately, or configure an authenticated reverse proxy/Tailscale Serve.

To recover from a mistaken non-loopback setting in one command:

```bash
BIND_HOST=127.0.0.1 docker compose up -d --force-recreate
```

## SSH key mount

Remote unit checks run inside the container. Mount one private key read-only at `/root/.ssh/id_ed25519`, or set `SSH_IDENTITY_FILE` to its in-container path. The host key file must be mode `600`:

```bash
chmod 600 "$HOME/.ssh/id_ed25519"
```

Startup preflight reports the bind/auth mode, config writability, secrets-key state, SSH identity state, and local collector mounts. Two conditions stop startup: a config directory that is not writable, and a non-loopback bind without `SPARKDASH_TOKEN` while `SPARKDASH_ALLOW_OPEN_REMOTE=0`. A non-loopback bind without a token and without that setting starts open, with a warning. Everything else is a warning about a degraded optional feature.
