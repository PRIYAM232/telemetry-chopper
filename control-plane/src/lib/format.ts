// Display formatting shared by the server-rendered dashboard and its client
// islands (no server-only imports here).

// Sub-cent amounts keep two significant digits instead of a fixed number of
// decimals.
const subCentUSDFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});

export function formatUSD(value: number): string {
  // Dev fleets drop kilobytes, not terabytes: priced per GB, their savings
  // are fractions of a cent — $0.000022, not a misleading $0.0000.
  if (value > 0 && value < 0.01) return subCentUSDFmt.format(value);
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Decimal units, matching how vendors bill (and BYTES_PER_GB).
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
