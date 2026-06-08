import path from "path";
import mime from "mime-types";
import { db, mediaObjectsTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

export interface SaveTenantMediaResult {
  // URL to store in DB / return to the client. Routes through the shared proxy
  // to the api-server's tenant-scoped object-serving route.
  url: string;
  // Normalized "/objects/..." path (what is persisted in media_objects).
  objectPath: string;
  sizeBytes: number;
}

function extFor(contentType?: string, preferredFilename?: string): string {
  if (preferredFilename) {
    const e = path.extname(preferredFilename);
    if (e && /^\.[a-z0-9]+$/i.test(e)) return e;
  }
  if (contentType) {
    const e = mime.extension(contentType);
    if (e) return `.${e}`;
  }
  return "";
}

// Upload a server-side buffer to Object Storage under the tenant's prefix and
// record a media_objects ledger row (the source of truth for per-tenant storage
// usage, retention, and reset). Returns the URL to persist in the owning table.
export async function saveTenantMedia(opts: {
  ownerUserId: number;
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  channelId?: number | null;
  preferredFilename?: string;
}): Promise<SaveTenantMediaResult> {
  const ext = extFor(opts.contentType, opts.preferredFilename);
  const { objectPath, sizeBytes } = await objectStorage.uploadTenantBuffer({
    ownerUserId: opts.ownerUserId,
    buffer: opts.buffer,
    contentType: opts.contentType,
    kind: opts.kind,
    ext,
  });
  await db.insert(mediaObjectsTable).values({
    ownerUserId: opts.ownerUserId,
    channelId: opts.channelId ?? null,
    objectPath,
    sizeBytes,
    contentType: opts.contentType ?? null,
    kind: opts.kind ?? null,
  });
  return { url: `/api/storage${objectPath}`, objectPath, sizeBytes };
}
