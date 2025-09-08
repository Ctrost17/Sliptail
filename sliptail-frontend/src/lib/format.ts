export const formatUSD = (cents: number) =>
(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });