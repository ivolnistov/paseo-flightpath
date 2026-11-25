import { createHash } from "node:crypto";

/** SHA-256 as lowercase hex; strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
