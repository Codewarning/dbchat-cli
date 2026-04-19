/**
 * Detect whether a runtime value is a valid JavaScript Date instance.
 */
export function isDateValue(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Format one Date into a readable, timezone-explicit UTC string for CLI and model output.
 */
export function formatDateValue(value: Date): string {
  return value.toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}

const SCIENTIFIC_NOTATION_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

function trimExpandedDecimal(value: string): string {
  if (!value.includes(".")) {
    return value;
  }

  const trimmed = value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * Expand scientific notation such as `1.23e-7` into a plain decimal string.
 */
export function expandScientificNotation(value: string): string {
  const match = value.trim().match(SCIENTIFIC_NOTATION_PATTERN);
  if (!match) {
    return value;
  }

  const [, sign, integerPart, fractionalPart = "", exponentText] = match;
  const exponent = Number.parseInt(exponentText, 10);
  const digits = `${integerPart}${fractionalPart}`;
  const decimalIndex = integerPart.length;
  const shiftedIndex = decimalIndex + exponent;

  if (/^0+$/.test(digits)) {
    return "0";
  }

  let expanded: string;
  if (shiftedIndex <= 0) {
    expanded = `0.${"0".repeat(Math.abs(shiftedIndex))}${digits}`;
  } else if (shiftedIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(shiftedIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, shiftedIndex)}.${digits.slice(shiftedIndex)}`;
  }

  return `${sign}${trimExpandedDecimal(expanded)}`;
}

/**
 * Format one finite JavaScript number for readable SQL result display.
 * Scientific notation is expanded into a plain decimal string.
 */
export function formatNumberValue(value: number): number | string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  const serialized = String(value);
  return /e/i.test(serialized) ? expandScientificNotation(serialized) : value;
}

/**
 * Format one runtime scalar for SQL preview/display contexts without changing execution semantics.
 */
export function formatSqlDisplayScalar(value: unknown): string | number | boolean | null | undefined {
  if (value == null || typeof value === "boolean") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.length ? `0x${value.toString("hex")}` : "0x";
  }

  if (isDateValue(value)) {
    return formatDateValue(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    return formatNumberValue(value);
  }

  if (typeof value === "string") {
    return /e/i.test(value) ? expandScientificNotation(value) : value;
  }

  return undefined;
}
