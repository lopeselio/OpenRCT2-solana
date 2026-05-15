// Tail-follows the NDJSON outbox file written by the C++ game.
// Never blocks: if the file doesn't exist yet we wait and retry.
// Emits OutboxEvent objects via the callback whenever new lines arrive.

import * as fs from "fs";
import * as readline from "readline";
import { OutboxEvent } from "./types";

export type EventCallback = (event: OutboxEvent) => void;

export async function followOutbox(
  outboxPath: string,
  onEvent: EventCallback
): Promise<never> {
  let offset = 0;
  let buffer = "";

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
    // Wait for file to exist
    while (!fs.existsSync(outboxPath)) {
      await sleep(500);
    }

    try {
      const stat = fs.statSync(outboxPath);
      const fileSize = stat.size;

      if (fileSize > offset) {
        const fd = fs.openSync(outboxPath, "r");
        const toRead = fileSize - offset;
        const buf = Buffer.allocUnsafe(toRead);
        fs.readSync(fd, buf, 0, toRead, offset);
        fs.closeSync(fd);
        offset = fileSize;
        processChunk(buf.toString("utf8"));
      }
    } catch (err) {
      console.error("[outbox] Read error:", err);
    }

    await sleep(50); // poll every 50ms
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
