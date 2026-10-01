export type SettlementAsset = "usdg" | "liege";

export const ASSET_DECIMALS: Record<SettlementAsset, number> = {
  usdg: 6,
  liege: 18,
};

export function assetLabel(asset: SettlementAsset) {
  return asset === "liege" ? "LIEGE" : "USDG";
}
