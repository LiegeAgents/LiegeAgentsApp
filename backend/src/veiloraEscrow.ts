import type { PoolClient } from "pg";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  recoverAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config.js";
import { ApiError } from "./http.js";
import { db } from "./db/index.js";
import type { SettlementAsset } from "./assets.js";

export type VeiloraEscrowTerms = {
  factoryVersion: number;
  jobId: `0x${string}`;
  asset: Address;
  budget: string;
  evaluatorFee: string;
  client: Address;
  provider: Address;
  evaluator: Address;
  liegeSigner: Address;
  legionCapBps: number;
  acceptBy: string;
  submitBy: string;
  evaluateWithin: string;
  expiresAt: string;
  briefCommit: `0x${string}`;
  legionRecipients: Address[];
};
type VeiloraEscrowTermsCall = Omit<VeiloraEscrowTerms, "budget" | "evaluatorFee" | "acceptBy" | "submitBy" | "evaluateWithin" | "expiresAt"> & {
  budget: bigint;
  evaluatorFee: bigint;
  acceptBy: bigint;
  submitBy: bigint;
  evaluateWithin: bigint;
  expiresAt: bigint;
};

const chain = defineChain({
  id: env.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
});
const client = createPublicClient({ chain, transport: http(env.RHC_RPC_URL) });
const factoryAbi = parseAbi([
  "function predictEscrow((uint32 factoryVersion,bytes32 jobId,address asset,uint256 budget,uint256 evaluatorFee,address client,address provider,address evaluator,address liegeSigner,uint16 legionCapBps,uint64 acceptBy,uint64 submitBy,uint64 evaluateWithin,uint64 expiresAt,bytes32 briefCommit,address[] legionRecipients) terms) view returns (address)",
  "function isEscrow(address escrow) view returns (bool)",
  "event EscrowCreated(bytes32 indexed jobId,address indexed escrow,bytes32 indexed termsHash)",
]);
const escrowAbi = parseAbi([
  "function requiredFunding() view returns (uint256)",
  "function closed() view returns (bool)",
  "function submittedAt() view returns (uint64)",
  "function outcomeNonce() view returns (uint256)",
  "function hashOutcome(bytes32 action,bytes32 payloadHash) view returns (bytes32)",
  "function isFunded() view returns (bool)",
  "function accepted() view returns (bool)",
  "function providerNonce() view returns (uint256)",
  "function termsHash() view returns (bytes32)",
  "function release((address recipient,uint256 amount)[] legion,bytes[] signatures)",
  "function refund(bytes[] signatures)",
  "event EscrowClosed(bytes32 indexed jobId,bytes32 indexed outcome)",
  "event DeliverableSubmitted(bytes32 indexed jobId,bytes32 indexed deliverableCommit,uint64 submittedAt)",
]);
const tokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const transferEventAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

function factoryAddress(): Address {
  if (!env.VEILORA_ESCROW_FACTORY_ADDRESS)
    throw new ApiError(503, "veilora_escrow_unconfigured", "Veilora escrow is not configured.");
  return getAddress(env.VEILORA_ESCROW_FACTORY_ADDRESS);
}

function tokenAddress(asset: SettlementAsset): Address {
  const value = asset === "liege" ? env.LIEGE_TOKEN_ADDRESS : env.USDG_TOKEN_ADDRESS;
  if (!value)
    throw new ApiError(503, "escrow_asset_unconfigured", `The ${asset.toUpperCase()} token is not configured.`);
  return getAddress(value);
}

function toTerms(value: Record<string, unknown>): VeiloraEscrowTerms {
  const parsed = value as VeiloraEscrowTerms;
  return {
    ...parsed,
    asset: getAddress(parsed.asset),
    client: getAddress(parsed.client),
    provider: getAddress(parsed.provider),
    evaluator: getAddress(parsed.evaluator),
    liegeSigner: getAddress(parsed.liegeSigner),
    legionRecipients: parsed.legionRecipients.map((recipient) => getAddress(recipient)),
  };
}

function termsCall(terms: VeiloraEscrowTerms): VeiloraEscrowTermsCall {
  return {
    ...terms,
    budget: BigInt(terms.budget),
    evaluatorFee: BigInt(terms.evaluatorFee),
    acceptBy: BigInt(terms.acceptBy),
    submitBy: BigInt(terms.submitBy),
    evaluateWithin: BigInt(terms.evaluateWithin),
    expiresAt: BigInt(terms.expiresAt),
  };
}

export async function prepareVeiloraEscrow(clientDb: PoolClient, jobId: string) {
  factoryAddress();
  if (!env.LIEGE_ESCROW_SIGNER_ADDRESS)
    throw new ApiError(503, "veilora_escrow_unconfigured", "The Liege escrow signer is not configured.");
  await clientDb.query("BEGIN");
  try {
    const jobResult = await clientDb.query<{
      id: string;
      status: string;
      escrow_mode: string;
      settlement_asset: SettlementAsset;
      budget_amount: string;
      evaluator_fee_amount: string;
      brief_hash: string;
      deadline_at: Date;
      expires_at: Date;
      client_address: string;
      provider_address: string;
      evaluator_address: string;
      veilora_escrow_terms: Record<string, unknown> | null;
    }>(
      `SELECT j.id, j.status, j.escrow_mode, COALESCE(j.settlement_asset, 'usdg') AS settlement_asset,
        COALESCE(j.budget_amount, j.budget_usdg) AS budget_amount,
        CASE WHEN COALESCE(j.settlement_asset, 'usdg') = 'usdg'
          THEN COALESCE(j.evaluator_fee_usdg, j.evaluator_fee_amount, 0)
          ELSE COALESCE(j.evaluator_fee_amount, 0) END AS evaluator_fee_amount,
        j.brief_hash, j.deadline_at, j.expires_at, c.wallet_address AS client_address,
        p.wallet_address AS provider_address, COALESCE(e.wallet_address, c.wallet_address) AS evaluator_address,
        j.veilora_escrow_terms
       FROM jobs j JOIN users c ON c.id = j.client_id
       JOIN agents a ON a.id = j.agent_id JOIN users p ON p.id = a.owner_id
       LEFT JOIN users e ON e.id = j.evaluator_id
       WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId],
    );
    if (!jobResult.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
    const job = jobResult.rows[0];
    if (job.status !== "open" || job.escrow_mode !== "veilora")
      throw new ApiError(409, "veilora_funding_unavailable", "This job is not ready for Veilora escrow funding.");

    let terms: VeiloraEscrowTerms;
    const stored = job.veilora_escrow_terms;
    if (stored) {
      terms = toTerms(stored);
    } else {
      const recipients = await clientDb.query<{ wallet_address: string; allocation_bps: number }>(
        `SELECT u.wallet_address, sum(la.allocation_bps)::int AS allocation_bps
         FROM legion_assignments la JOIN legions l ON l.id = la.legion_id
         JOIN agents a ON a.id = la.agent_id JOIN users u ON u.id = a.owner_id
         WHERE l.job_id = $1 AND la.status <> 'declined'
           AND lower(u.wallet_address) NOT IN (lower($2), lower($3), lower($4), lower($5))
         GROUP BY lower(u.wallet_address), u.wallet_address ORDER BY lower(u.wallet_address)
         LIMIT 64`,
        [jobId, job.client_address, job.provider_address, job.evaluator_address, env.LIEGE_ESCROW_SIGNER_ADDRESS],
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      const acceptBy = nowSeconds + 60 * 60;
      const submitBy = Math.floor(job.deadline_at.getTime() / 1000);
      if (submitBy <= acceptBy)
        throw new ApiError(409, "job_deadline_too_soon", "The job deadline must leave at least one hour for provider acceptance.");
      const cap = Math.min(10_000, recipients.rows.reduce((sum, row) => sum + row.allocation_bps, 0));
      if (recipients.rows.length > 64)
        throw new ApiError(422, "legion_recipients_limit", "Veilora escrow supports at most 64 legion recipients.");
      const decimals = job.settlement_asset === "liege" ? env.LIEGE_DECIMALS : env.USDG_DECIMALS;
      terms = {
        factoryVersion: 1,
        jobId: keccak256(stringToHex(job.id)),
        asset: tokenAddress(job.settlement_asset),
        budget: parseUnits(String(job.budget_amount), decimals).toString(),
        evaluatorFee: parseUnits(String(job.evaluator_fee_amount), decimals).toString(),
        client: getAddress(job.client_address),
        provider: getAddress(job.provider_address),
        evaluator: getAddress(job.evaluator_address),
        liegeSigner: getAddress(env.LIEGE_ESCROW_SIGNER_ADDRESS),
        legionCapBps: cap,
        acceptBy: String(acceptBy),
        submitBy: String(submitBy),
        evaluateWithin: String(72 * 60 * 60),
        expiresAt: String(submitBy + 90 * 24 * 60 * 60),
        briefCommit: keccak256(stringToHex(job.brief_hash)),
        legionRecipients: recipients.rows.map((row) => getAddress(row.wallet_address)),
      };
      const escrowAddress = await client.readContract({
        address: factoryAddress(),
        abi: factoryAbi,
        functionName: "predictEscrow",
        args: [termsCall(terms)],
      });
      await clientDb.query(
        "UPDATE jobs SET veilora_escrow_terms = $2::jsonb, veilora_escrow_address = $3, veilora_terms_locked_at = now(), updated_at = now() WHERE id = $1",
        [jobId, JSON.stringify(terms), escrowAddress.toLowerCase()],
      );
    }
    const escrowAddress = await client.readContract({
      address: factoryAddress(), abi: factoryAbi, functionName: "predictEscrow", args: [termsCall(terms)],
    });
    await clientDb.query("COMMIT");
    return { factoryAddress: factoryAddress(), escrowAddress, terms };
  } catch (error) {
    await clientDb.query("ROLLBACK");
    throw error;
  }
}

export async function verifyVeiloraFunding(input: {
  factoryTxHash?: `0x${string}`;
  tokenTxHash: `0x${string}`;
  escrowAddress: Address;
  tokenAddress: Address;
  clientAddress: Address;
  jobId: `0x${string}`;
  expectedAmount: bigint;
}) {
  const [factoryReceipt, tokenReceipt] = await Promise.all([
    input.factoryTxHash ? client.waitForTransactionReceipt({ hash: input.factoryTxHash, confirmations: env.ESCROW_CONFIRMATIONS }) : Promise.resolve(null),
    client.waitForTransactionReceipt({ hash: input.tokenTxHash, confirmations: env.ESCROW_CONFIRMATIONS }),
  ]);
  if ((factoryReceipt && factoryReceipt.status !== "success") || tokenReceipt.status !== "success")
    throw new ApiError(422, "veilora_funding_transaction_failed", "The escrow creation and token transfer transactions must succeed.");
  if (factoryReceipt) {
    const created = factoryReceipt.logs.some((log) => {
      if (log.address.toLowerCase() !== factoryAddress().toLowerCase()) return false;
      try {
        const event = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
        return event.eventName === "EscrowCreated" &&
          event.args.jobId.toLowerCase() === input.jobId.toLowerCase() &&
          event.args.escrow.toLowerCase() === input.escrowAddress.toLowerCase();
      } catch { return false; }
    });
    if (!created)
      throw new ApiError(422, "veilora_escrow_creation_unverified", "The factory transaction did not create this job's escrow.");
  }
  const transferred = tokenReceipt.logs.some((log) => {
    if (log.address.toLowerCase() !== input.tokenAddress.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: transferEventAbi, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" &&
        event.args.from.toLowerCase() === input.clientAddress.toLowerCase() &&
        event.args.to.toLowerCase() === input.escrowAddress.toLowerCase() &&
        event.args.value >= input.expectedAmount;
    } catch { return false; }
  });
  if (!transferred)
    throw new ApiError(422, "veilora_token_transfer_unverified", "The token transaction does not show the required transfer from the client into this escrow.");
  const registered = await client.readContract({
    address: factoryAddress(), abi: factoryAbi, functionName: "isEscrow", args: [input.escrowAddress],
  });
  if (!registered)
    throw new ApiError(422, "veilora_escrow_not_created", "Create the Veilora escrow contract before funding it.");
  const [required, balance] = await Promise.all([
    client.readContract({ address: input.escrowAddress, abi: escrowAbi, functionName: "requiredFunding" }),
    client.readContract({ address: input.tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [input.escrowAddress] }),
  ]);
  if (required !== input.expectedAmount || balance < required)
    throw new ApiError(422, "veilora_escrow_underfunded", "The escrow must hold the budget and evaluator fee before the job can start.");
  return { escrowAddress: input.escrowAddress, tokenAmountRaw: balance.toString() };
}

export async function verifyVeiloraSubmission(input: {
  jobId: string;
  transactionHash: `0x${string}`;
  deliverableCommit: `0x${string}`;
}) {
  const job = await db.query<{ veilora_escrow_address: Address | null; veilora_escrow_terms: VeiloraEscrowTerms | null }>(
    "SELECT veilora_escrow_address, veilora_escrow_terms FROM jobs WHERE id = $1 AND escrow_mode = 'veilora'",
    [input.jobId],
  );
  if (!job.rowCount || !job.rows[0].veilora_escrow_address || !job.rows[0].veilora_escrow_terms)
    throw new ApiError(409, "veilora_terms_missing", "This job does not have Veilora escrow terms.");
  const escrowAddress = getAddress(job.rows[0].veilora_escrow_address);
  const receipt = await client.waitForTransactionReceipt({ hash: input.transactionHash, confirmations: env.ESCROW_CONFIRMATIONS });
  if (receipt.status !== "success")
    throw new ApiError(422, "veilora_submission_failed", "The provider's on-chain submission transaction failed.");
  const terms = toTerms(job.rows[0].veilora_escrow_terms as unknown as Record<string, unknown>);
  const submitted = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      return event.eventName === "DeliverableSubmitted" &&
        event.args.jobId.toLowerCase() === terms.jobId.toLowerCase() &&
        event.args.deliverableCommit.toLowerCase() === input.deliverableCommit.toLowerCase();
    } catch { return false; }
  });
  if (!submitted)
    throw new ApiError(422, "veilora_submission_unverified", "The transaction did not submit this job's deliverable commitment.");
}

const OUTCOME_TYPES = {
  Outcome: [
    { name: "action", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
const RELEASE_ACTION = keccak256(stringToHex("RELEASE"));
const REFUND_ACTION = keccak256(stringToHex("REFUND"));
const RELEASE_OUTCOME = RELEASE_ACTION;
const REFUND_OUTCOME = REFUND_ACTION;

async function outcomeContext(jobId: string, outcome: "accepted" | "rejected") {
  const result = await dbJob(jobId);
  const { escrowAddress, terms } = result;
  const action = outcome === "accepted" ? RELEASE_ACTION : REFUND_ACTION;
  let payouts: Array<{ recipient: Address; amount: bigint }> = [];
  if (outcome === "accepted") {
    const rows = await db.query<{ wallet_address: string; allocation_bps: number }>(
      `SELECT u.wallet_address, sum(la.allocation_bps)::int AS allocation_bps
       FROM legion_assignments la JOIN legions l ON l.id = la.legion_id
       JOIN agents a ON a.id = la.agent_id JOIN users u ON u.id = a.owner_id
       WHERE l.job_id = $1 AND la.status = 'submitted'
       GROUP BY lower(u.wallet_address), u.wallet_address ORDER BY lower(u.wallet_address)`,
      [jobId],
    );
    const roles = new Set([terms.client, terms.provider, terms.evaluator, terms.liegeSigner].map((x) => x.toLowerCase()));
    const byRecipient = new Map<string, bigint>();
    for (const row of rows.rows) {
      const recipient = getAddress(row.wallet_address);
      if (roles.has(recipient.toLowerCase())) continue;
      if (!terms.legionRecipients.some((item) => item.toLowerCase() === recipient.toLowerCase())) continue;
      const amount = (BigInt(terms.budget) * BigInt(row.allocation_bps)) / 10_000n;
      if (amount > 0n) byRecipient.set(recipient, (byRecipient.get(recipient) ?? 0n) + amount);
    }
    payouts = [...byRecipient.entries()].map(([recipient, amount]) => ({ recipient: getAddress(recipient), amount }));
    const delegated = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
    if (delegated > (BigInt(terms.budget) * BigInt(terms.legionCapBps)) / 10_000n)
      throw new ApiError(409, "legion_budget_exceeded", "Submitted legion shares exceed the immutable escrow cap.");
  }
  const payloadHash = outcome === "accepted"
    ? keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }] }], [payouts]))
    : `0x${"0".repeat(64)}` as Hex;
  const [nonce, funded, closed] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "outcomeNonce" }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "isFunded" }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "closed" }),
  ]);
  if (!funded || closed)
    throw new ApiError(409, closed ? "veilora_escrow_closed" : "veilora_escrow_unfunded", "This Veilora escrow is not available for settlement.");
  const digest = await client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "hashOutcome", args: [action, payloadHash] });
  return {
    ...result,
    action,
    payloadHash,
    digest,
    nonce,
    payouts,
    outcome,
    typedData: {
      domain: { name: "VeiloraEscrow", version: "1", chainId: env.RHC_ID, verifyingContract: escrowAddress },
      types: OUTCOME_TYPES,
      primaryType: "Outcome" as const,
      message: { action, payloadHash, nonce },
    },
  };
}

async function dbJob(jobId: string) {
  const result = await db.query<{ status: string; escrow_mode: string; veilora_escrow_address: Address; veilora_escrow_terms: VeiloraEscrowTerms }>(
    "SELECT status, escrow_mode, veilora_escrow_address, veilora_escrow_terms FROM jobs WHERE id = $1",
    [jobId],
  );
  const job = result.rows[0];
  if (!job || job.escrow_mode !== "veilora" || !job.veilora_escrow_address || !job.veilora_escrow_terms)
    throw new ApiError(409, "veilora_terms_missing", "This job does not have Veilora escrow terms.");
  if (job.status !== "submitted")
    throw new ApiError(409, "veilora_evaluation_unavailable", "Only a submitted job can be evaluated.");
  return { escrowAddress: getAddress(job.veilora_escrow_address), terms: toTerms(job.veilora_escrow_terms as unknown as Record<string, unknown>) };
}

export async function previewVeiloraOutcome(jobId: string, outcome: "accepted" | "rejected") {
  const context = await outcomeContext(jobId, outcome);
  return {
    digest: context.digest,
    payloadHash: context.payloadHash,
    action: context.action,
    nonce: context.nonce.toString(),
    payouts: context.payouts.map((payout) => ({ recipient: payout.recipient, amount: payout.amount.toString() })),
    typedData: { ...context.typedData, message: { ...context.typedData.message, nonce: context.nonce.toString() } },
  };
}

export async function settleVeiloraOutcome(input: {
  jobId: string;
  outcome: "accepted" | "rejected";
  evaluatorAddress: Address;
  evaluatorSignature: Hex;
}) {
  const context = await outcomeContext(input.jobId, input.outcome);
  const signerAddress = await recoverAddress({ hash: context.digest, signature: input.evaluatorSignature });
  if (signerAddress.toLowerCase() !== input.evaluatorAddress.toLowerCase() || signerAddress.toLowerCase() !== context.terms.evaluator.toLowerCase())
    throw new ApiError(422, "invalid_evaluator_signature", "The outcome signature must come from the assigned evaluator.");
  if (!env.LIEGE_ESCROW_SIGNER_PRIVATE_KEY)
    throw new ApiError(503, "veilora_signer_unavailable", "The Liege threshold signer is not configured.");
  const account = privateKeyToAccount(env.LIEGE_ESCROW_SIGNER_PRIVATE_KEY as Hex);
  if (account.address.toLowerCase() !== context.terms.liegeSigner.toLowerCase())
    throw new ApiError(503, "veilora_signer_mismatch", "The configured Liege signer does not match the immutable job terms.");
  const liegeSignature = await account.sign({ hash: context.digest });
  const walletClient = createWalletClient({ account, chain, transport: http(env.RHC_RPC_URL) });
  const txHash = input.outcome === "accepted"
    ? await walletClient.writeContract({ address: context.escrowAddress, abi: escrowAbi, functionName: "release", args: [context.payouts, [input.evaluatorSignature, liegeSignature]] })
    : await walletClient.writeContract({ address: context.escrowAddress, abi: escrowAbi, functionName: "refund", args: [[input.evaluatorSignature, liegeSignature]] });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: env.ESCROW_CONFIRMATIONS });
  if (receipt.status !== "success") throw new ApiError(422, "veilora_settlement_failed", "The escrow rejected the signed outcome.");
  const expectedOutcome = input.outcome === "accepted" ? RELEASE_OUTCOME : REFUND_OUTCOME;
  const closedEvent = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== context.escrowAddress.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      return event.eventName === "EscrowClosed" && event.args.jobId.toLowerCase() === context.terms.jobId.toLowerCase() && event.args.outcome.toLowerCase() === expectedOutcome.toLowerCase();
    } catch { return false; }
  });
  if (!closedEvent) throw new ApiError(422, "veilora_settlement_unverified", "The transaction did not close this job escrow with the expected outcome.");
  return { txHash, digest: context.digest };
}
