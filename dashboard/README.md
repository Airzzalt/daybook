# Dashboard

Private operations dashboard. Node + Express, reads Postgres directly.

## Environment variables (set these in Render → Environment)

| Key | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `DASH_PASSWORD` | yes | The password to sign in with |
| `SESSION_SECRET` | yes | Any long random string; signs the login cookie |
| `META_AD_ACCOUNT` | no | Ad account id, digits only |
| `META_TOKEN` | no | Meta system-user token with `ads_read` |
| `STRIPE_KEY` | no | Restricted key with read access to payouts |

Ad spend, cost per order and return on spend stay blank until the Meta pair is set —
until then the Settings page takes a daily figure by hand.

## Run

    npm install
    npm start
