# Self-hosting: login and reverse proxies

sure-bank-sync holds bank logins and logged-in bank sessions, so put a login
in front of it and serve it over HTTPS. Everything here is set with
environment variables (in `.env`); nothing is configured in the web UI.

## Choosing a login

`SURE_SYNC_AUTH` picks how people sign in:

| Mode | When to use | Needs |
|---|---|---|
| `oidc` | You run an identity provider (Pocket ID, Authelia, Authentik, Keycloak, Zitadel, Kanidm…) or use Google / Microsoft. Each person signs in as themselves. | `SURE_SYNC_OIDC_ISSUER`, `SURE_SYNC_OIDC_CLIENT_ID` (and usually a secret) |
| `password` | One shared admin login. | `SURE_SYNC_ADMIN_PASSWORD` (user `admin`, or `SURE_SYNC_ADMIN_USER`) |
| `none` | Your reverse proxy already requires a login (Authelia/Authentik forward auth, Tailscale, Cloudflare Access…), or a network only you can reach. | nothing |

If `SURE_SYNC_AUTH` isn't set: `password` when `SURE_SYNC_ADMIN_PASSWORD` is
set, else `oidc` when `SURE_SYNC_OIDC_ISSUER` is set, else `none`. With `none`
the app logs a warning at every start. Anyone who can reach it can change
every bank connection, so never expose a `none` instance directly.

Changing the admin password or the OIDC client signs everyone out.

## OIDC (Pocket ID and others)

1. In your identity provider, create an OIDC client (often called an
   "application" or "OIDC client"):
   - Redirect / callback URL: `https://<your-sync-host>/auth/oidc/callback`
   - Grant: authorization code (PKCE is always used)
   - Scopes: `openid email profile` (+ `groups` if you limit by group)
   - Logout URL / post-logout redirect: not needed
2. Set in `.env`:

```bash
SURE_SYNC_AUTH=oidc
SURE_SYNC_PUBLIC_URL=https://sync.example.com        # how people reach the app
SURE_SYNC_OIDC_ISSUER=https://id.example.com         # provider's issuer URL
SURE_SYNC_OIDC_CLIENT_ID=...
SURE_SYNC_OIDC_CLIENT_SECRET=...                     # leave empty for a public (PKCE-only) client
SURE_SYNC_OIDC_NAME=Pocket ID                        # text on the sign-in button
# Who may sign in (either list matching is enough). Leave both empty to allow
# every user of the provider (the app warns at start).
SURE_SYNC_OIDC_ALLOWED_EMAILS=alice@example.com,bob@example.com
SURE_SYNC_OIDC_ALLOWED_GROUPS=household
# SURE_SYNC_OIDC_GROUPS_CLAIM=groups                 # claim that lists groups
# SURE_SYNC_OIDC_SCOPES=openid email profile groups  # override the requested scopes
```

The app finds everything else from `<issuer>/.well-known/openid-configuration`.
It checks the ID token's signature, issuer, audience, nonce and expiry. Only
verified email addresses (`email_verified` not false) count for
`ALLOWED_EMAILS`. If the ID token has no email or groups, the app asks the
userinfo endpoint.

Issuer URLs for common providers:

| Provider | Issuer | Notes |
|---|---|---|
| Pocket ID | `https://id.example.com` | Add the client under OIDC Clients; for groups, assign user groups to the client and add the `groups` scope. Public clients work (no secret). |
| Authelia | `https://auth.example.com` | Add a client under `identity_providers.oidc.clients` with `redirect_uris` above, `scopes: [openid, email, profile, groups]`. |
| Authentik | `https://authentik.example.com/application/o/<slug>/` | Create an OAuth2/OpenID provider + application; the trailing slash matters. |
| Keycloak | `https://kc.example.com/realms/<realm>` | Groups need a "Group Membership" mapper (token claim name `groups`, full path off). |
| Zitadel | `https://<instance>.zitadel.cloud` | Roles arrive in `urn:zitadel:iam:org:project:roles`; prefer `ALLOWED_EMAILS`. |
| Kanidm | `https://idm.example.com/oauth2/openid/<client>` | Use the client name as the client ID. |
| Google | `https://accounts.google.com` | No groups claim: use `ALLOWED_EMAILS`. |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Groups claim holds object IDs unless configured otherwise; `ALLOWED_EMAILS` is simpler. |

The provider may run on plain `http://` inside a lab; the app allows that for
the issuer, but use HTTPS for the app itself.

Log out signs you out of sure-bank-sync only. Your provider session stays, so
"Sign in" logs straight back in without a password until you log out there.

## Reverse proxies

Behind a proxy, also set:

```bash
SURE_SYNC_TRUST_PROXY=1                       # use X-Forwarded-For/-Proto/-Host from the proxy
SURE_SYNC_PUBLIC_URL=https://sync.example.com
```

`SURE_SYNC_TRUST_PROXY` makes the login limiter see each visitor's address
instead of the proxy's, and marks cookies secure on HTTPS. Only turn it on
when the app is reachable **only** through the proxy (otherwise a client can
fake those headers). Don't publish the container's port on the host then: put
the app and the proxy on the same Docker network.

The live browser view streams with server-sent events. Caddy and Traefik pass
them through as-is; nginx needs buffering off (the app also sends
`X-Accel-Buffering: no`).

### Caddy

```caddyfile
sync.example.com {
	reverse_proxy sure-bank-sync:8686
}
```

With forward auth instead of the app's own login (`SURE_SYNC_AUTH=none`), e.g.
Authelia:

```caddyfile
sync.example.com {
	forward_auth authelia:9091 {
		uri /api/authz/forward-auth
		copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
	}
	reverse_proxy sure-bank-sync:8686
}
```

### Traefik (Docker labels)

```yaml
services:
  sure-bank-sync:
    image: ghcr.io/<your-github-user>/sure-bank-sync:latest
    env_file: .env
    environment:
      SURE_SYNC_TRUST_PROXY: "1"
      SURE_SYNC_PUBLIC_URL: https://sync.example.com
    volumes:
      - sure-sync-data:/data
    shm_size: "1gb"
    networks: [proxy]
    labels:
      traefik.enable: "true"
      traefik.http.routers.sure-sync.rule: Host(`sync.example.com`)
      traefik.http.routers.sure-sync.entrypoints: websecure
      traefik.http.routers.sure-sync.tls.certresolver: letsencrypt
      traefik.http.services.sure-sync.loadbalancer.server.port: "8686"
      # forward auth instead of the app's login (SURE_SYNC_AUTH=none):
      # traefik.http.routers.sure-sync.middlewares: authelia@docker

networks:
  proxy:
    external: true

volumes:
  sure-sync-data:
    name: sure-bank-sync-data
```

Remove the `ports:` section from `docker-compose.yml` when Traefik is the only
way in.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;

    location / {
        proxy_pass http://127.0.0.1:8686;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_buffering off;          # live browser view
        proxy_read_timeout 1h;
    }
}
```

## Checklist

- HTTPS in front of the app, and `SURE_SYNC_PUBLIC_URL` set to that address.
- A login: `oidc` with an allow list, `password`, or `none` only behind forward auth.
- `SURE_SYNC_TRUST_PROXY=1` only when the proxy is the only way in.
- Back up `.env` (`SURE_SYNC_SECRET_KEY`) and the `sure-bank-sync-data` volume.
