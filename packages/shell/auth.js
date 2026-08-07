// Microsoft 365 (Entra ID / Azure AD) sign-in, via OpenID Connect -- gates
// every page and every /api/* route behind a signed-in account from your own
// tenant. See ../../README.md "Securing the dashboard" for the Entra admin
// center setup this depends on (app registration, client secret, redirect URI).
const session = require('express-session');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const {
  AUTH_CLIENT_ID,
  AUTH_CLIENT_SECRET,
  AUTH_TENANT_ID,
  // Optional extra narrowing on top of the tenant restriction below -- a
  // comma-separated allowlist of exact M365 email addresses. Leave unset to
  // allow anyone who can sign in to the tenant (still gate-kept by Entra's
  // own "Assignment required" toggle on the app registration, if you use it).
  AUTH_ALLOWED_USERS,
  // Must exactly match the Redirect URI registered in Entra, including
  // scheme and port -- e.g. http://192.168.1.50:3000 for a LAN box, or
  // https://dashboard.ambientit.internal for a proper hostname. NOT
  // localhost once this is reachable by other people.
  APP_BASE_URL,
  SESSION_SECRET,
} = process.env;

const REQUIRED = { AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_TENANT_ID, APP_BASE_URL, SESSION_SECRET };
for (const [name, value] of Object.entries(REQUIRED)) {
  if (!value) {
    throw new Error(
      `Missing required env var ${name} -- see README.md "Securing the dashboard" for Entra ID setup.`
    );
  }
}

const redirectUri = `${APP_BASE_URL.replace(/\/$/, '')}/auth/callback`;
const scopes = ['openid', 'profile', 'email', 'User.Read'];

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: AUTH_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${AUTH_TENANT_ID}`,
    clientSecret: AUTH_CLIENT_SECRET,
  },
});

const allowedUsers = AUTH_ALLOWED_USERS
  ? new Set(
      AUTH_ALLOWED_USERS.split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    )
  : null;

// Blocks anything mounted after it in server.js until the session has a
// signed-in user. API calls get a plain 401 (the frontend's fetch wrapper in
// public/app.js turns that into a redirect to /auth/login) rather than a
// redirect, since a redirect response to a fetch() call would just hand the
// page back as unexpected JSON and break every page's error handling.
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  req.session.postLoginRedirect = req.originalUrl;
  res.redirect('/auth/login');
}

// Mounts the session middleware and the /auth/* routes -- called BEFORE
// app.use(requireAuth) in server.js so sign-in itself is reachable while
// signed out, and BEFORE express.static so no page or asset is served to an
// unauthenticated request.
function registerAuthRoutes(app) {
  app.set('trust proxy', 1); // needed for `cookie.secure` to work correctly if this ever sits behind a reverse proxy/load balancer
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000, // 8-hour session -- an internal work tool, not a long-lived login
        secure: APP_BASE_URL.startsWith('https://'),
        sameSite: 'lax',
      },
    })
  );

  app.get('/auth/login', async (req, res) => {
    try {
      const url = await msalClient.getAuthCodeUrl({ scopes, redirectUri });
      res.redirect(url);
    } catch (err) {
      console.error('Failed to build Microsoft login URL:', err);
      res.status(500).send('Failed to start sign-in. Check server logs.');
    }
  });

  app.get('/auth/callback', async (req, res) => {
    if (req.query.error) {
      // User cancelled, or admin consent is missing, etc. -- Microsoft's own
      // description is the most useful thing to show here.
      return res.status(403).send(`Sign-in failed: ${req.query.error_description || req.query.error}`);
    }
    try {
      const tokenResponse = await msalClient.acquireTokenByCode({ code: req.query.code, scopes, redirectUri });
      const email = (tokenResponse.account.username || '').toLowerCase();

      // Defense-in-depth on top of the app registration already being
      // single-tenant in Entra: reject any token that somehow isn't from
      // this exact tenant, and (if configured) narrow further to an
      // explicit email allowlist.
      if (tokenResponse.account.tenantId !== AUTH_TENANT_ID) {
        return res.status(403).send('Wrong Microsoft 365 organization.');
      }
      if (allowedUsers && !allowedUsers.has(email)) {
        return res.status(403).send('Your Microsoft 365 account is not authorized for this dashboard.');
      }

      req.session.user = { name: tokenResponse.account.name, email: tokenResponse.account.username };
      const redirectTo = req.session.postLoginRedirect || '/';
      delete req.session.postLoginRedirect;
      res.redirect(redirectTo);
    } catch (err) {
      console.error('Microsoft sign-in callback failed:', err);
      res.status(500).send('Sign-in failed. Check server logs.');
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      // Also ends the Microsoft session, not just this app's -- otherwise
      // "sign out" silently signs back in immediately via the still-live
      // Microsoft SSO session on shared/kiosk machines.
      const logoutUrl = `https://login.microsoftonline.com/${AUTH_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(APP_BASE_URL)}`;
      res.redirect(logoutUrl);
    });
  });

  // Lets the frontend show who's signed in / render a Sign out link without
  // guessing -- returns null rather than 401 so it's safe to call before the
  // requireAuth guard below is even relevant.
  app.get('/api/me', (req, res) => {
    res.json({ user: req.session.user || null });
  });
}

module.exports = { registerAuthRoutes, requireAuth };
