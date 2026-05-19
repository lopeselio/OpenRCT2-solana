// Tail-follows the NDJSON outbox file written by the C++ game.
// Never blocks: if the file doesn't exist yet we wait and retry.
// Emits OutboxEvent objects via the callback whenever new lines arrive.
//
// The byte offset is persisted to <outboxPath>.cursor so a sidecar restart
// resumes where it left off instead of replaying every historical event.
// Semantics are at-least-once: if we crash after emitting but before the
// next flush, we replay the most recent batch. Dispatch handlers must
// tolerate idempotent re-runs.

import * as fs from "fs";
import { OutboxEvent } from "./types";

export type EventCallback = (event: OutboxEvent) => void;

function loadCursor(cursorPath: string): number {
  try {
    const data = fs.readFileSync(cursorPath, "utf8");
    const parsed = JSON.parse(data);
    return typeof parsed.offset === "number" ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function saveCursor(cursorPath: string, offset: number): void {
  try {
    fs.writeFileSync(cursorPath, JSON.stringify({ offset }));
  } catch (err) {
    console.warn("[outbox] Failed to persist cursor:", err);
  }
}

export async function followOutbox(
  outboxPath: string,
  onEvent: EventCallback
): Promise<never> {
  const cursorPath = outboxPath + ".cursor";
  let offset = loadCursor(cursorPath);
  let buffer = "";

  if (offset > 0) {
    console.log(`[outbox] Resuming from byte offset ${offset} (cursor: ${cursorPath})`);
  }

  const processChunk = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as OutboxEvent;
        onEvent(event);
      } catch {
        console.warn("[outbox] Failed to parse line:", trimmed);
      }
    }
  };

  while (true) {
    while (!fs.existsSync(outboxPath)) {
      await sleep(500);
    }

    try {
      const stat = fs.statSync(outboxPath);
      const fileSize = stat.size;

      // Detect truncation/rotation — reset to 0 if the file shrank.
      if (fileSize < offset) {
        console.warn(
          `[outbox] File shrank (size=${fileSize} < cursor=${offset}) — resetting cursor`
        );
        offset = 0;
        buffer = "";
        saveCursor(cursorPath, 0);
      }

      if (fileSize > offset) {
        const fd = fs.openSync(outboxPath, "r");
        const toRead = fileSize - offset;
        const buf = Buffer.allocUnsafe(toRead);
        fs.readSync(fd, buf, 0, toRead, offset);
        fs.closeSync(fd);
        offset = fileSize;
        processChunk(buf.toString("utf8"));
        saveCursor(cursorPath, offset);
      }
    } catch (err) {
      console.error("[outbox] Read error:", err);
    }

    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
