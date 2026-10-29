import { InvalidArgumentError } from "commander";

export type MaskRange = [number, number];

// Commander collectors for --maskValue and --maskRange
export function collectMaskValue(
  value: string,
  previous: number[] = [],
): number[] {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`"${value}" is not a number.`);
  }
  return [...previous, parsed];
}

export function collectMaskRange(
  value: string,
  previous: MaskRange[] = [],
): MaskRange[] {
  const parts = value.split(",").map((part) => part.trim());
  const low = Number(parts[0]);
  const high = Number(parts[1]);
  if (
    parts.length !== 2 ||
    parts.some((part) => part === "") ||
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  ) {
    throw new InvalidArgumentError(
      `"${value}" must be two numbers separated by a comma, like -10001,-9999.`,
    );
  }
  // Written the wrong way round is taken as the same band
  return [...previous, [Math.min(low, high), Math.max(low, high)]];
}
