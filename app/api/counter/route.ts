import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "counter.json");

function read(): number {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

function write(count: number) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ count }), "utf-8");
}

export async function GET() {
  return NextResponse.json({ count: read() });
}

export async function POST() {
  const next = read() + 1;
  write(next);
  return NextResponse.json({ count: next });
}
