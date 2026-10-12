import { listSeasons, ownerKey, upsertSeasons } from "@/db/rotation";
import {
  FieldSeasonInputError,
  LocalOnlyAccessError,
  readFieldSeasonRecords,
  requireLocalRequest,
} from "@/lib/field-season-input";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof LocalOnlyAccessError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof FieldSeasonInputError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: fallback }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    requireLocalRequest(request);
    const records = await listSeasons(ownerKey());
    return Response.json({ records });
  } catch (error) {
    return errorResponse(error, "Rotation records could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    requireLocalRequest(request);
    const records = await readFieldSeasonRecords(request, "records");
    const key = ownerKey();
    await upsertSeasons(key, records);
    return Response.json({ records: await listSeasons(key) });
  } catch (error) {
    return errorResponse(error, "Rotation records could not be saved.");
  }
}

export async function PATCH(request: Request) {
  try {
    requireLocalRequest(request);
    const records = await readFieldSeasonRecords(request, "record");
    const key = ownerKey();
    await upsertSeasons(key, records);
    return Response.json({ records: await listSeasons(key) });
  } catch (error) {
    return errorResponse(error, "The field-season record could not be updated.");
  }
}
