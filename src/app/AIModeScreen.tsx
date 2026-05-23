"use client";

import { useState, useRef, useEffect } from "react";
import { ethers } from "ethers";
import { type WalletInfo } from "@/lib/wallet";
import {
  runPrivacyBuyFlow,
  runDepositOnly,
  checkPrivacyBalance,
  runRemintOnly,
  getProvider,
  getBalances,
  type FlowStep,
  type BuyFlowResult,
  type DepositOnlyResult,
} from "@/lib/signer";
import { ETHERSCAN_BASE } from "@/lib/contracts";

// ─────────────────────────────────────────────────────────────────
// LLM 配置（OpenAI 兼容接口）
// ─────────────────────────────────────────────────────────────────
const LLM_BASE_URL = "https://api.shubiaobiao.com/v1";
const LLM_API_KEY  = "sk-hide";
const LLM_MODEL    = "gpt-4o";
const DEFAULT_AMOUNT_USDC = "10";
// ─────────────────────────────────────────────────────────────────

type ActionType = "pay" | "deposit" | "balance" | "remint";

interface ParsedAction {
  type: ActionType;
  amount?: string;
  recipient?: string;
}

function parseAction(reply: string): ParsedAction | null {
  const match = reply.match(/\[ACTION:(\w+)([^\]]*)\]/);
  if (!match) return null;
  const type = match[1] as ActionType;
  const paramStr = match[2];
  const amountMatch = paramStr.match(/amount=([\d.]+)/);
  const recipientMatch = paramStr.match(/recipient=(0x[a-fA-F0-9]{40})/);
  return {
    type,
    amount: amountMatch?.[1],
    recipient: recipientMatch?.[1],
  };
}

function resolvePaymentParams(
  action: ParsedAction,
  defaultRecipient: string,
): { amount: string; recipient: string } | { error: string } {
  const amount = action.amount ?? DEFAULT_AMOUNT_USDC;
  const recipient = action.recipient ?? defaultRecipient;

  if (!/^\d+(\.\d+)?$/.test(amount) || parseFloat(amount) <= 0) {
    return { error: "无效的金额，请输入正数 USDC 数量。" };
  }
  if (!ethers.isAddress(recipient)) {
    return { error: "无效的收款地址，请提供有效的以太坊地址（0x 开头）。" };
  }
  return { amount, recipient: ethers.getAddress(recipient) };
}

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const FULL_FLOW_STEPS: FlowStep[] = [
  { id: "init",    label: "连接 Sepolia 网络",      status: "pending" },
  { id: "approve", label: "授权 USDC",              status: "pending" },
  { id: "deposit", label: "存入隐私池（存钱）",      status: "pending" },
  { id: "tree",    label: "同步 Merkle 树",          status: "pending" },
  { id: "proof",   label: "生成 ZK 证明（30-60秒）", status: "pending" },
  { id: "remint",  label: "匿名提款（取钱）",        status: "pending" },
  { id: "done",    label: "支付完成",               status: "pending" },
];

const DEPOSIT_STEPS: FlowStep[] = [
  { id: "init",    label: "连接 Sepolia 网络", status: "pending" },
  { id: "approve", label: "授权 USDC",         status: "pending" },
  { id: "deposit", label: "存入隐私池",         status: "pending" },
  { id: "done",    label: "存钱完成",           status: "pending" },
];

const REMINT_STEPS: FlowStep[] = [
  { id: "init",   label: "连接 Sepolia 网络",       status: "pending" },
  { id: "tree",   label: "同步 Merkle 树",           status: "pending" },
  { id: "proof",  label: "生成 ZK 证明（30-60秒）",  status: "pending" },
  { id: "remint", label: "向匿名地址取款",            status: "pending" },
  { id: "done",   label: "取钱支付完成",             status: "pending" },
];

type PayState = "idle" | "running";

// steps 消息嵌入对话流中，确保进度卡片固定在时间线正确位置
interface ChatMessage {
  role: "user" | "ai" | "steps";
  text: string;
  steps?: FlowStep[];
  stepError?: string | null;
}

interface Props {
  wallet: WalletInfo;
  onPayComplete: (result: BuyFlowResult) => void;
  onBack: () => void;
}

// ─── LLM API call（OpenAI 兼容）────────────────────────────────────

function buildSystemPrompt(
  usdc: string,
  address: string,
  defaultRecipient: string,
  pendingDepositAmount: string | null,
): string {
  const pendingStatus = pendingDepositAmount
    ? `✅ 有待取款的存款（${pendingDepositAmount} USDC）`
    : "❌ 无存款记录";

  return `你是 ZKBuy 的 AI 支付助理，帮助用户通过零知识证明完成隐私支付。

用户当前信息：
- 钱包地址（Account A）: ${address}
- USDC 余额: ${usdc} USDC
- 隐私池存款状态: ${pendingStatus}

默认支付设置（用户未特别指定时使用）：
- 默认金额: ${DEFAULT_AMOUNT_USDC} USDC（麦当劳巨无霸套餐）
- 默认收款地址（匿名地址 B）: ${defaultRecipient}

支持的操作（在回复**最后一行**单独输出对应标记，其余情况不要输出标记）：
1. 【全流程支付】一次性完成存钱+生成证明+取钱支付
   → [ACTION:pay] 或指定参数 [ACTION:pay amount=5 recipient=0x...]
2. 【存钱】将 USDC 存入 ZWToken 隐私池
   → [ACTION:deposit] 或 [ACTION:deposit amount=5]
3. 【查看隐私余额】查询当前隐私池中的存款状态 → [ACTION:balance]
4. 【取钱/支付】用零知识证明从隐私池向收款地址取款（需先存钱）
   → [ACTION:remint] 或 [ACTION:remint recipient=0x...]

参数说明：
- amount: 用户指定的 USDC 金额（数字，如 5 或 10.5）；未指定则用默认 ${DEFAULT_AMOUNT_USDC}
- recipient: 用户指定的收款地址（0x 开头的 42 位地址）；未指定则用默认 ${defaultRecipient}
- 取钱时金额以已存入隐私池的数额为准，仅 recipient 可覆盖

注意：取钱操作需要先执行存钱，隐私池存款状态为"无"时请先存钱。
用户未指定金额或地址时，按上述默认值执行。整个流程链上不可追踪。
请用中文回复，简洁友好。`;
}

async function callLLM(
  history: ChatMessage[],
  usdc: string,
  address: string,
  defaultRecipient: string,
  pendingDepositAmount: string | null,
): Promise<string> {
  const messages = [
    { role: "system", content: buildSystemPrompt(usdc, address, defaultRecipient, pendingDepositAmount) },
    ...history
      .filter(m => m.role !== "steps")
      .map(m => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.text,
      })),
  ];

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "（AI 无响应）";
}

// ─── Step progress card ────────────────────────────────────────────

function StepCard({ steps, error }: { steps: FlowStep[]; error: string | null | undefined }) {
  const icon = (s: FlowStep["status"]) => {
    if (s === "done") return "✅";
    if (s === "running") return "⏳";
    if (s === "error") return "❌";
    return "·";
  };
  return (
    <div className="bg-[#2c2c2c] rounded-2xl p-4 my-1 max-w-[270px]">
      <p className="text-white/40 text-xs font-medium mb-3">执行进度</p>
      <div className="space-y-2">
        {steps.map(step => (
          <div key={step.id} className="flex items-center gap-2">
            <span className={`text-xs w-5 flex-shrink-0 ${step.status === "running" ? "animate-spin inline-block" : ""}`}>
              {icon(step.status)}
            </span>
            <p className={`text-xs ${
              step.status === "done" ? "text-green-400" :
              step.status === "running" ? "text-indigo-300" :
              step.status === "error" ? "text-red-400" : "text-white/25"
            }`}>
              {step.label}
              {step.detail ? ` — ${step.detail}` : ""}
            </p>
          </div>
        ))}
      </div>
      {error && <p className="text-red-400 text-xs mt-3 break-words">{error}</p>}
    </div>
  );
}

// ─── AIModeScreen ─────────────────────────────────────────────────

export default function AIModeScreen({ wallet, onPayComplete, onBack }: Props) {
  const [usdc, setUsdc] = useState("—");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [payState, setPayState] = useState<PayState>("idle");
  const [pendingDeposit, setPendingDeposit] = useState<DepositOnlyResult | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  // 记录当前 steps 消息在 messages 数组中的位置
  const activeStepsIdxRef = useRef<number>(-1);
  const welcomeSentRef = useRef(false);

  useEffect(() => {
    getBalances(wallet.addressA, getProvider())
      .then(b => setUsdc(parseFloat(ethers.formatUnits(b.usdc, b.decimals)).toFixed(2)))
      .catch(() => setUsdc("error"));
  }, [wallet.addressA]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, aiLoading]);

  useEffect(() => {
    if (usdc === "—" || welcomeSentRef.current) return;
    welcomeSentRef.current = true;
    setMessages([{
      role: "ai",
      text:
        `你好！我是 ZKBuy AI 助理 🤖\n\n` +
        `你当前有 ${usdc} USDC 可用。\n\n` +
        `默认设置：\n` +
        `• 支付金额：${DEFAULT_AMOUNT_USDC} USDC（麦当劳巨无霸套餐）\n` +
        `• 收款地址：${shortAddress(wallet.addressB)}（匿名地址 B）\n\n` +
        `如需自定义，直接告诉我金额或收款地址即可，例如「存 5 USDC」或「向 0x1234… 取钱支付」。未指定时按默认执行。\n\n` +
        `支持以下操作：\n` +
        `• 【存钱】把 USDC 存入零知识隐私池\n` +
        `• 【查看隐私余额】查询隐私池中的余额\n` +
        `• 【取钱支付】从隐私池向收款地址取款\n` +
        `• 【全流程支付】一次性完成存钱+取钱\n\n` +
        `链上无法追踪你的钱包与支付的关联 🔐\n\n你想做什么？`,
    }]);
  }, [usdc, wallet.addressB]);

  // 在 messages 数组末尾插入一条 steps 消息，记录其索引
  function pushStepsMessage(initialSteps: FlowStep[]) {
    setMessages(prev => {
      activeStepsIdxRef.current = prev.length;
      return [...prev, { role: "steps", text: "", steps: initialSteps, stepError: null }];
    });
  }

  // 更新当前 steps 消息中某一步的状态
  function updateStepInMessage(update: Partial<FlowStep> & { id: FlowStep["id"] }) {
    const idx = activeStepsIdxRef.current;
    setMessages(prev => prev.map((msg, i) => {
      if (i !== idx || msg.role !== "steps") return msg;
      return {
        ...msg,
        steps: (msg.steps ?? []).map(s => s.id === update.id ? { ...s, ...update } : s),
      };
    }));
  }

  // 在当前 steps 消息中写入错误
  function setStepErrorInMessage(error: string) {
    const idx = activeStepsIdxRef.current;
    setMessages(prev => prev.map((msg, i) =>
      i === idx && msg.role === "steps" ? { ...msg, stepError: error } : msg
    ));
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || aiLoading || payState === "running") return;

    const updated: ChatMessage[] = [...messages, { role: "user", text: trimmed }];
    setMessages(updated);
    setInput("");
    setAiLoading(true);

    try {
      const reply = await callLLM(
        updated,
        usdc,
        wallet.addressA,
        wallet.addressB,
        pendingDeposit?.amountUSDC ?? null,
      );
      const action = parseAction(reply);
      const displayText = reply.replace(/\[ACTION:[^\]]+\]/g, "").trim();

      setMessages(prev => [...prev, { role: "ai", text: displayText }]);

      if (!action) return;

      if (action.type === "pay") {
        const resolved = resolvePaymentParams(action, wallet.addressB);
        if ("error" in resolved) {
          setMessages(prev => [...prev, { role: "ai", text: `⚠️ ${resolved.error}` }]);
          return;
        }
        await executeFullPayment(resolved.amount, resolved.recipient);
      } else if (action.type === "deposit") {
        const resolved = resolvePaymentParams(action, wallet.addressB);
        if ("error" in resolved) {
          setMessages(prev => [...prev, { role: "ai", text: `⚠️ ${resolved.error}` }]);
          return;
        }
        await executeDeposit(resolved.amount);
      } else if (action.type === "balance") {
        await executeCheckBalance();
      } else if (action.type === "remint") {
        const resolved = resolvePaymentParams(action, wallet.addressB);
        if ("error" in resolved) {
          setMessages(prev => [...prev, { role: "ai", text: `⚠️ ${resolved.error}` }]);
          return;
        }
        await executeRemint(resolved.recipient);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "ai", text: `❌ AI 连接失败：${err.message}` }]);
    } finally {
      setAiLoading(false);
    }
  }

  async function executeFullPayment(amountUSDC: string, recipient: string) {
    pushStepsMessage(FULL_FLOW_STEPS);
    setPayState("running");

    try {
      const result = await runPrivacyBuyFlow({
        keystoreJson: wallet.keystoreJson,
        prfKey: wallet.prfKey,
        addressA: wallet.addressA,
        addressB: recipient,
        amountUSDC,
        onStep: updateStepInMessage,
      });

      setPayState("idle");
      const short = (h: string) => h.slice(0, 8) + "…" + h.slice(-6);
      setMessages(prev => [...prev, {
        role: "ai",
        text:
          `✅ 支付成功！\n\n已隐私支付 ${amountUSDC} USDC。\n` +
          `• 收款地址：${shortAddress(result.accountB)}\n` +
          `• 存款 TX：${short(result.depositTxHash)}\n` +
          `• 取款 TX：${short(result.remintTxHash)}\n\n` +
          `链上分析无法将此支付追踪至你的钱包 🔐`,
      }]);
      onPayComplete(result);
    } catch (err: any) {
      const msg = err.message ?? "未知错误";
      setStepErrorInMessage(msg);
      setPayState("idle");
      setMessages(prev => [...prev, {
        role: "ai",
        text: `❌ 支付失败：${msg}\n\n请检查余额和网络后重试。`,
      }]);
    }
  }

  async function executeDeposit(amountUSDC: string) {
    pushStepsMessage(DEPOSIT_STEPS);
    setPayState("running");

    try {
      const result = await runDepositOnly({
        keystoreJson: wallet.keystoreJson,
        prfKey: wallet.prfKey,
        addressA: wallet.addressA,
        amountUSDC,
        onStep: updateStepInMessage,
      });

      setPendingDeposit(result);
      setPayState("idle");
      const short = (h: string) => h.slice(0, 8) + "…" + h.slice(-6);
      setMessages(prev => [...prev, {
        role: "ai",
        text:
          `✅ 存钱成功！\n\n已将 ${amountUSDC} USDC 存入零知识隐私池。\n` +
          `• 存款 TX：${short(result.depositTxHash)}\n\n` +
          `存款已记录在本地。随时可以发送「取钱支付」完成匿名支付 🔐`,
      }]);
      setUsdc(prev => (parseFloat(prev) - parseFloat(amountUSDC)).toFixed(2));
    } catch (err: any) {
      const msg = err.message ?? "未知错误";
      setStepErrorInMessage(msg);
      setPayState("idle");
      setMessages(prev => [...prev, {
        role: "ai",
        text: `❌ 存钱失败：${msg}\n\n请检查余额和网络后重试。`,
      }]);
    }
  }

  async function executeCheckBalance() {
    if (!pendingDeposit) {
      setMessages(prev => [...prev, {
        role: "ai",
        text: `ℹ️ 当前没有本地存款记录。\n\n请先执行【存钱】操作，将 USDC 存入隐私池后再查询余额。`,
      }]);
      return;
    }

    setMessages(prev => [...prev, { role: "ai", text: "🔍 正在查询隐私池余额..." }]);

    try {
      const result = await checkPrivacyBalance(pendingDeposit.privacyAddress);
      if (result.found) {
        const amount = parseFloat(ethers.formatUnits(result.amount, result.decimals)).toFixed(2);
        setMessages(prev => [...prev, {
          role: "ai",
          text: `✅ 隐私池余额查询结果：\n\n• 金额：${amount} USDC\n• 状态：可提取\n\n发送「取钱支付」即可完成匿名支付 🔐`,
        }]);
      } else {
        setPendingDeposit(null);
        setMessages(prev => [...prev, {
          role: "ai",
          text: `ℹ️ 隐私池中未找到你的存款记录（可能已被取出）。\n\n如需支付，请重新执行【存钱】操作。`,
        }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: "ai",
        text: `❌ 查询失败：${err.message}`,
      }]);
    }
  }

  async function executeRemint(recipient: string) {
    if (!pendingDeposit) {
      setMessages(prev => [...prev, {
        role: "ai",
        text: `⚠️ 没有找到存款记录，无法执行取钱操作。\n\n请先执行【存钱】，将 USDC 存入隐私池后再取款。`,
      }]);
      return;
    }

    pushStepsMessage(REMINT_STEPS);
    setPayState("running");

    const depositSnapshot = pendingDeposit;

    try {
      const result = await runRemintOnly({
        keystoreJson: wallet.keystoreJson,
        prfKey: wallet.prfKey,
        addressA: wallet.addressA,
        addressB: recipient,
        privacyAddress: depositSnapshot.privacyAddress,
        addr20: depositSnapshot.addr20,
        q: depositSnapshot.q,
        nullifier: depositSnapshot.nullifier,
        secret: depositSnapshot.secret,
        amount: depositSnapshot.amount,
        amountUSDC: depositSnapshot.amountUSDC,
        onStep: updateStepInMessage,
      });

      setPendingDeposit(null);
      setPayState("idle");
      const short = (h: string) => h.slice(0, 8) + "…" + h.slice(-6);
      setMessages(prev => [...prev, {
        role: "ai",
        text:
          `✅ 取钱支付成功！\n\n已从隐私池支付 ${depositSnapshot.amountUSDC} USDC。\n` +
          `• 收款地址：${shortAddress(recipient)}\n` +
          `• 取款 TX：${short(result.remintTxHash)}\n\n` +
          `链上分析无法将此支付追踪至你的钱包 🔐`,
      }]);
    } catch (err: any) {
      const msg = err.message ?? "未知错误";
      setStepErrorInMessage(msg);
      setPayState("idle");
      setMessages(prev => [...prev, {
        role: "ai",
        text: `❌ 取钱失败：${msg}\n\n请检查网络后重试。`,
      }]);
    }
  }

  const canSend = input.trim().length > 0 && !aiLoading && payState !== "running";
  const showChips = messages.length <= 1 && payState === "idle";

  const CHIPS = [
    "帮我存 10 USDC 到隐私池 💰",
    "查看我的隐私池余额 🔍",
    "从隐私池取钱支付麦当劳 🍔",
    "直接全流程支付（存+取）⚡",
  ];

  return (
    <div
      style={{ background: "#1a1a1a", fontFamily: "-apple-system,'SF Pro Display','Inter',sans-serif" }}
      className="h-screen flex flex-col max-w-sm mx-auto overflow-hidden"
    >
      {/* Header */}
      <div
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
        className="flex items-center gap-3 px-4 py-4 flex-shrink-0"
      >
        <button
          onClick={onBack}
          style={{ color: "rgba(255,255,255,0.5)", fontSize: 22, lineHeight: 1 }}
          className="hover:text-white transition-colors"
        >
          ←
        </button>
        <div className="flex-1">
          <p style={{ color: "#fff", fontWeight: 600, fontSize: 16 }}>AI 支付助理</p>
          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>ZKBuy · AI-Mode</p>
        </div>
        <div className="text-right">
          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11 }}>USDC 余额</p>
          <p style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>{usdc}</p>
        </div>
        {pendingDeposit && (
          <div
            style={{
              background: "rgba(99,102,241,0.2)",
              border: "1px solid rgba(99,102,241,0.4)",
              borderRadius: 8,
              padding: "3px 8px",
              fontSize: 11,
              color: "#a5b4fc",
              flexShrink: 0,
            }}
          >
            池中 {pendingDeposit.amountUSDC} U
          </div>
        )}
      </div>

      {/* Chat area */}
      <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-4" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div
                style={{
                  background: "#fff",
                  color: "#000",
                  borderRadius: "14px 4px 14px 14px",
                  padding: "11px 16px",
                  fontSize: 15,
                  maxWidth: 260,
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                }}
              >
                {msg.text}
              </div>
            </div>
          ) : msg.role === "steps" ? (
            <div key={i} className="flex gap-2 items-start">
              <div
                style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: "#2c2c2c",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 18, flexShrink: 0,
                }}
              >
                🤖
              </div>
              <StepCard steps={msg.steps ?? []} error={msg.stepError} />
            </div>
          ) : (
            <div key={i} className="flex gap-2 items-start">
              <div
                style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: "#2c2c2c",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 18, flexShrink: 0,
                }}
              >
                🤖
              </div>
              <div
                style={{
                  background: "#2c2c2c",
                  color: "rgba(255,255,255,0.75)",
                  borderRadius: "4px 14px 14px 14px",
                  padding: "12px 14px",
                  fontSize: 15,
                  maxWidth: 260,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {msg.text}
              </div>
            </div>
          )
        )}

        {/* AI typing indicator */}
        {aiLoading && (
          <div className="flex gap-2 items-start">
            <div
              style={{
                width: 36, height: 36, borderRadius: "50%",
                background: "#2c2c2c",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, flexShrink: 0,
              }}
            >
              🤖
            </div>
            <div
              style={{ background: "#2c2c2c", borderRadius: "4px 14px 14px 14px", padding: "14px 18px" }}
              className="flex gap-1 items-center"
            >
              {[0, 150, 300].map(delay => (
                <span
                  key={delay}
                  style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: "rgba(255,255,255,0.4)",
                    display: "inline-block",
                    animation: `bounce 1s ${delay}ms infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quick chips */}
      {showChips && (
        <div className="px-4 pb-2 flex flex-col gap-2">
          {CHIPS.map(chip => (
            <button
              key={chip}
              onClick={() => sendMessage(chip)}
              style={{
                background: "#2c2c2c",
                border: "1px solid transparent",
                borderRadius: 12,
                padding: "13px 16px",
                fontSize: 15,
                color: "rgba(255,255,255,0.6)",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.color = "#fff";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.15)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.6)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
              }}
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="px-4 pb-6 pt-3 flex-shrink-0">
        <div
          style={{ background: "#2c2c2c", borderRadius: 14, display: "flex", alignItems: "center", padding: "12px 16px", gap: 10 }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
            }}
            placeholder={payState === "running" ? "执行中，请稍候…" : "告诉 AI 你想做什么..."}
            disabled={payState === "running" || aiLoading}
            style={{
              flex: 1, background: "none", border: "none",
              color: "#fff", fontSize: 15, outline: "none",
              opacity: (payState === "running" || aiLoading) ? 0.4 : 1,
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!canSend}
            style={{
              width: 34, height: 34, borderRadius: "50%",
              background: "#fff", border: "none", cursor: canSend ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, flexShrink: 0, opacity: canSend ? 1 : 0.3,
              transition: "transform 0.15s",
            }}
            onMouseEnter={e => canSend && ((e.currentTarget as HTMLButtonElement).style.transform = "scale(0.95)")}
            onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.transform = "scale(1)")}
          >
            ↑
          </button>
        </div>
      </div>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  );
}
