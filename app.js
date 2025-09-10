// app.js
import {
  createPublicClient, createWalletClient, custom, formatUnits, parseUnits, encodeAbiParameters,
  getAddress, http, decodeFunctionData, keccak256, toHex
} from "https://esm.sh/viem@2.17.3";
import { base } from "https://esm.sh/viem@2.17.3/chains";

// ====== Constants (Base Mainnet) ======
const ROUTER = getAddress("0x6fF5693b99212Da76ad316178A184AB56D299b43"); // Universal Router (v4) on Base
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"); // Permit2 (chain-agnostic)
const USDT   = getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
const THBT   = getAddress("0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F");

// จาก reference tx เห็นว่าใช้ PoolManager เดียวนี้ (ปรากฏอยู่ใน calldata)
const POOL_MANAGER = getAddress("0x37cfc3ec1297e71499e846eb38710aa1a7aa4a00");

// ค่าพารามิเตอร์ pool key ที่ใช้ใน reference tx (ดูจาก calldata: 0x0f4240)
const FEE = 1_000_000;      // uint24 (v4 ใช้หน่วย 1e-6)
const TICK_SPACING = 0;     // ในคู่ไม่มี hook พิเศษ ใช้ 0 (=อิงค่า default ใน pool); ถ้าสวอปไม่ผ่านให้ลอง 200

// Minimal ABIs we need
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

// Helpers
const $ = sel => document.querySelector(sel);
const status = (msg, cls="") => { const el=$("#status"); el.className = "status " + cls; el.textContent = msg; };

let pub, wallet, account, usdtDec=6, thbtDec=6;

// ---------- Bootstrap ----------
async function boot() {
  if (!window.ethereum) {
    status("กรุณาติดตั้ง MetaMask ก่อนค่ะ", "err"); return;
  }
  pub = createPublicClient({ chain: base, transport: http() });
  wallet = createWalletClient({ chain: base, transport: custom(window.ethereum) });

  // read decimals once
  usdtDec = await pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);
  thbtDec = await pub.readContract({ address: THBT, abi: ERC20_ABI, functionName: "decimals" }).catch(()=>6);

  // UI events
  $("#connectBtn").onclick = connect;
  $("#approveBtn").onclick = approveUSDT;
  $("#swapBtn").onclick = doSwap;

  refreshBalances(); // best-effort without account
}
boot();

// ---------- Connect ----------
async function connect() {
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = getAddress(addr);
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
  } catch(e){ /* ignore */ }
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
      address: USDT, abi: ERC20_ABI, functionName: "approve", args:[PERMIT2, 2n**256n - 1n]
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

// ---------- Build V4_SWAP input (actions & params) ----------
/**
 * เราเข้ารหัส actions ตาม Uniswap v4 Periphery "Actions" constants:
 *  - 0x06 SWAP_EXACT_IN_SINGLE
 *  - 0x0c SETTLE_ALL
 *  - 0x0f TAKE_ALL
 * รูปแบบ params ใช้ struct แบบเดียวกับที่ Universal Router คาดหวัง
 * อ้างอิง: Uniswap Universal Router v2 + v4 docs (V4_SWAP) และหน้า Actions
 */
function encodeV4SwapExactInSingle({ amountIn, minOut, recipient }) {
  // 1) actions: bytes = [0x06, 0x0c, 0x0f]
  const actions = new Uint8Array([0x06, 0x0c, 0x0f]);
  const actionsHex = toHex(actions);

  // 2) params: bytes[] (3 ชิ้น) — ตามลำดับของ actions
  //    2.1) SWAP_EXACT_IN_SINGLE params
  //
  // struct PoolKey {
  //   address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks;
  // }
  //
  // struct ExactInputSingleParams {
  //   PoolKey key; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData;
  // }
  //
  // หมายเหตุ: สำหรับคู่ USDT→THBT เราจะคาดว่า order เป็น (USDT, THBT) และ zeroForOne = true
  // หากสวอป revert ให้ลองสลับ zeroForOne หรือ tickSpacing = 200
  const poolKey = encodeAbiParameters(
    [
      { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }
    ],
    [USDT, THBT, FEE, TICK_SPACING, "0x0000000000000000000000000000000000000000"]
  );

  const swapParams = encodeAbiParameters(
    [
      // PoolKey (as bytes) is re-encoded as tuple to align with router expectation:
      { type: "tuple", components: [
        { type:"address" }, { type:"address" }, { type:"uint24" }, { type:"int24" }, { type:"address" }
      ]},
      { type: "bool" },     // zeroForOne
      { type: "uint128" },  // amountIn
      { type: "uint128" },  // amountOutMinimum
      { type: "bytes" }     // hookData
    ],
    [
      [USDT, THBT, FEE, TICK_SPACING, "0x0000000000000000000000000000000000000000"],
      true,
      amountIn,
      minOut,
      "0x"
    ]
  );

  //    2.2) SETTLE_ALL params -> (address currency, bool payerIsUser, uint128 amount?) – ใช้เวอร์ชันที่ notional=amountIn
  // เรียก settleAll(USDT) เพื่อเคลียร์ IOU ขาเข้าให้ Router ไปดึงจาก user ผ่าน Permit2
  const settleAll = encodeAbiParameters(
    [
      { type: "address" }, // currency (USDT)
      { type: "bool" }     // payerIsUser
    ],
    [USDT, true]
  );

  //    2.3) TAKE_ALL params -> (address currency, address recipient)
  // เอา THBT ทั้งหมดที่ Router ถือส่งให้ผู้ใช้
  const takeAll = encodeAbiParameters(
    [
      { type: "address" }, // currency (THBT)
      { type: "address" }  // recipient
    ],
    [THBT, recipient]
  );

  const params = [swapParams, settleAll, takeAll];

  // Universal Router expects input: (bytes actions, bytes[] params)
  const input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actionsHex, params]
  );

  return input;
}

// ---------- Swap ----------
async function doSwap() {
  try {
    if (!account) await connect();

    const amountStr = $("#amountIn").value.trim();
    if (!amountStr || Number(amountStr) <= 0) { status("ใส่จำนวน USDT ก่อนนะคะ", "warn"); return; }
    const slippagePct = Math.max(0, Number($("#slippage").value || "0"));
    const amountIn = parseUnits(amountStr, usdtDec);

    // สำหรับ MVP: ตั้ง minOut = 0 (ปลอดภัยน้อยกว่า แต่ติดน้อยสุด); ถ้ากังวล slippage ให้ใช้ minOut = amountIn * priceEst * (1 - slippage)
    // คุณสามารถเอา “สัดส่วน” จาก ref-tx 1 USDT ≈ 32.3521 THBT มาคูณคร่าวๆ
    // (บน UI จะโชว์ “Estimate on swap” เฉยๆ แต่ตัวเลขที่บังคับใช้คือ minOut)
    const approxRateTimes1e6 = 32352156n; // อิง ref tx 1 USDT → ~32.352156 THBT
    const rawEstOut = (amountIn * approxRateTimes1e6) / 10n**6n;
    const minOut = slippagePct > 0
      ? (rawEstOut * BigInt(Math.floor((100 - slippagePct) * 1000)) / 100000n) // (100 - s)% ด้วย 1e3 precision
      : 0n;

    $("#amountOutEst").value = formatUnits(rawEstOut, thbtDec);

    status("กำลังส่งธุรกรรม Swap...");
    const deadline = BigInt(Math.floor(Date.now()/1000) + 60 * 10); // 10 นาที

    // commands: 0x10 (V4_SWAP)
    const commands = "0x10";
    const inputs0 = encodeV4SwapExactInSingle({
      amountIn, minOut, recipient: account
    });

    const hash = await wallet.writeContract({
      address: ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [commands, [inputs0], deadline],
      // payables: none (เราใช้ USDT -> THBT)
    });

    $("#txLink").href = `https://basescan.org/tx/${hash}`;
    status("กำลังรอยืนยันบนเครือข่าย...");

    const rc = await pub.waitForTransactionReceipt({ hash });
    status("Swap สำเร็จ ✓", "ok");
    refreshBalances();
  } catch(err){
    console.error(err);
    // hint กรณี “decode signature 0x486aa307” หรือ invalid params → ลองแก้ tickSpacing = 200 และ/หรือสลับ zeroForOne
    status("Swap ล้มเหลว: " + (err?.shortMessage || err.message || err), "err");
  }
}
