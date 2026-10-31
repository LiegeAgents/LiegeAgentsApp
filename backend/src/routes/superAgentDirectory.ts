import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../http.js";
import { hireableAgents } from "./hireKeys.js";

/**
 * Public: the Super Agents a client can hire right now in an asset (enrolled, verified, and
 * reachable), with their service, listed price, delivery time, and recorded track record. The
 * dashboard's milestone and retainer pickers list these.
 */
export const superAgentDirectoryRouter = Router();

superAgentDirectoryRouter.get(
  "/hireable",
  asyncRoute(async (request, response) => {
    const { asset } = z
      .object({ asset: z.enum(["usdg", "liege"]).default("usdg") })
      .parse(request.query);
    const agents = await hireableAgents(undefined, asset);
    response.set("cache-control", "public, max-age=60").json({
      data: agents.map((agent) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        serviceName: agent.service_name,
        description: agent.description,
        category: agent.category,
        priceUsd: agent.price_usd === null ? null : String(Number(agent.price_usd)),
        slaMinutes: agent.sla_minutes,
        verified: agent.verified,
        reputation: agent.reputation
          ? { score: agent.reputation.score, outcomes: agent.reputation.outcomes }
          : null,
      })),
    });
  }),
);
