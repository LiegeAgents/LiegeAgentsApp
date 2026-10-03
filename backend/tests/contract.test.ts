import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app, routers } from "../src/app.js";
import { requireAuth, requireMobileAuth } from "../src/auth.js";
import { adminKey } from "./setup.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  openJob,
  rebuildSchema,
  signIn,
} from "./support.js";

// docs/openapi.yaml is the API contract; these tests fail when the routes or their responses
// drift from it.
type Schema = Record<string, any>;
const spec: Schema = Bun.YAML.parse(
  await Bun.file(new URL("../../docs/openapi.yaml", import.meta.url)).text(),
) as Schema;
const METHODS = ["get", "post", "put", "patch", "delete"];

function resolve(node: Schema | undefined): Schema | undefined {
  while (node?.$ref)
    node = node.$ref
      .slice(2)
      .split("/")
      .reduce((parent: Schema, key: string) => parent[key], spec);
  return node;
}

const isType = (type: string, value: unknown) =>
  type === "null"
    ? value === null
    : type === "array"
      ? Array.isArray(value)
      : type === "integer"
        ? Number.isInteger(value)
        : type === "object"
          ? typeof value === "object" && value !== null && !Array.isArray(value)
          : typeof value === type;

// The subset of JSON Schema the contract uses.
function validate(node: Schema, value: any, path = "$"): string[] {
  const schema = resolve(node)!;
  const errors: string[] = [];
  for (const part of schema.allOf ?? []) errors.push(...validate(part, value, path));
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((part: Schema) => !validate(part, value).length).length;
    if (matches !== 1) errors.push(`${path}: matches ${matches} oneOf branches`);
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${value} not in enum`);
  if (schema.type && ![schema.type].flat().some((type: string) => isType(type, value)))
    errors.push(`${path}: expected ${schema.type}, got ${JSON.stringify(value)}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value))
    errors.push(`${path}: ${value} does not match ${schema.pattern}`);
  if (isType("object", value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in value) errors.push(...validate(child as Schema, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}: unexpected ${key}`);
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((item, index) =>
      errors.push(...validate(schema.items, item, `${path}[${index}]`)),
    );
  return errors;
}

// Asserts the response's status is documented for the operation and its body matches.
function expectContract(
  method: string,
  route: string,
  response: { status: number; body: unknown },
) {
  const documented = resolve(spec.paths[route]?.[method]?.responses?.[String(response.status)]);
  expect({ method, route, status: response.status, documented: Boolean(documented) }).toEqual({
    method,
    route,
    status: response.status,
    documented: true,
  });
  const schema = documented!.content?.["application/json"]?.schema;
  if (schema)
    expect({ method, route, errors: validate(schema, response.body) }).toEqual({
      method,
      route,
      errors: [],
    });
}

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  handle: unknown;
};
function implementedRoutes() {
  const routes: { operation: string; path: string; authenticated: boolean }[] = [];
  const collect = (stack: Layer[], prefix: string) => {
    const guardedRouter = stack.some(
      (layer) =>
        !layer.route && (layer.handle === requireAuth || layer.handle === requireMobileAuth),
    );
    for (const layer of stack)
      if (layer.route) {
        const path = `${prefix}${layer.route.path === "/" ? "" : layer.route.path}`.replace(
          /:(\w+)/g,
          "{$1}",
        );
        const authenticated =
          guardedRouter ||
          layer.route.stack.some(
            (inner) => inner.handle === requireAuth || inner.handle === requireMobileAuth,
          );
        for (const method of Object.keys(layer.route.methods))
          routes.push({ operation: `${method.toUpperCase()} ${path}`, path, authenticated });
      }
  };
  collect((app as unknown as { router: { stack: Layer[] } }).router.stack, "");
  for (const [prefix, router] of routers) collect(router.stack as unknown as Layer[], prefix);
  return routes;
}

test("every route is documented and every documented operation exists", () => {
  const documented = Object.entries(spec.paths as Schema).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
  );
  const implemented = implementedRoutes().map((route) => route.operation);
  expect(implemented.sort()).toEqual(documented.sort());
});

test("each operation declares the authentication its route enforces", () => {
  for (const route of implementedRoutes()) {
    const [method] = route.operation.toLowerCase().split(" ");
    const security = spec.paths[route.path][method].security ?? spec.security ?? [];
    const expected =
      route.path.startsWith("/v1/mobile/overview") || route.path.startsWith("/v1/mobile/proposals/")
        ? [{ mobileAuth: [] }]
        : route.path.startsWith("/v1/cron/")
          ? [{ cronSecret: [] }]
          : route.authenticated
            ? [{ bearerAuth: [] }]
            : [];
    expect({ operation: route.operation, security }).toEqual({
      operation: route.operation,
      security: expected,
    });
  }
});

describe.skipIf(!databaseAvailable)("responses", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("every error uses the documented envelope with the request id", async () => {
    const owner = await signIn();
    await createAgent(owner);
    const agent = (await db.query("SELECT slug FROM agents")).rows[0];
    const failures = [
      ["post", "/v1/auth/nonce", 400, api().post("/v1/auth/nonce").send({ address: "0x12" })],
      [
        "post",
        "/v1/auth/nonce",
        400,
        api().post("/v1/auth/nonce").set("Content-Type", "application/json").send("{"),
      ],
      [
        "post",
        "/v1/auth/nonce",
        413,
        api()
          .post("/v1/auth/nonce")
          .send({ address: "x".repeat(200_000) }),
      ],
      ["get", "/v1/me", 401, api().get("/v1/me")],
      [
        "post",
        "/v1/agents",
        409,
        api().post("/v1/agents").set(bearer(owner)).send({
          slug: agent.slug,
          name: "Research Agent",
          description: "Produces research reports on request.",
          category: "research",
        }),
      ],
      ["get", "/v1/agents/{slug}", 404, api().get("/v1/agents/missing")],
    ] as const;
    for (const [method, route, status, pending] of failures) {
      const response = await pending;
      expect({ route, status: response.status }).toEqual({ route, status });
      expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
      expectContract(method, route, response);
    }
    // Unknown routes are outside the contract but share the envelope.
    const unknown = await api().get("/v1/nowhere").expect(404);
    expect(validate(spec.components.schemas.Error, unknown.body)).toEqual([]);
  });

  test("responses match the contract through a job's lifecycle", async () => {
    const check = async (method: string, route: string, pending: PromiseLike<any>) => {
      const response = await pending;
      expectContract(method, route, response);
      return response;
    };
    await check("get", "/health", api().get("/health"));
    await check("get", "/health/ready", api().get("/health/ready"));

    const [admin, client, provider, evaluator] = await Promise.all([
      signIn(adminKey),
      signIn(),
      signIn(),
      signIn(),
    ]);
    const agent = await check(
      "post",
      "/v1/agents",
      api().post("/v1/agents").set(bearer(provider)).send({
        slug: "research-agent",
        name: "Research Agent",
        description: "Produces research reports on request.",
        category: "research",
      }),
    );
    await check("get", "/v1/agents", api().get("/v1/agents"));
    await check("get", "/v1/agents/{slug}", api().get("/v1/agents/research-agent"));

    await credit(evaluator.userId, 5000);
    await check(
      "post",
      "/v1/admin/evaluators/stake",
      api()
        .post("/v1/admin/evaluators/stake")
        .set(bearer(admin))
        .send({ userId: evaluator.userId, stakeUsdg: 5000, reference: "stake-contract" }),
    );
    await check(
      "put",
      "/v1/evaluators/me",
      api().put("/v1/evaluators/me").set(bearer(evaluator)).send({ active: true }),
    );
    await check("get", "/v1/evaluators/me", api().get("/v1/evaluators/me").set(bearer(evaluator)));
    await check("get", "/v1/evaluators/me", api().get("/v1/evaluators/me").set(bearer(client)));
    await check("get", "/v1/evaluators", api().get("/v1/evaluators"));
    await check(
      "post",
      "/v1/admin/ledger/credit",
      api()
        .post("/v1/admin/ledger/credit")
        .set(bearer(admin))
        .send({ userId: client.userId, amountUsdg: 500, reference: "credit-contract" }),
    );

    const opened = await check(
      "post",
      "/v1/jobs",
      openJob(client, agent.body.data.id, 400, {
        evaluatorId: evaluator.userId,
        evaluatorFeeUsdg: 5,
      }),
    );
    const jobId = opened.body.data.id;
    await check("get", "/v1/jobs", api().get("/v1/jobs").set(bearer(client)));
    await check(
      "post",
      "/v1/jobs/{id}/fund",
      api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}),
    );
    await check(
      "post",
      "/v1/jobs/{id}/submit",
      api()
        .post(`/v1/jobs/${jobId}/submit`)
        .set(bearer(provider))
        .send({ deliverable: "Report attached.", evidence: ["https://example.com/report"] }),
    );
    await check(
      "post",
      "/v1/jobs/{id}/evaluate",
      api()
        .post(`/v1/jobs/${jobId}/evaluate`)
        .set(bearer(evaluator))
        .send({ outcome: "accepted", rationale: "Meets the criteria." }),
    );
    await check("get", "/v1/jobs/{id}", api().get(`/v1/jobs/${jobId}`).set(bearer(client)));
    await check("get", "/v1/me", api().get("/v1/me").set(bearer(provider)));
    await check("get", "/v1/me/ledger", api().get("/v1/me/ledger").set(bearer(client)));
    await check(
      "post",
      "/v1/jobs/{id}/funding-quote",
      api().post(`/v1/jobs/${jobId}/funding-quote`).set(bearer(client)),
    );

    await check(
      "get",
      "/v1/admin/settlements",
      api().get("/v1/admin/settlements").set(bearer(admin)),
    );
    await check(
      "post",
      "/v1/admin/settlements/{jobId}/retry",
      api().post(`/v1/admin/settlements/${jobId}/retry`).set(bearer(admin)),
    );
    const cron = { "x-cron-secret": process.env.CRON_SECRET! };
    await check(
      "post",
      "/v1/cron/expire-jobs",
      api().post("/v1/cron/expire-jobs").set(cron).send({ idempotencyKey: "contract-run" }),
    );
    await check("post", "/v1/cron/settle-escrows", api().post("/v1/cron/settle-escrows").set(cron));
    await check("post", "/v1/auth/logout", api().post("/v1/auth/logout").set(bearer(client)));
  });
});
