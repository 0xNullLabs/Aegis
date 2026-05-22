"use client";
import dynamic from "next/dynamic";

// Load the full app client-side only — no SSR for wallet/WASM/crypto operations
const ZKBuyApp = dynamic(() => import("./ZKBuyApp"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="text-center">
        <div className="text-4xl mb-4 animate-pulse">🛒</div>
        <p className="text-slate-400 text-sm">Loading ZKBuy…</p>
      </div>
    </div>
  ),
});

export default function Page() {
  return <ZKBuyApp />;
}
