// CLI config parser. Node has no browser cookie jar, so auth is an explicit
// Basic credential pair passed on the command line (model: Textual --user/--password).
//
//   node dist/cli.js --api http://<deck-host>:7777 --user <user> --password <pass>
//
// Exposes a typed { apiUrl, auth } consumed by lib/api.ts + lib/ws.ts and
// threaded to every screen via React context (see ../context.tsx).

export type Auth = { user: string; password: string } | null;

export type Config = {
  apiUrl: string; // no trailing slash
  auth: Auth;
};

const DEFAULT_API = "http://127.0.0.1:7777";

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

// Parse an argv array (defaults to process.argv.slice(2)). Recognises
// --api/--url, --user, --password (and --pass). Supports both
// "--user warlock" and "--user=warlock" forms.
export function parseConfig(argv: string[] = process.argv.slice(2)): Config {
  let apiUrl = DEFAULT_API;
  let user: string | undefined;
  let password: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = () => (inlineVal !== undefined ? inlineVal : argv[++i]);

    switch (key) {
      case "--api":
      case "--url":
        apiUrl = stripTrailingSlash(next() ?? DEFAULT_API);
        break;
      case "--user":
      case "--username":
        user = next();
        break;
      case "--password":
      case "--pass":
        password = next();
        break;
      default:
        break;
    }
  }

  const auth: Auth =
    user !== undefined && password !== undefined ? { user, password } : null;

  return { apiUrl, auth };
}
