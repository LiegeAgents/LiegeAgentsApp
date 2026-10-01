import { describe, expect, test } from "bun:test";
import { decimalToAtomic, decodePaymentSignature, encodePaymentRequired } from "../src/x402.js";

describe("x402 adapter primitives", () => {
  test("converts USDG amounts without floating-point rounding", () => {
    expect(decimalToAtomic("12.5", 6)).toBe("12500000");
    expect(decimalToAtomic("0.000001", 6)).toBe("1");
  });

  test("round-trips the standard payment-required header payload", () => {
    const payload = { x402Version: 2, accepts: [], resource: { url: "https://example.test" } };
    expect(
      JSON.parse(Buffer.from(encodePaymentRequired(payload as never), "base64").toString()),
    ).toEqual(payload);
    expect(decodePaymentSignature(encodePaymentRequired(payload as never))).toEqual(payload);
  });
});
