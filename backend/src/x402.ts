import { env } from "./config.js";

export type X402PaymentRequirements = {
  scheme: "exact";
  network: `eip155:${number}`;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: "eip3009" };
};

export type X402PaymentRequired = {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: "application/json" };
  accepts: [X402PaymentRequirements];
  extensions: Record<string, never>;
};

type FacilitatorVerification = { isValid: boolean; payer?: string; invalidReason?: string };
type FacilitatorSettlement = {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  errorReason?: string;
};

const address = /^0x[0-9a-fA-F]{40}$/;
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export function x402Configured() {
  return Boolean(env.X402_FACILITATOR_URL && env.USDG_TOKEN_ADDRESS);
}

export function decimalToAtomic(value: string, decimals = env.USDG_DECIMALS) {
  const [whole, fraction = ""] = value.split(".");
  const padded = fraction.padEnd(decimals, "0");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals)
    throw new Error("The invoice amount cannot be represented in token units.");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

export function paymentRequired(
  invoice: {
    id: string;
    description: string;
    amount_usdg: string;
    expires_at: Date;
    issuer_wallet?: string;
  },
  resourceUrl: string,
  error?: string,
): X402PaymentRequired {
  if (!invoice.issuer_wallet || !address.test(invoice.issuer_wallet))
    throw new Error("The invoice issuer does not have a valid payment wallet.");
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl, description: invoice.description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${env.RHC_ID}`,
        amount: decimalToAtomic(invoice.amount_usdg),
        asset: env.USDG_TOKEN_ADDRESS!,
        payTo: invoice.issuer_wallet,
        maxTimeoutSeconds: env.X402_MAX_TIMEOUT_SECONDS,
        extra: {
          name: env.USDG_TOKEN_NAME,
          version: env.USDG_TOKEN_VERSION,
          assetTransferMethod: "eip3009",
        },
      },
    ],
    extensions: {},
  };
}

export function encodePaymentRequired(value: X402PaymentRequired) {
  return base64(value);
}

export function decodePaymentSignature(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (!decoded || typeof decoded !== "object") throw new Error("not an object");
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error("PAYMENT-SIGNATURE must be base64-encoded JSON.");
  }
}

async function facilitator(path: "/verify" | "/settle", body: object) {
  if (!env.X402_FACILITATOR_URL) throw new Error("x402 facilitator is not configured.");
  const response = await fetch(new URL(path, `${env.X402_FACILITATOR_URL.replace(/\/$/, "")}/`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    // Never hold an invoice lock on a remote facilitator for longer than a short request window.
    signal: AbortSignal.timeout(Math.min(env.X402_MAX_TIMEOUT_SECONDS + 5, 30) * 1000),
  });
  if (!response.ok) throw new Error(`x402 facilitator returned HTTP ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function verifyPayment(
  paymentPayload: Record<string, unknown>,
  requirements: X402PaymentRequirements,
) {
  return (await facilitator("/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: requirements,
  })) as FacilitatorVerification;
}

export async function settlePayment(
  paymentPayload: Record<string, unknown>,
  requirements: X402PaymentRequirements,
) {
  return (await facilitator("/settle", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: requirements,
  })) as FacilitatorSettlement;
}

export const encodeSettlementResponse = (value: FacilitatorSettlement) => base64(value);
