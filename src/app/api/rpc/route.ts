import { NextRequest, NextResponse } from "next/server";

const UPSTREAM_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://rpc.sepolia.org",
];

export async function POST(req: NextRequest) {
  const body = await req.text();

  for (const rpc of UPSTREAM_RPCS) {
    try {
      const upstream = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!upstream.ok) continue;
      const data = await upstream.text();
      return new NextResponse(data, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32603, message: "All RPC endpoints unreachable" }, id: null },
    { status: 502 }
  );
}
