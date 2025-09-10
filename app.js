// app.js
import {
  createPublicClient, createWalletClient, custom, formatUnits, parseUnits, encodeAbiParameters,
  getAddress, http, toHex, decodeErrorResult, fallback
} from "https://esm.sh/viem@2.17.3";
import { base } from "https://esm.sh/viem@2.17.3/chains";

// ====== Addresses (Base Mainnet) ======
const ROUTER = getAddress("0x6fF5693b99212Da76ad316178A184AB56D299b43"); // Uniswap v4 Universal Router
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const USDT   = getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
const THBT   = getAddress("0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F");

// ====== RPC fallback เพื่อลด 429 ======
const RPCS = [
  "https://base.publicnode.com",
  "https://1rpc.io/base",
  "https://base.blockpi.network/v1/rpc/public",
  "https://base.gateway.tenderly.co"
];

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
// Error ABIs (เพื่อถอดข้อความ)
const UNIVERSAL_ROUTER_ERRORS_ABI = [
  { type:"error", name:"ExecutionFailed", inputs:[{name:"commandIndex", type:"uint256"}, {name:"message", type:"bytes"}] },
  { type:"error", name:"DeadlinePassed", inputs:[] },
  { type:"error", name:"InvalidCommandType", inputs:[{type:"uint256"}] },
];
const COMMON_SWAP_ERRORS_ABI = [
  { type:"error", name:"TooLittleReceived", inputs:[] },
  { type:"error", name:"TooMuchRequested", inputs:[] },
  { type:"error", name:"InvalidTickSpacing", inputs:[] },
  { type:"error", name:"CurrencyNotSettled", inputs:[] },
  { type:"error", name:"Error", inputs:[{type:"string"}] },
  { type:"error", name:"Panic", inputs:[{type:"uint256"}] },
];

// ====== Helpers ======
const $ = sel => document.querySelector(sel);
const status = (msg, cls="") => { const el=$("#status"); el.className = "status " + cls; el.textContent = msg; };

let pub, wallet, account, usdtDec=6, thbtDec=6;

// ---------- Bootstrap ----------
async function boot() {
  if (!window.ethereum) { status("กรุณาติดตั้ง MetaMask ก่อนค่ะ", "err"); return; }
  // ใช้ RPC fallback หลายตัว
  pub = createPublicClient({
    chain: base,
    transport: fallback(RPCS.map(u => http(u)))
  });
  // wallet จะผูก account ตอน connect()
  wallet = createWalletClient({ chain: base, transport: custom(window.ethereum) });

  // read decimals
  usdtDec = await pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);
  thbtDec = await pub.readContract({ address: THBT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);

  // UI events
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
          rpcUrls: RPCS, // ใช้ชุดเดียวกับด้านบน
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
  wallet = createWalletClient({ chain: base, account, transport: custom(window.ethereum) });

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

// ---------- Encoder: V4_SWAP (SWAP_EXACT_IN_SINGLE -> SETTLE_ALL -> TAKE_ALL) ----------
function encodeV4SwapExactInSingle({ amountIn, minOut, recipient, fee, tickSpacing, zeroForOne=true }) {
  const actions = new Uint8Array([0x06, 0x0c, 0x0f]);
  const actionsHex = toHex(actions);

  const swapParams = encodeAbiParameters(
    [
      { type: "tuple", components: [
        { type:"address" }, { type:"address" }, { type:"uint24" }, { type:"int24" }, { type:"address" }
      ]},
      { type: "bool" },     // zeroForOne
      { type: "uint128" },  // amountIn
      { type: "uint128" },  // amountOutMinimum
      { type: "bytes" }     // hookData
    ],
    [
      [USDT, THBT, fee, tickSpacing, "0x0000000000000000000000000000000000000000"],
      zeroForOne,
      amountIn,
      minOut,
      "0x"
    ]
  );

  const settleAll = encodeAbiParameters([{ type:"address" }, { type:"bool" }],[USDT, true]);
  const takeAll   = encodeAbiParameters([{ type:"address" }, { type:"address" }],[THBT, recipient]);

  return encodeAbiParameters([{ type:"bytes" }, { type:"bytes[]" }],[actionsHex, [swapParams, settleAll, takeAll]]);
}

// ---------- Error decode helper ----------
function decodeRouterError(err) {
  const data = err?.data || err?.cause?.data || err?.cause?.cause?.data || err?.executionError || null;
  if (!data) return null;
  try {
    const top = decodeErrorResult({ abi: UNIVERSAL_ROUTER_ERRORS_ABI, data });
    if (top?.errorName === "ExecutionFailed" && top?.args?.[1]) {
      try {
        const inner = decodeErrorResult({ abi: COMMON_SWAP_ERRORS_ABI, data: top.args[1] });
        return `Router ${top.errorName} at command #${top.args[0]} → ${inner.errorName}`;
      } catch {}
    }
    return top?.errorName || null;
  } catch {
    try {
      const g = decodeErrorResult({ abi: COMMON_SWAP_ERRORS_ABI, data });
      if (g?.errorName === "Error" && g?.args?.length) return g.args[0];
      if (g?.errorName) return g.errorName;
    } catch {}
  }
  return null;
}

// ---------- Try simulate with multiple fee/tickSpacing combos ----------
const CANDIDATE_COMBOS = [
  { fee: 3000,  tick: 60  },  // 0.3%, spacing 60 (คล้าย v3)
  { fee: 3000,  tick: 200 },  // 0.3%, spacing 200
  { fee: 10000, tick: 200 },  // 1.0%, spacing 200
  { fee: 500,   tick: 10  },  // 0.05%, spacing 10
];

async function simulateOnce({ amountIn, minOut, combo, recipient }) {
  const commands = "0x10"; // V4_SWAP
  const inputs0 = encodeV4SwapExactInSingle({
    amountIn, minOut, recipient,
    fee: combo.fee, tickSpacing: combo.tick, zeroForOne: true
  });
  return pub.simulateContract({
    account: recipient,
    address: ROUTER,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [commands, [inputs0], BigInt(Math.floor(Date.now()/1000) + 600)],
    value: 0n,
    chain: base
  });
}

// ---------- Swap ----------
async function doSwap() {
  try {
    if (!account) await connect();

    const amountStr = $("#amountIn").value.trim();
    if (!amountStr || Number(amountStr) <= 0) { status("ใส่จำนวน USDT ก่อนนะคะ", "warn"); return; }

    const slippagePct = Math.max(0, Number($("#slippage").value || "1")); // default 1%
    const amountIn = parseUnits(amountStr, usdtDec);

    // ประเมินคร่าว ๆ จาก ref-tx (ภายหลังจะต่อ quoter v4 ให้)
    const approxRateTimes1e6 = 32352156n; // 1 USDT ≈ 32.352156 THBT
    const rawEstOut = (amountIn * approxRateTimes1e6) / 10n**6n;
    const minOut = slippagePct > 0
      ? (rawEstOut * BigInt(Math.floor((100 - slippagePct) * 1000)) / 100000n)
      : 0n;

    $("#amountOutEst").value = formatUnits(rawEstOut, thbtDec);

    // --- ลอง simulate หลายคอมโบ จนกว่าจะเจออันที่ผ่าน ---
    status("กำลังจำลองธุรกรรม (ลองค่าที่เป็นไปได้ของ pool) ...");
    let sim, chosen;
    let lastErr = null;
    for (const combo of CANDIDATE_COMBOS) {
      try {
        sim = await simulateOnce({ amountIn, minOut, combo, recipient: account });
        chosen = combo;
        break;
      } catch (e) {
        lastErr = e;
        // ถ้าเจอ InvalidTickSpacing/TooLittleReceived จะวนไปลองตัวถัดไป
      }
    }
    if (!sim) {
      const decoded = decodeRouterError(lastErr);
      throw new Error(decoded ? `simulate failed: ${decoded}` : "simulate failed");
    }

    status(`กำลังส่งธุรกรรม (fee=${chosen.fee}, tick=${chosen.tick}) ...`);
    const hash = await wallet.writeContract(sim.request);

    $("#txLink").href = `https://basescan.org/tx/${hash}`;
    status("กำลังรอยืนยันบนเครือข่าย...");

    await pub.waitForTransactionReceipt({ hash });
    status("Swap สำเร็จ ✓", "ok");
    refreshBalances();
  } catch (err) {
    console.error("Swap error:", err);
    const decoded = decodeRouterError(err);
    if (decoded) status("Swap ล้มเหลว: " + decoded, "err");
    else status("Swap ล้มเหลว: " + (err?.shortMessage || err?.message || "Unknown error"), "err");
  }
}
