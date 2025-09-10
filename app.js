// app.js
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  parseUnits,
  encodeAbiParameters,
  getAddress,
  http,
  toHex,
  decodeErrorResult,
  fallback,
} from "https://esm.sh/viem@2.17.3";
import { base } from "https://esm.sh/viem@2.17.3/chains";

/* ========= Addresses (Base) ========= */
const ROUTER       = getAddress("0x6fF5693b99212Da76ad316178A184AB56D299b43"); // Uniswap v4 Universal Router
const PERMIT2      = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const USDT         = getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
const THBT         = getAddress("0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F");
const POOL_MANAGER = getAddress("0x37cfc3ec1297e71499e846eb38710aa1a7aa4a00"); // ← สำคัญมาก!

/* ========= Pool params from ref tx ========= */
const FEE          = 1_000_000; // 0x0f4240
const TICK_SPACING = 0;         // ตาม tx อ้างอิง

/* ========= RPC fallback ========= */
const RPCS = [
  "https://base.publicnode.com",
  "https://1rpc.io/base",
  "https://base.blockpi.network/v1/rpc/public",
  "https://base.gateway.tenderly.co",
];

/* ========= Minimal ABIs ========= */
const ERC20_ABI = [
  { type:"function", name:"decimals",  stateMutability:"view",       inputs:[], outputs:[{type:"uint8"}] },
  { type:"function", name:"balanceOf", stateMutability:"view",       inputs:[{type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"allowance", stateMutability:"view",       inputs:[{type:"address"},{type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"approve",   stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[{type:"bool"}]   },
];
const PERMIT2_ABI = [
  { type:"function", name:"approve", stateMutability:"nonpayable",
    inputs:[
      { name:"token",    type:"address" },
      { name:"spender",  type:"address" },
      { name:"amount",   type:"uint160" },
      { name:"expiration", type:"uint48" }
    ], outputs:[] }
];
const UNIVERSAL_ROUTER_ABI = [
  { type:"function", name:"execute", stateMutability:"payable",
    inputs:[ {name:"commands",type:"bytes"}, {name:"inputs",type:"bytes[]"}, {name:"deadline",type:"uint256"} ],
    outputs:[] }
];

/* ========= Error ABIs (decode) ========= */
const UNIVERSAL_ROUTER_ERRORS_ABI = [
  { type:"error", name:"ExecutionFailed", inputs:[{name:"commandIndex", type:"uint256"}, {name:"message", type:"bytes"}] },
  { type:"error", name:"DeadlinePassed", inputs:[] },
  { type:"error", name:"InvalidCommandType", inputs:[{type:"uint256"}] },
];
const COMMON_SWAP_ERRORS_ABI = [
  { type:"error", name:"TooLittleReceived", inputs:[] },
  { type:"error", name:"TooMuchRequested",  inputs:[] },
  { type:"error", name:"InvalidTickSpacing",inputs:[] },
  { type:"error", name:"CurrencyNotSettled",inputs:[] },
  { type:"error", name:"Error",             inputs:[{type:"string"}] },
  { type:"error", name:"Panic",             inputs:[{type:"uint256"}] },
];

/* ========= UI helpers ========= */
const $ = sel => document.querySelector(sel);
const status = (msg, cls="") => { const el=$("#status"); el.className = "status " + cls; el.textContent = msg; };

/* ========= State ========= */
let pub, wallet, account, usdtDec=6, thbtDec=6;

/* ========= Bootstrap ========= */
async function boot() {
  if (!window.ethereum) { status("กรุณาติดตั้ง MetaMask ก่อนค่ะ", "err"); return; }
  pub = createPublicClient({ chain: base, transport: fallback(RPCS.map(u => http(u))) });
  wallet = createWalletClient({ chain: base, transport: custom(window.ethereum) });

  usdtDec = await pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);
  thbtDec = await pub.readContract({ address: THBT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);

  $("#connectBtn").onclick = connect;
  $("#approveBtn").onclick = approveUSDT;
  $("#swapBtn").onclick = doSwap;

  refreshBalances();
}
boot();

/* ========= Network helper ========= */
async function ensureBaseChain() {
  const idHex = await window.ethereum.request({ method: "eth_chainId" }).catch(()=>null);
  if (idHex && parseInt(idHex,16) === base.id) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  } catch (e) {
    if (e?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId:"0x2105", chainName:"Base",
          nativeCurrency:{ name:"Ether", symbol:"ETH", decimals:18 },
          rpcUrls: RPCS, blockExplorerUrls:["https://basescan.org"] }]
      });
    } else throw e;
  }
}

/* ========= Connect ========= */
async function connect() {
  await ensureBaseChain();
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = getAddress(addr);
  wallet  = createWalletClient({ chain: base, account, transport: custom(window.ethereum) });
  $("#connectBtn").textContent = account.slice(0,6) + "..." + account.slice(-4);
  status("เชื่อมต่อแล้ว");
  refreshBalances();
}

/* ========= Balances ========= */
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

/* ========= Approve (ERC20→Permit2 และ Permit2→Router) ========= */
async function approveUSDT() {
  try {
    if (!account) await connect();

    status("กำลัง Approve ขั้นที่ 1: ERC20 → Permit2 ...");
    const allowance = await pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "allowance", args:[account, PERMIT2] });
    if (allowance === 0n) {
      const tx1 = await wallet.writeContract({ account, address: USDT, abi: ERC20_ABI, functionName: "approve", args:[PERMIT2, 2n**256n - 1n] });
      $("#txLink").href = `https://basescan.org/tx/${tx1}`;
      await pub.waitForTransactionReceipt({ hash: tx1 });
    }

    status("กำลัง Approve ขั้นที่ 2: Permit2 → Universal Router ...");
    const max160 = (1n << 160n) - 1n;
    const exp48  = BigInt(Math.floor(Date.now()/1000) + 3600*24*365*3); // 3 ปี
    const tx2 = await wallet.writeContract({
      account, address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve",
      args: [USDT, ROUTER, max160, exp48]
    });
    $("#txLink").href = `https://basescan.org/tx/${tx2}`;
    await pub.waitForTransactionReceipt({ hash: tx2 });

    status("Approve สำเร็จ ✓", "ok");
  } catch(err){
    console.error(err);
    status("Approve ล้มเหลว: " + (err?.shortMessage || err.message || err), "err");
  }
}

/* ========= Helpers ========= */
// sort currencies as required by v4: currency0 < currency1
function sortCurrencies(a, b) {
  const A = BigInt(a), B = BigInt(b);
  return (A < B) ? [a, b, true] : [b, a, false]; // [currency0, currency1, aIsToken0]
}

/**
 * Encode UniversalRouter V4_SWAP inputs ตามสเปค & ตาม tx อ้างอิง:
 * actions = [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
 * params[0] = IV4Router.ExactInputSingleParams{
 *   poolKey{ currency0,currency1,fee,tickSpacing,hooks=POOL_MANAGER },
 *   zeroForOne, amountIn, amountOutMinimum, hookData=POOL_MANAGER (bytes)
 * }
 * params[1] = abi.encode(currencyIn,  amountIn)
 * params[2] = abi.encode(currencyOut, minOut)
 */
function encodeV4SwapExactInSingle({ amountIn, minOut, inputToken, outputToken }) {
  const actions = new Uint8Array([0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const actionsHex = toHex(actions);

  // จัดเรียงเป็น currency0 < currency1 ตามสเปค
  const [c0, c1, inputIsToken0] = sortCurrencies(inputToken, outputToken);
  const zeroForOne = inputIsToken0; // input == token0 ? ไป token1 : token1->token0

  // poolKey ใช้ POOL_MANAGER ในช่อง hooks (ตาม tx อ้างอิง)
  const poolKeyTuple = [c0, c1, FEE, TICK_SPACING, POOL_MANAGER];

  // hookData = POOL_MANAGER (20 bytes)
  const hookDataBytes = POOL_MANAGER; // "0x37cf..." เป็น 20 ไบต์พอดี

  // [0] SWAP_EXACT_IN_SINGLE
  const swapParams = encodeAbiParameters(
    [
      { type:"tuple", components:[
        {type:"address"},{type:"address"},{type:"uint24"},{type:"int24"},{type:"address"}
      ]},
      { type:"bool" }, { type:"uint128" }, { type:"uint128" }, { type:"bytes" }
    ],
    [ poolKeyTuple, zeroForOne, amountIn, minOut, hookDataBytes ]
  );

  // currencyIn/Out ต้องอิงทิศจริง ไม่ใช่คงที่
  const currencyIn  = zeroForOne ? c0 : c1;
  const currencyOut = zeroForOne ? c1 : c0;

  // [1] SETTLE_ALL(currencyIn, amountIn)
  const settleAll = encodeAbiParameters(
    [{type:"address"}, {type:"uint256"}],
    [ currencyIn, amountIn ]
  );

  // [2] TAKE_ALL(currencyOut, minOut)
  const takeAll = encodeAbiParameters(
    [{type:"address"}, {type:"uint256"}],
    [ currencyOut, minOut ]
  );

  return encodeAbiParameters(
    [{type:"bytes"}, {type:"bytes[]"}],
    [actionsHex, [swapParams, settleAll, takeAll]]
  );
}

/* ========= Error decode helper ========= */
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

/* ========= Swap ========= */
async function doSwap() {
  try {
    if (!account) await connect();

    const amountStr = $("#amountIn").value.trim();
    if (!amountStr || Number(amountStr) <= 0) { status("ใส่จำนวน USDT ก่อนนะคะ", "warn"); return; }

    const slippagePct = Math.max(0, Number($("#slippage").value || "1"));
    const amountIn    = parseUnits(amountStr, usdtDec);

    // ประมาณการจาก tx อ้างอิง: 1 USDT ≈ 32.352156 THBT
    const rate1e6 = 32352156n;
    const estOut  = (amountIn * rate1e6) / 10n**6n;
    const minOut  = slippagePct > 0
      ? (estOut * BigInt(Math.floor((100 - slippagePct) * 1000)) / 100000n)
      : 0n;

    $("#amountOutEst").value = formatUnits(estOut, thbtDec);

    status("กำลังจำลองธุรกรรม...");
    const deadline = BigInt(Math.floor(Date.now()/1000) + 600);
    const commands = "0x10"; // V4_SWAP
    const input0   = encodeV4SwapExactInSingle({
      amountIn, minOut,
      inputToken: USDT,
      outputToken: THBT
    });

    const sim = await pub.simulateContract({
      account,
      address: ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [commands, [input0], deadline],
      value: 0n,
      chain: base
    });

    status("กำลังส่งธุรกรรม...");
    const gasWithBuffer = sim.request.gas ? (sim.request.gas * 12n)/10n : undefined;
    const hash = await wallet.writeContract({
      ...sim.request,
      gas: gasWithBuffer
    });

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
