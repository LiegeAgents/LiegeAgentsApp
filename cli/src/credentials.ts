import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A CLI linked with `liege login` stores a short-lived device access token and a rotating
// refresh token, issued through the same workspace pairing codes as the Android companion.

export type Credentials = {
  apiUrl: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export const credentialsPath = () => {
  if (process.env.LIEGE_CONFIG_DIR) return join(process.env.LIEGE_CONFIG_DIR, "credentials.json");
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "liege", "credentials.json");
};

export async function loadCredentials(apiUrl: string): Promise<Credentials | null> {
  try {
    const stored = JSON.parse(await readFile(credentialsPath(), "utf8")) as Credentials;
    // Credentials are bound to the API that issued them.
    return stored.apiUrl === apiUrl && stored.refreshToken ? stored : null;
  } catch {
    return null;
  }
}

export async function saveCredentials(credentials: Credentials) {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function clearCredentials() {
  await rm(credentialsPath(), { force: true });
}

const LINK_EXPIRED =
  "This CLI's workspace link has expired or was revoked. Run `liege login` again.";

let refreshing: Promise<Credentials> | null = null;

async function refresh(apiUrl: string, current: Credentials): Promise<Credentials> {
  const response = await fetch(`${apiUrl}/v1/mobile/refresh`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (response.status === 401) {
    // Another CLI process may have rotated the refresh token first.
    const latest = await loadCredentials(apiUrl);
    if (latest && latest.refreshToken !== current.refreshToken) return latest;
    await clearCredentials();
    throw new Error(LINK_EXPIRED);
  }
  if (!response.ok) throw new Error(`Unable to refresh the CLI session (${response.status}).`);
  const body = (await response.json()) as { data: Omit<Credentials, "apiUrl"> };
  const next = { apiUrl, ...body.data };
  await saveCredentials(next);
  return next;
}

// Returns a valid linked access token, refreshing it shortly before expiry (or when forced
// after a 401). Concurrent callers share one refresh because refresh tokens are single use.
export async function linkedAccessToken(apiUrl: string, force = false) {
  const current = await loadCredentials(apiUrl);
  if (!current) return undefined;
  const fresh = new Date(current.accessExpiresAt).getTime() - Date.now() > 60_000;
  if (fresh && !force) return current.accessToken;
  refreshing ??= refresh(apiUrl, current).finally(() => {
    refreshing = null;
  });
  return (await refreshing).accessToken;
}
