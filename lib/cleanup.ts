import { unlink } from "node:fs/promises";

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // File may not exist — ignore
  }
}
