# Sign in, manage operators and review the audit log

The control plane asks everyone to sign in before they can see the dashboard or change anything. Each person has their own **operator** account, and the **audit log** records who changed which rule, pricing setting or account, and when.

Collectors aren't affected. They keep authenticating to the policy and stats APIs with their fleet key, exactly as before.

## Sign in for the first time

A new installation has no operator accounts. The first one is created from two settings on the control plane:

| Setting | What it is |
|---|---|
| `CHOPPER_ADMIN_EMAIL` | The first operator's email. It's used as the sign-in name; nothing is ever sent to it. |
| `CHOPPER_ADMIN_PASSWORD` | Their initial password, at least 12 characters. |

Where these come from depends on how you run Telemetry Chopper:

| Deployment | Default email | Default password |
|---|---|---|
| Docker Compose quick start (`deploy/docker`) | `admin@localhost` | `chopper-admin-dev` |
| Sandbox and pilot rehearsal environments | `admin@localhost` | `chopper-admin-dev` |
| Helm chart | `admin@localhost` | Generated randomly at install. The install notes print the command that reads it. |

To sign in:

1. Open the dashboard, for example `http://localhost:3000`. You're sent to the sign-in page.
2. Enter the email and password above, and click **Sign in**.
3. Choose your own password on the **Choose your password** page. You can't open the rest of the console until you do.

The default credentials stop working once anyone has signed in with them and chosen a new password. Still, set your own `CHOPPER_ADMIN_EMAIL` and `CHOPPER_ADMIN_PASSWORD` before you start a control plane that other people can reach, so nobody else can claim the first account.

To set them:

- **Docker Compose:** export both variables before `docker compose up`.
- **Helm:** set `controlPlane.admin.email` and `controlPlane.admin.password`, or point `controlPlane.admin.existingSecret` at a Secret with the keys `CHOPPER_ADMIN_EMAIL` and `CHOPPER_ADMIN_PASSWORD`.

Once any operator exists, both settings are ignored. You can leave them in place: they won't recreate a removed account or reset a changed password.

## Add an operator

1. Click **Operators** in the top bar.
2. Under **Add an operator**, enter their email, an optional name, and a temporary password of at least 12 characters.
3. Click **Add operator**, and give them the temporary password privately.

The first time they sign in, they're asked to choose their own password. Until then, the Operators page shows **Hasn't chosen a password yet** next to their account.

> **Important:** every operator can change rules, pricing and the list of operators. There are no roles yet, so only add people you'd trust with your production telemetry pipeline.

## Remove an operator

On the **Operators** page, click **Remove** next to their account, then **Remove** again to confirm. They're signed out everywhere immediately. Their entries in the audit log stay.

You can't remove your own account, so there's always at least one operator who can sign in.

## Change your password

Click your email in the top bar, enter your current password and the new one twice, and click **Change password**. Changing it signs you out of every other browser.

## Review the audit log

Click **Audit log** in the top bar. It lists, newest first:

- Rules created, paused, resumed, deleted and restored, with the full settings of each new rule.
- Changes to vendor pricing, committed volume and cloud egress, with the saved values.
- Operators added and removed, and password changes.
- Sign-ins, sign-outs, and wrong passwords entered for an existing operator.

Each entry shows when it happened and who did it. Entries are never edited or deleted by the control plane, and they outlive what they describe: a rule's history stays after the rule is permanently deleted, and an operator's stays after they're removed.

## Regain access when nobody can sign in

If every operator has forgotten their password, someone with access to the database can reset one from a shell. The new password is read from `CHOPPER_NEW_PASSWORD`, or prompted for if it isn't set. The operator must choose a new password the next time they sign in.

From a checkout, with `DATABASE_URL` pointing at the control plane's database:

```bash
cd control-plane
npm run operator -- reset-password you@example.com
```

`npm run operator -- create you@example.com` adds a new operator the same way.

With Docker Compose, run it in the migration image, on the stack's network:

```bash
docker compose -f deploy/docker/docker-compose.yaml run --rm -e CHOPPER_NEW_PASSWORD control-plane-migrate npm run operator -- reset-password you@example.com
```

On Kubernetes, run the same command in a pod from the chart's `migrator.image`, with `DATABASE_URL` set to your database.

Resets and accounts created this way appear in the audit log with **cli** as the actor.

## Frequently asked questions

### How long does a sign-in last?

Seven days. Signing out ends the session at once, on the server as well as in your browser.

### What happens after too many wrong passwords?

After 10 wrong passwords for the same email within 15 minutes, sign-ins for that email are refused until the oldest attempt is 15 minutes old. Each control-plane replica counts separately, and a restart resets the count.

### Sign-in succeeds but I'm sent straight back to the sign-in page

Your browser is refusing the session cookie. This happens when the control plane is served over HTTPS by a proxy that doesn't send an `X-Forwarded-Proto: https` header, or over plain HTTP when it's told to use secure cookies. Set `CHOPPER_SECURE_COOKIES=true` on the control plane if users reach it over HTTPS, or `false` if they reach it over plain HTTP.

### Can I use single sign-on (OIDC or SAML)?

Not yet. Until it ships, you can still put an identity-aware proxy, such as Cloudflare Access or oauth2-proxy, in front of the control plane, in addition to operator sign-in.

### Do collectors need any changes?

No. The `/api/v1` endpoints that collectors call don't use operator sign-in. They're authenticated with each fleet's key.
