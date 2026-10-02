export type SettlementAsset = "usdg" | "liege" | "usdc" | "usde";

export const ASSET_DECIMALS: Record<SettlementAsset, number> = {
  usdg: 6,
  liege: 18,
  usdc: 6,
  usde: 18,
};

export function assetLabel(asset: SettlementAsset | string) {
  switch (asset?.toLowerCase()) {
    case "liege":
      return "LIEGE";
    case "usdc":
      return "USDC";
    case "usde":
      return "USDe";
    case "usdg":
    default:
      return "USDG";
  }
}
