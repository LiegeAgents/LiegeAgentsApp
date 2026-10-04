import { randomBytes, randomInt } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMobileAuth, hashSessionToken } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { issueExecutionGrant } from "../executionGrants.js";
import { ApiError, asyncRoute } from "../http.js";

export const mobileRouter = Router();

let latestReleaseCache: { expiresAt: number; value: unknown } | null = null;
const latestRelease = async () => {
  if (latestReleaseCache && latestReleaseCache.expiresAt > Date.now())
    return latestReleaseCache.value;
  const repository = "LiegeAgents/LiegeAgentsApp";
  const fallbackTag = process.env.MOBILE_RELEASE_TAG ?? "android-v0.1.2";
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=20`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "liege-api" },
  });
  if (!response.ok) {
    const value = {
      tag: fallbackTag,
      name: `Liege Android ${fallbackTag.replace(/^android-v/, "v")}`,
      publishedAt: null,
      asset: {
        name: "liege-mobile.apk",
        size: null,
        url: `https://github.com/${repository}/releases/download/${fallbackTag}/liege-mobile.apk`,
      },
    };
    latestReleaseCache = { expiresAt: Date.now() + 60_000, value };
    return value;
  }
  const releases = (await response.json()) as Array<{
    tag_name?: string;
    name?: string;
    draft?: boolean;
    prerelease?: boolean;
    published_at?: string;
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
  }>;
  const prefix = process.env.MOBILE_RELEASE_TAG_PREFIX ?? "android-v";
  const release = releases.find(
    (item) => !item.draft && !item.prerelease && item.tag_name?.startsWith(prefix),
  );
  if (!release)
    throw new ApiError(
      404,
      "mobile_release_not_found",
      "No Android companion release has been published yet.",
    );
  const asset = release.assets?.find((item) => item.name === "liege-mobile.apk");
  if (!asset?.browser_download_url)
    throw new ApiError(
      404,
      "mobile_release_not_found",
      "The latest Android release does not include an APK.",
    );
  const value = {
    tag: release.tag_name,
    name: release.name ?? release.tag_name,
    publishedAt: release.published_at,
    asset: { name: asset.name, size: asset.size, url: asset.browser_download_url },
  };
  latestReleaseCache = { expiresAt: Date.now() + 60_000, value };
  return value;
};

const pairingInput = z.object({
  name: z.string().trim().min(1).max(80).default("Android device"),
  platform: z.literal("android").default("android"),
  appVersion: z.string().trim().max(40).optional(),
});
const codeInput = z.object({
  code: z.string().regex(/^\d{8}$/, "Pairing code must contain 8 digits."),
  ...pairingInput.shape,
});
const refreshInput = z.object({ refreshToken: z.string().min(32).max(256) });

const issueTokens = async (client: { query: Function }, deviceId: string, userId: string) => {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(48).toString("base64url");
  const accessExpiresAt = new Date(Date.now() + 15 * 60_000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 86_400_000);
  await client.query(
    `INSERT INTO mobile_sessions
      (device_id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      deviceId,
      userId,
      hashSessionToken(accessToken),
      hashSessionToken(refreshToken),
      accessExpiresAt,
      refreshExpiresAt,
    ],
  );
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
};

mobileRouter.post(
  "/pairing-codes",
  requireAuth,
  asyncRoute(async (request, response) => {
    const code = String(randomInt(10_000_000, 100_000_000));
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await db.query(
      `INSERT INTO mobile_pairing_codes (user_id, code_hash, expires_at)
       VALUES ($1,$2,$3)`,
      [request.auth!.userId, hashSessionToken(code), expiresAt],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mobile.pairing_code_created",
      targetType: "mobile_pairing_code",
      targetId: request.auth!.userId,
      requestId: request.requestId,
      metadata: { expiresAt },
    });
    response.status(201).json({ data: { code, expiresAt } });
  }),
);

mobileRouter.get(
  "/releases/latest",
  asyncRoute(async (_request, response) => {
    response.json({ data: await latestRelease() });
  }),
);

mobileRouter.get(
  "/releases/latest/download",
  asyncRoute(async (_request, response) => {
    const release = (await latestRelease()) as { asset: { url: string } };
    response.redirect(302, release.asset.url);
  }),
);

mobileRouter.post(
  "/pair",
  asyncRoute(async (request, response) => {
    const input = codeInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const pairing = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM mobile_pairing_codes
         WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < max_attempts
         FOR UPDATE`,
        [hashSessionToken(input.code)],
      );
      if (!pairing.rowCount) {
        await client.query("ROLLBACK");
        throw new ApiError(401, "invalid_pairing_code", "This pairing code is invalid or expired.");
      }
      await client.query("UPDATE mobile_pairing_codes SET consumed_at = now() WHERE id = $1", [
        pairing.rows[0].id,
      ]);
      const device = await client.query<{ id: string }>(
        `INSERT INTO mobile_devices (user_id, name, platform, app_version, last_seen_at)
         VALUES ($1,$2,$3,$4,now()) RETURNING id`,
        [pairing.rows[0].user_id, input.name, input.platform, input.appVersion ?? null],
      );
      const tokens = await issueTokens(client, device.rows[0].id, pairing.rows[0].user_id);
      await audit(client, {
        actorId: pairing.rows[0].user_id,
        action: "mobile.device_paired",
        targetType: "mobile_device",
        targetId: device.rows[0].id,
        requestId: request.requestId,
        metadata: { platform: input.platform, appVersion: input.appVersion ?? null },
      });
      await client.query("COMMIT");
      response.status(201).json({ data: { deviceId: device.rows[0].id, ...tokens } });
    } catch (error) {
      if (!client) throw error;
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }),
);

mobileRouter.post(
  "/refresh",
  asyncRoute(async (request, response) => {
    const { refreshToken } = refreshInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; device_id: string; user_id: string }>(
        `SELECT s.id, s.device_id, s.user_id FROM mobile_sessions s
         JOIN mobile_devices d ON d.id = s.device_id
         WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL
           AND s.refresh_expires_at > now() AND d.revoked_at IS NULL FOR UPDATE`,
        [hashSessionToken(refreshToken)],
      );
      if (!result.rowCount)
        throw new ApiError(
          401,
          "invalid_mobile_refresh",
          "This mobile refresh token is invalid or expired.",
        );
      await client.query("UPDATE mobile_sessions SET revoked_at = now() WHERE id = $1", [
        result.rows[0].id,
      ]);
      const tokens = await issueTokens(client, result.rows[0].device_id, result.rows[0].user_id);
      await client.query("COMMIT");
      response.json({ data: { deviceId: result.rows[0].device_id, ...tokens } });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }),
);

mobileRouter.get(
  "/devices",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT id, name, platform, app_version, last_seen_at, created_at, revoked_at
       FROM mobile_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

mobileRouter.delete(
  "/devices/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "UPDATE mobile_devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "mobile_device_not_found", "This device is unavailable.");
    await db.query(
      "UPDATE mobile_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE device_id = $1",
      [id],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mobile.device_revoked",
      targetType: "mobile_device",
      targetId: id,
      requestId: request.requestId,
    });
    response.status(204).end();
  }),
);

mobileRouter.get(
  "/overview",
  requireMobileAuth,
  asyncRoute(async (request, response) => {
    const userId = request.mobileAuth!.userId;
    const jobsOffset = z.coerce
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .default(0)
      .parse(request.query.jobsOffset);
    const [jobs, proposals, activity] = await Promise.all([
      db.query(
        `SELECT j.id, j.public_id, j.title, j.status, j.settlement_asset, j.budget_amount,
                j.deadline_at, j.expires_at, j.created_at, a.name AS agent_name
         FROM jobs j JOIN agents a ON a.id=j.agent_id
         WHERE j.client_id=$1 OR a.owner_id=$1 OR j.evaluator_id=$1
         ORDER BY j.created_at DESC, j.id DESC LIMIT 51 OFFSET $2`,
        [userId, jobsOffset],
      ),
      db.query(
        `SELECT id, agent_id, action, status,
                CASE WHEN status='pending' AND expires_at <= now() THEN 'expired' ELSE status END AS effective_status,
                expires_at, created_at, decided_at
         FROM mcp_proposals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 25`,
        [userId],
      ),
      db.query(
        `SELECT lt.id, lt.reference, lt.type, lt.created_at,
                sum(lp.amount_usdg) FILTER (WHERE la.user_id=$1) AS net_usdg
         FROM ledger_transactions lt JOIN ledger_postings lp ON lp.transaction_id=lt.id
         JOIN ledger_accounts la ON la.id=lp.account_id WHERE la.user_id=$1
         GROUP BY lt.id ORDER BY lt.created_at DESC LIMIT 20`,
        [userId],
      ),
    ]);
    response.json({
      data: {
        jobs: jobs.rows.slice(0, 50),
        nextJobsOffset: jobs.rows.length > 50 ? jobsOffset + 50 : null,
        proposals: proposals.rows,
        activity: activity.rows,
      },
    });
  }),
);

mobileRouter.post(
  "/proposals/:id/:decision",
  requireMobileAuth,
  asyncRoute(async (request, response) => {
    if (!request.mobileAuth!.scopes.includes("mobile:approve"))
      throw new ApiError(
        403,
        "mobile_scope_required",
        "This mobile session cannot approve proposals.",
      );
    const id = z.string().uuid().parse(request.params.id);
    const decision = z.enum(["approved", "rejected"]).parse(request.params.decision);
    const result = await db.query(
      `UPDATE mcp_proposals p SET status=$3, decided_at=now()
       WHERE p.id=$1 AND p.user_id=$2 AND p.status='pending' AND p.expires_at > now()
         AND ($3='rejected' OR NOT EXISTS (
           SELECT 1 FROM agent_accounts a WHERE a.agent_id=p.agent_id AND a.status <> 'active'))
       RETURNING id, agent_id, action, payload, status, expires_at, decided_at`,
      [id, request.mobileAuth!.userId, decision],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        "proposal_unavailable",
        "This proposal is no longer available to decide.",
      );
    const proposal = result.rows[0] as {
      id: string;
      agent_id: string;
      action: string;
      payload: unknown;
      status: string;
      expires_at: Date;
      decided_at: Date;
    };
    let executionGrant: { id: string; expiresAt: Date } | undefined;
    if (decision === "approved" && proposal.action === "submit_deliverable") {
      const payload = z
        .object({ jobId: z.string().uuid(), deliverable: z.string().min(1) })
        .safeParse(proposal.payload);
      if (payload.success) {
        const grant = await issueExecutionGrant({
          proposalId: proposal.id,
          userId: request.mobileAuth!.userId,
          agentId: proposal.agent_id,
          jobId: payload.data.jobId,
          deliverable: payload.data.deliverable,
          expiresAt: proposal.expires_at,
        });
        executionGrant = { id: grant.id, expiresAt: grant.expiresAt };
      }
    }
    await audit(db, {
      actorId: request.mobileAuth!.userId,
      action: `mcp.proposal_${decision}_mobile`,
      targetType: "mcp_proposal",
      targetId: id,
      requestId: request.requestId,
      metadata: { deviceId: request.mobileAuth!.deviceId },
    });
    response.json({ data: { ...proposal, executionGrant } });
  }),
);
