"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import {
  createWalletFromSecret,
  type WalletInfo,
} from "@/lib/wallet";
import {
  runPrivacyBuyFlow,
  getProvider,
  getBalances,
  type FlowStep,
  type StepId,
} from "@/lib/signer";
import { ETHERSCAN_BASE, ADDRESSES } from "@/lib/contracts";
import AIModeScreen from "./AIModeScreen";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "setup" | "dashboard" | "flow" | "done" | "ai";

interface OrderResult {
  orderId: string;
  remintTxHash: string;
  depositTxHash: string;
  accountB: string;
  amountUsdc: string;
}

interface BalanceInfo {
  eth: string;
  usdc: string;
  decimals: number;
  loading: boolean;
}

// ─── Initial flow steps ───────────────────────────────────────────────────────

const INITIAL_STEPS: FlowStep[] = [
  { id: "init",    label: "连接 Sepolia 网络",                  status: "pending" },
  { id: "approve", label: "授权 USDC",                          status: "pending" },
  { id: "deposit", label: "存入隐私池",                          status: "pending" },
  { id: "tree",    label: "同步 Merkle 树",                     status: "pending" },
  { id: "proof",   label: "生成 ZK 证明（30-60秒）",             status: "pending" },
  { id: "remint",  label: "匿名地址取款",                        status: "pending" },
  { id: "done",    label: "支付完成",                           status: "pending" },
];

// ─── Utility ──────────────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function etherscanTx(hash: string) {
  return `${ETHERSCAN_BASE}/tx/${hash}`;
}

function etherscanAddr(addr: string) {
  return `${ETHERSCAN_BASE}/address/${addr}`;
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────

function SetupScreen({ onReady }: { onReady: (w: WalletInfo) => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!secret.trim()) { setError("请输入一个字符串"); return; }
    setLoading(true);
    try {
      const wallet = await createWalletFromSecret(secret.trim());
      onReady(wallet);
    } catch (err: any) {
      setError(err.message ?? "钱包推导失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🛒</div>
          <h1 className="text-2xl font-bold text-white">ZKBuy</h1>
          <p className="text-slate-400 text-sm mt-1">零知识证明隐私支付</p>
        </div>

        {/* Card */}
        <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 shadow-xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-300 mb-1.5">密钥短语</label>
              <input
                type="text"
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder="输入任意字符串…"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                autoComplete="off"
                autoFocus
              />
              <p className="text-slate-500 text-xs mt-1.5">
                字符串会通过 keccak256 哈希成私钥，相同的字符串始终得到相同的钱包。
              </p>
            </div>

            {error && (
              <div className="bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
            >
              {loading ? "加载钱包…" : "进入钱包"}
            </button>
          </form>
        </div>

        {/* Info */}
        <div className="mt-5 text-center text-slate-500 text-xs space-y-1">
          <p>私钥在浏览器本地推导，不存储，不上传。</p>
          <p>运行于 <span className="text-indigo-400">Sepolia 测试网</span></p>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard Screen ─────────────────────────────────────────────────────────

function DashboardScreen({
  wallet,
  onBuy,
  onAI,
  onLogout,
}: {
  wallet: WalletInfo;
  onBuy: () => void;
  onAI: () => void;
  onLogout: () => void;
}) {
  const [balance, setBalance] = useState<BalanceInfo>({ eth: "—", usdc: "—", decimals: 6, loading: true });

  useEffect(() => {
    let alive = true;
    async function fetchBalances() {
      try {
        const provider = getProvider();
        const b = await getBalances(wallet.addressA, provider);
        if (!alive) return;
        setBalance({
          eth: parseFloat(ethers.formatEther(b.eth)).toFixed(4),
          usdc: parseFloat(ethers.formatUnits(b.usdc, b.decimals)).toFixed(2),
          decimals: b.decimals,
          loading: false,
        });
      } catch {
        if (!alive) return;
        setBalance(prev => ({ ...prev, loading: false, eth: "error", usdc: "error" }));
      }
    }
    fetchBalances();
    const timer = setInterval(fetchBalances, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [wallet.addressA]);

  const usdcNum = parseFloat(balance.usdc);
  const hasEnough = !isNaN(usdcNum) && usdcNum >= 10;

  return (
    <div className="min-h-screen flex flex-col px-4 py-8 max-w-sm mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🛒</span>
          <span className="text-lg font-bold text-white">ZKBuy</span>
        </div>
        <button onClick={onLogout} className="text-slate-400 hover:text-white text-sm transition-colors">
          锁定
        </button>
      </div>

      {/* Wallet card */}
      <div className="bg-gradient-to-br from-indigo-900/60 to-slate-900 rounded-2xl p-5 border border-indigo-800/50 mb-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-sm">A</div>
          <div>
            <p className="text-xs text-slate-400">你的钱包（账户 A）</p>
            <a
              href={etherscanAddr(wallet.addressA)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-300 hover:text-indigo-200 font-mono"
            >
              {shortAddr(wallet.addressA)}
            </a>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-800/60 rounded-xl p-3">
            <p className="text-xs text-slate-400 mb-1">USDC</p>
            <p className="text-lg font-bold text-white">
              {balance.loading ? <span className="animate-pulse text-slate-500">…</span> : balance.usdc}
            </p>
          </div>
          <div className="bg-slate-800/60 rounded-xl p-3">
            <p className="text-xs text-slate-400 mb-1">Sepolia ETH</p>
            <p className="text-lg font-bold text-white">
              {balance.loading ? <span className="animate-pulse text-slate-500">…</span> : balance.eth}
            </p>
          </div>
        </div>
      </div>

      {/* Faucet hint */}
      {!balance.loading && !hasEnough && (
        <div className="bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 mb-5 text-sm">
          <p className="text-amber-300 font-medium mb-2">需要测试币？</p>
          <div className="space-y-1.5 text-amber-200/80 text-xs">
            <p>• <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="underline">faucet.circle.com</a> — 获取 10 USDC</p>
            <p>• <a href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noopener noreferrer" className="underline">Alchemy Sepolia 水龙头</a> — 获取 ETH 手续费</p>
            <p className="text-amber-400 mt-2">合约地址：<span className="font-mono">{shortAddr(ADDRESSES.USDC)}</span></p>
          </div>
        </div>
      )}

      {/* McDonald's buy button */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden mb-5">
        <div className="bg-gradient-to-r from-yellow-500 to-red-500 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🍔</span>
            <div>
              <p className="text-black font-bold text-lg">麦当劳</p>
              <p className="text-black/70 text-sm">巨无霸套餐</p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-black font-bold text-xl">$10</p>
              <p className="text-black/60 text-xs">≈ 10 USDC</p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <p className="text-slate-400 text-sm mb-4">
            使用 ZK 证明进行隐私支付。麦当劳收到来自匿名地址的 USDC — 链上无法追踪你的钱包与支付的关联。
          </p>
          <button
            onClick={onBuy}
            disabled={balance.loading || !hasEnough}
            className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-3.5 rounded-xl transition-colors text-base"
          >
            {balance.loading ? "加载中…" : !hasEnough ? "USDC 余额不足" : "隐私支付 — 10 USDC"}
          </button>
        </div>
      </div>

      {/* AI Mode button */}
      <button
        onClick={onAI}
        className="w-full flex items-center gap-3 bg-slate-900 hover:bg-slate-800 border border-indigo-800/50 hover:border-indigo-600/70 rounded-2xl px-5 py-4 mb-5 transition-all text-left"
      >
        <span className="text-2xl">🤖</span>
        <div className="flex-1">
          <p className="text-indigo-300 font-semibold text-sm">AI 模式</p>
          <p className="text-slate-500 text-xs mt-0.5">用 AI 对话完成存钱 / 取钱 / 支付</p>
        </div>
        <span className="text-slate-600 text-lg">›</span>
      </button>

      {/* Privacy address info */}
      <div className="bg-slate-900/50 rounded-xl p-4 text-xs text-slate-500 space-y-1">
        <p className="text-slate-400 font-medium">工作原理</p>
        <p>1. USDC 存入匿名 ZWToken 隐私池</p>
        <p>2. 在浏览器中生成 ZK 证明</p>
        <p>3. 支付提取到不可关联地址</p>
        <p>4. 麦当劳仅看到匿名地址</p>
      </div>
    </div>
  );
}

// ─── Flow Screen ──────────────────────────────────────────────────────────────

const STEP_ICONS: Record<StepId, string> = {
  init:    "🔗",
  approve: "✅",
  deposit: "🏦",
  tree:    "🌲",
  proof:   "🔐",
  remint:  "🎭",
  done:    "🎉",
  wait:    "⏳",
};

function FlowScreen({ steps, error, onBack }: { steps: FlowStep[]; error: string | null; onBack: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10 max-w-sm mx-auto">
      <div className="text-center mb-8">
        <div className="text-4xl mb-3">
          {error ? "❌" : steps.every(s => s.status === "done") ? "🎉" : "⚙️"}
        </div>
        <h2 className="text-xl font-bold text-white">
          {error ? "交易失败" : "处理支付中"}
        </h2>
        <p className="text-slate-400 text-sm mt-1">
          {error ? "查看下方错误" : "请勿关闭此标签页"}
        </p>
      </div>

      <div className="w-full space-y-3">
        {steps.map(step => (
          <div
            key={step.id}
            className={`rounded-xl p-4 border transition-all ${
              step.status === "done"
                ? "bg-green-900/20 border-green-700/50"
                : step.status === "running"
                ? "bg-indigo-900/30 border-indigo-500/60"
                : step.status === "error"
                ? "bg-red-900/20 border-red-700/50"
                : "bg-slate-900 border-slate-800 opacity-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="text-xl w-7 shrink-0">
                {step.status === "running"
                  ? <span className="inline-block animate-spin">⚙️</span>
                  : step.status === "done"
                  ? "✅"
                  : step.status === "error"
                  ? "❌"
                  : STEP_ICONS[step.id]}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.status === "done" ? "text-green-300" : step.status === "running" ? "text-indigo-200" : "text-slate-400"}`}>
                  {step.label}
                </p>
                {step.detail && (
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{step.detail}</p>
                )}
                {step.txHash && (
                  <a
                    href={etherscanTx(step.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-mono mt-0.5 block truncate"
                  >
                    {shortAddr(step.txHash)} ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-5 w-full space-y-3">
          <div className="bg-red-900/30 border border-red-700 rounded-xl p-4">
            <p className="text-red-400 text-sm font-medium mb-1">错误</p>
            <p className="text-red-300/80 text-xs break-words">{error}</p>
          </div>
          <button
            onClick={onBack}
            className="w-full bg-slate-800 hover:bg-slate-700 text-white font-medium py-3 rounded-xl transition-colors"
          >
            返回仪表盘
          </button>
        </div>
      )}

      {steps.some(s => s.id === "proof" && s.status === "running") && (
        <div className="mt-5 w-full bg-slate-800 rounded-xl p-4 text-sm text-slate-400 text-center">
          ZK 证明在浏览器中生成。<br />
          大约需要 30–60 秒，请耐心等待。
        </div>
      )}
    </div>
  );
}

// ─── Done Screen (McDonald's Receipt) ────────────────────────────────────────

function DoneScreen({
  order,
  wallet,
  onBack,
}: {
  order: OrderResult;
  wallet: WalletInfo;
  onBack: () => void;
}) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8 max-w-sm mx-auto">
      {/* Success banner */}
      <div className="text-center mb-6">
        <div className="text-5xl mb-3">🎉</div>
        <h2 className="text-2xl font-bold text-white">订单已下！</h2>
        <p className="text-slate-400 text-sm mt-1">隐私支付成功</p>
      </div>

      {/* Receipt card */}
      <div className="w-full bg-white text-black rounded-2xl overflow-hidden shadow-2xl mb-6">
        {/* McDonald's header */}
        <div className="bg-yellow-400 px-6 py-5 text-center">
          <div className="text-4xl mb-1">M</div>
          <p className="font-black text-2xl text-black">麦当劳</p>
          <p className="text-sm text-black/70 mt-1">Sepolia 演示店</p>
        </div>

        {/* Receipt body */}
        <div className="px-6 py-5 font-mono text-sm">
          <div className="flex justify-between mb-1">
            <span>订单 #{order.orderId}</span>
            <span>{timeStr}</span>
          </div>
          <div className="text-xs text-gray-500 mb-4">{dateStr}</div>

          <div className="border-t border-dashed border-gray-300 pt-3 mb-3">
            <div className="flex justify-between">
              <span>巨无霸套餐</span>
              <span>$10.00</span>
            </div>
            <div className="text-xs text-gray-400 ml-2">+ 薯条 + 饮料</div>
          </div>

          <div className="border-t border-dashed border-gray-300 pt-3 mb-3">
            <div className="flex justify-between font-bold">
              <span>合计</span>
              <span>$10.00 USDC</span>
            </div>
          </div>

          <div className="border-t border-dashed border-gray-300 pt-3 text-xs text-gray-500 space-y-1">
            <div className="flex justify-between">
              <span>支付方式</span>
              <span>USDC（加密货币）</span>
            </div>
            <div className="flex justify-between">
              <span>付款地址</span>
              <span className="font-mono">{shortAddr(order.accountB)}</span>
            </div>
          </div>
        </div>

        {/* Privacy note */}
        <div className="bg-gray-50 px-6 py-4 border-t border-gray-200">
          <p className="text-xs text-gray-500 text-center">
            🔐 通过 ZK 隐私协议支付。<br />
            原始钱包地址不可追踪。
          </p>
        </div>
      </div>

      {/* Privacy proof section */}
      <div className="w-full bg-slate-900 rounded-2xl border border-slate-800 p-5 mb-5 space-y-3">
        <p className="text-sm font-semibold text-slate-300">隐私验证</p>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-start gap-3">
            <span className="text-slate-400 shrink-0">你的钱包（A）</span>
            <a href={etherscanAddr(wallet.addressA)} target="_blank" rel="noopener noreferrer" className="font-mono text-indigo-400 hover:text-indigo-300 truncate">
              {shortAddr(wallet.addressA)} ↗
            </a>
          </div>
          <div className="flex justify-between items-start gap-3">
            <span className="text-slate-400 shrink-0">付款地址（B）</span>
            <a href={etherscanAddr(order.accountB)} target="_blank" rel="noopener noreferrer" className="font-mono text-green-400 hover:text-green-300 truncate">
              {shortAddr(order.accountB)} ↗
            </a>
          </div>
          <div className="border-t border-slate-800 pt-2">
            <p className="text-slate-500 mb-1">Sepolia 上的交易：</p>
            <a href={etherscanTx(order.depositTxHash)} target="_blank" rel="noopener noreferrer" className="block font-mono text-slate-400 hover:text-white truncate">
              存款：{shortAddr(order.depositTxHash)} ↗
            </a>
            <a href={etherscanTx(order.remintTxHash)} target="_blank" rel="noopener noreferrer" className="block font-mono text-slate-400 hover:text-white truncate">
              取款：{shortAddr(order.remintTxHash)} ↗
            </a>
          </div>
        </div>

        <div className="bg-green-900/20 border border-green-700/40 rounded-xl p-3 text-xs text-green-300">
          <p className="font-medium mb-1">ZK 证明保障隐私</p>
          <p className="text-green-400/70">链上分析无法关联账户 A 和账户 B。ZK 电路在不泄露秘密的情况下证明了知识。</p>
        </div>
      </div>

      {/* AI future note */}
      <div className="w-full bg-indigo-900/20 border border-indigo-800/50 rounded-xl p-4 mb-6 text-xs text-indigo-300">
        <p className="font-medium mb-1">即将推出：AI 驱动支付</p>
        <p className="text-indigo-400/70">
          很快你就可以说「隐私购买巨无霸」，AI 将自动为你执行整个流程。
        </p>
      </div>

      <button
        onClick={onBack}
        className="w-full bg-slate-800 hover:bg-slate-700 text-white font-medium py-3 rounded-xl transition-colors"
      >
        返回钱包
      </button>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function ZKBuyApp() {
  const [screen, setScreen] = useState<Screen>("setup");
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [steps, setSteps] = useState<FlowStep[]>(INITIAL_STEPS);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderResult | null>(null);

  const updateStep = useCallback((update: Partial<FlowStep> & { id: StepId }) => {
    setSteps(prev =>
      prev.map(s =>
        s.id === update.id ? { ...s, ...update } : s
      )
    );
  }, []);

  async function handleBuy() {
    if (!wallet) return;

    setSteps(INITIAL_STEPS);
    setFlowError(null);
    setScreen("flow");

    try {
      const result = await runPrivacyBuyFlow({
        keystoreJson: wallet.keystoreJson,
        prfKey: wallet.prfKey,
        addressA: wallet.addressA,
        addressB: wallet.addressB,
        amountUSDC: "10",
        onStep: updateStep,
      });

      setOrder(result);
      setScreen("done");
    } catch (err: any) {
      setFlowError(err.message ?? "Unknown error occurred");
    }
  }

  function handleLogout() {
    setWallet(null);
    setScreen("setup");
  }

  return (
    <main>
      {screen === "setup" && (
        <SetupScreen
          onReady={(w) => {
            setWallet(w);
            setScreen("dashboard");
          }}
        />
      )}
      {screen === "dashboard" && wallet && (
        <DashboardScreen
          wallet={wallet}
          onBuy={handleBuy}
          onAI={() => setScreen("ai")}
          onLogout={handleLogout}
        />
      )}
      {screen === "flow" && (
        <FlowScreen steps={steps} error={flowError} onBack={() => setScreen("dashboard")} />
      )}
      {screen === "done" && order && wallet && (
        <DoneScreen order={order} wallet={wallet} onBack={() => setScreen("dashboard")} />
      )}
      {screen === "ai" && wallet && (
        <AIModeScreen
          wallet={wallet}
          onPayComplete={result => {
            setOrder(result as OrderResult);
            setScreen("done");
          }}
          onBack={() => setScreen("dashboard")}
        />
      )}
    </main>
  );
}
