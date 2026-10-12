import type { FieldSeason } from "./rotation";

export const MAX_FIELD_SEASON_BODY_BYTES = 1_000_000;

export class LocalOnlyAccessError extends Error {}

export function requireLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
    throw new LocalOnlyAccessError(
      "Rotation records are available only from this computer.",
    );
  }
}

export class FieldSeasonInputError extends Error {
  readonly status: 400 | 413;

  constructor(
    message: string,
    status: 400 | 413 = 400,
  ) {
    super(message);
    this.status = status;
  }
}

function validDate(value: unknown) {
  if (typeof value !== "string") return false;
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validFieldSeasonRecords(value: unknown): value is FieldSeason[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 500 &&
    value.every(
      (record) =>
        record &&
        typeof record === "object" &&
        typeof record.id === "string" &&
        record.id.trim().length > 0 &&
        typeof record.fieldId === "string" &&
        record.fieldId.trim().length > 0 &&
        typeof record.fieldName === "string" &&
        record.fieldName.trim().length > 0 &&
        Number.isInteger(record.harvestYear) &&
        record.harvestYear >= 1900 &&
        record.harvestYear <= 2200 &&
        validDate(record.sowingDate) &&
        validDate(record.harvestDate),
    )
  );
}

async function readLimitedText(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FIELD_SEASON_BODY_BYTES) {
    throw new FieldSeasonInputError("The request body is too large.", 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FIELD_SEASON_BODY_BYTES) {
      await reader.cancel();
      throw new FieldSeasonInputError("The request body is too large.", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readFieldSeasonRecords(
  request: Request,
  property: "records" | "record",
) {
  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(request));
  } catch (error) {
    if (error instanceof FieldSeasonInputError) throw error;
    throw new FieldSeasonInputError("The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object") {
    throw new FieldSeasonInputError("The request body must be a JSON object.");
  }
  const source = (body as Record<string, unknown>)[property];
  const records = property === "record" ? (source ? [source] : []) : source;
  if (!validFieldSeasonRecords(records)) {
    throw new FieldSeasonInputError(
      property === "record"
        ? "A valid field-season record is required."
        : "Provide between 1 and 500 valid field-season records.",
    );
  }
  return records;
}
