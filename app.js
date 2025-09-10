// app.js
import {
  createPublicClient, createWalletClient, custom, formatUnits, parseUnits, encodeAbiParameters,
  getAddress, http, toHex, decodeErrorResult
} from "https://esm.sh/viem@2.17.3";
import { base } from "https://esm.sh/viem@2.17.3/chains";

// ====== Constants (Base Mainnet) ======
const ROUTER = getAddress("0x6fF5693b99212Da76ad316178A184AB56D299b43"); // Universal Router (v4) on Base
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"); // Permit2
const USDT   = getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
const THBT   = getAddress("0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F");

// (optional) not used directly
const POOL_MANAGER = getAddress("0x37cfc3ec1297e71499e846eb38710aa1a7aa4a00");

// Pool params (ถ้าสวอปไม่ผ่าน ลองเปลี่ยน TICK_SPACING = 200)
const FEE = 1_000_000;
const TICK_SPACING = 0;

// ====== Minimal ABIs ======
const ERC20_ABI = [
  { type:"function", name:"decimals", stateMutability:"view", inputs:[], outputs:[{type:"uint8"}]},
  { type:"function", name:"balanceOf", stateMutability:"view", inputs:[{type:"address"}], outputs:[{type:"uint256"}]},
  { type:"function", name:"allowance", stateMutability:"view", inputs:[{type:"address"},{type:"address"}], outputs:[{type:"uint256"}]},
  { type:"function", name:"approve",  stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[{type:"bool"}] },
];

const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  }
];

// ✅ เสริม ABI ของ error ที่เจอบ่อย เพื่อถอดรหัสข้อความให้เข้าใจง่าย
const UNIVERSAL_ROUTER_ERRORS_ABI = [
  { type:"error", name:"ExecutionFailed", inputs:[{name:"commandIndex", type:"uint256"}, {name:"message", type:"bytes"}] },
  { type:"error", name:"DeadlinePassed", inputs:[] },
  { type:"error", name:"InvalidCommandType", inputs:[{type:"uint256"}] },
];

const COMMON_SWAP_ERRORS_ABI = [
  { type:"error", name:"TooLittleReceived", inputs:[] },
  { type:"error", name:"TooMuchRequested", inputs:[] },       // บาง impl ใช้ชื่อคล้ายกัน
  { type:"error", name:"InvalidTickSpacing", inputs:[] },
  { type:"error", name:"CurrencyNotSettled", inputs:[] },
  { type:"error", name:"Panic", inputs:[{type:"uint256"}] },  // มาตรฐาน Solidity
  { type:"error", name:"Error", inputs:[{type:"string"}] },   // revert("reason")
];

// ====== Helpers ======
const $ = sel => document.querySelector(sel);
const status = (msg, cls="") => { const el=$("#status"); el.className = "status " + cls; el.textContent = msg; };

let pub, wallet, account, usdtDec=6, thbtDec=6;

// ---------- Bootstrap ----------
async function boot() {
  if (!window.ethereum) { status("กรุณาติดตั้ง MetaMask ก่อนค่ะ", "err"); return; }
  pub = createPublicClient({ chain: base, transport: http() });
  wallet = createWalletClient({ chain: base, transport: custom(window.ethereum) }); // account จะถูกผูกตอน connect()

  usdtDec = await pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);
  thbtDec = await pub.readContract({ address: THBT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);

  $("#connectBtn").onclick = connect;
  $("#approveBtn").onclick = approveUSDT;
  $("#swapBtn").onclick = doSwap;

  refreshBalances();
}
boot();

// ---------- Network helper ----------
async function ensureBaseChain() {
  const chainIdHex = await window.ethereum.request({ method: "eth_chainId" }).catch(()=>null);
  const isOnBase = chainIdHex && parseInt(chainIdHex, 16) === base.id;
  if (isOnBase) return;

  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  } catch (e) {
    if (e?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x2105",
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.base.org"],
          blockExplorerUrls: ["https://basescan.org"]
        }]
      });
    } else { throw e; }
  }
}

// ---------- Connect ----------
async function connect() {
  await ensureBaseChain();
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = getAddress(addr);
  wallet = createWalletClient({ chain: base, account, transport: custom(window.ethereum) }); // ✅ ผูก account

  $("#connectBtn").textContent = account.slice(0,6) + "..." + account.slice(-4);
  status("เชื่อมต่อแล้ว");
  refreshBalances();
}

// ---------- Balances ----------
async function refreshBalances() {
  try {
    if (!pub) return;
    const user = account ?? "0x0000000000000000000000000000000000000000";
    const [ub, tb] = await Promise.all([
      pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args:[user]}).catch(()=>0n),
      pub.readContract({ address: THBT, abi: ERC20_ABI, functionName: "balanceOf", args:[user]}).catch(()=>0n),
    ]);
    $("#usdtBal").textContent = "Balance: " + formatUnits(ub, usdtDec);
    $("#thbtBal").textContent = "Balance: " + formatUnits(tb, thbtDec);
  } catch {}
}

// ---------- Approve USDT via Permit2 ----------
async function approveUSDT() {
  try {
    if (!account) await connect();
    status("ส่งคำสั่ง Approve USDT → Permit2 ...");
    const allowance = await pub.readContract({
      address: USDT, abi: ERC20_ABI, functionName: "allowance", args:[account, PERMIT2]
    });
    if (allowance > 0n) { status("USDT ถูก Approve ให้ Permit2 แล้ว ✓", "ok"); return; }

    const hash = await wallet.writeContract({
      account,
      address: USDT,
      abi: ERC20_ABI,
      functionName: "approve",
      args:[PERMIT2, 2n**256n - 1n]
    });
    $("#txLink").href = `https://basescan.org/tx/${hash}`;
    status("กำลังรอ Confirm บนเครือข่าย...");
    await pub.waitForTransactionReceipt({ hash });
    status("Approve สำเร็จ ✓", "ok");
  } catch(err){
    console.error(err);
    status("Approve ล้มเหลว: " + (err?.shortMessage || err.message || err), "err");
  }
}

// ---------- Build V4_SWAP input ----------
function encodeV4SwapExactInSingle({ amountIn, minOut, recipient }) {
  const actions = new Uint8Array([0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const actionsHex = toHex(actions);

  const swapParams = encodeAbiParameters(
    [
      { type: "tuple", components: [
        { type:"address" }, { type:"address" }, { type:"uint24" }, { type:"int24" }, { type:"address" }
      ]},
      { type: "bool" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "bytes" }
    ],
    [
      [USDT, THBT, FEE, TICK_SPACING, "0x0000000000000000000000000000000000000000"],
      true,               // zeroForOne: USDT -> THBT
      amountIn,
      minOut,
      "0x"
    ]
  );

  const settleAll = encodeAbiParameters([{ type:"address" }, { type:"bool" }],[USDT, true]);
  const takeAll   = encodeAbiParameters([{ type:"address" }, { type:"address" }],[THBT, recipient]);

  return encodeAbiParameters(
    [{ type:"bytes" }, { type:"bytes[]" }],
    [actionsHex, [swapParams, settleAll, takeAll]]
  );
}

// ---------- Error decoding helper ----------
function decodeRouterError(err) {
  // ดึง data จากหลายชั้นของ error object
  const data = err?.data || err?.cause?.data || err?.cause?.cause?.data || err?.executionError || null;
  if (!data) return null;

  // 1) ลองถอดด้วย error ของ Universal Router ก่อน
  try {
    const top = decodeErrorResult({ abi: UNIVERSAL_ROUTER_ERRORS_ABI, data });
    // ถ้าเป็น ExecutionFailed ลองถอดซ้อนด้วย common swap errors
    if (top?.errorName === "ExecutionFailed" && top?.args?.[1]) {
      try {
        const inner = decodeErrorResult({ abi: COMMON_SWAP_ERRORS_ABI, data: top.args[1] });
        return `Router ${top.errorName} at command #${top.args[0]} → ${inner.errorName}`;
      } catch {
        // บางเคสเป็น revert("string")
        try {
          const inner = decodeErrorResult({ abi: COMMON_SWAP_ERRORS_ABI, data: top.args[1] });
          return `Router ${top.errorName} at command #${top.args[0]} (inner)`;
        } catch { /* ignore */ }
      }
    }
    return `${top.errorName}`;
  } catch {
    // 2) ไม่ใช่ error ของ UR → ลองถอดแบบ generic (Error(string)/Panic)
    try {
      const g = decodeErrorResult({ abi: COMMON_SWAP_ERRORS_ABI, data });
      if (g?.errorName === "Error" && g?.args?.length) return g.args[0];
      if (g?.errorName) return g.errorName;
    } catch { /* ignore */ }
  }
  return null;
}

// ---------- Swap (simulate on publicClient, then send) ----------
async function doSwap() {
  try {
    if (!account) await connect();

    const amountStr = $("#amountIn").value.trim();
    if (!amountStr || Number(amountStr) <= 0) { status("ใส่จำนวน USDT ก่อนนะคะ", "warn"); return; }

    const slippagePct = Math.max(0, Number($("#slippage").value || "1")); // default 1%
    const amountIn = parseUnits(amountStr, usdtDec);

    // ประเมิน minOut จากเรต ref-tx (ต่อ quoter v4 ภายหลังได้)
    const approxRateTimes1e6 = 32352156n; // 1 USDT ≈ 32.352156 THBT
    const rawEstOut = (amountIn * approxRateTimes1e6) / 10n**6n;
    const minOut = slippagePct > 0
      ? (rawEstOut * BigInt(Math.floor((100 - slippagePct) * 1000)) / 100000n)
      : 0n;

    $("#amountOutEst").value = formatUnits(rawEstOut, thbtDec);
    status("กำลังจำลองธุรกรรม (simulate) ...");

    const deadline = BigInt(Math.floor(Date.now()/1000) + 60 * 10); // 10 นาที
    const commands = "0x10"; // V4_SWAP
    const inputs0 = encodeV4SwapExactInSingle({ amountIn, minOut, recipient: account });

    // จำลองด้วย public client
    const sim = await pub.simulateContract({
      account,
      address: ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [commands, [inputs0], deadline],
      value: 0n,
      chain: base
    });

    status("กำลังส่งธุรกรรม Swap...");
    const hash = await wallet.writeContract(sim.request);

    $("#txLink").href = `https://basescan.org/tx/${hash}`;
    status("กำลังรอยืนยันบนเครือข่าย...");

    await pub.waitForTransactionReceipt({ hash });
    status("Swap สำเร็จ ✓", "ok");
    refreshBalances();
  } catch (err) {
    console.error("Swap error:", err);
    const decoded = decodeRouterError(err);
    if (decoded) {
      status("Swap ล้มเหลว: " + decoded + " (ดู Console เพิ่มเติม)", "err");
    } else {
      status("Swap ล้มเหลว: " + (err?.shortMessage || err?.message || "Unknown error"), "err");
    }
  }
}
