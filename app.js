// app.js
import {
  createPublicClient, createWalletClient, custom, formatUnits, parseUnits, encodeAbiParameters,
  getAddress, http, toHex
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
const TICK_SPACING = 0;     // ถ้าสวอปไม่ผ่าน ลองเปลี่ยนเป็น 200

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
  // หมายเหตุ: wallet จะผูก account จริง ๆ ตอน connect()
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

// ---------- Network helper ----------
async function ensureBaseChain() {
  const chainIdHex = await window.ethereum.request({ method: "eth_chainId" }).catch(()=>null);
  const isOnBase = chainIdHex && parseInt(chainIdHex, 16) === base.id;
  if (isOnBase) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }], // 8453
    });
  } catch (e) {
    // ถ้าไม่มี chain ให้ add ก่อน
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
    } else {
      throw e;
    }
  }
}

// ---------- Connect ----------
async function connect() {
  await ensureBaseChain();
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = getAddress(addr);

  // ✅ ผูก account ให้ walletClient (แก้ error: Could not find an Account...)
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
      account, // ✅ สำคัญ
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

// ---------- Build V4_SWAP input (actions & params) ----------
/**
 * เราเข้ารหัส actions ตาม Uniswap v4 Periphery "Actions" constants:
 *  - 0x06 SWAP_EXACT_IN_SINGLE
 *  - 0x0c SETTLE_ALL
 *  - 0x0f TAKE_ALL
 * รูปแบบ params ใช้ struct แบบเดียวกับที่ Universal Router คาดหวัง
 */
function encodeV4SwapExactInSingle({ amountIn, minOut, recipient }) {
  // 1) actions: bytes = [0x06, 0x0c, 0x0f]
  const actions = new Uint8Array([0x06, 0x0c, 0x0f]);
  const actionsHex = toHex(actions);

  // 2) params: bytes[] (3 ชิ้น) — ตามลำดับของ actions
  //    2.1) SWAP_EXACT_IN_SINGLE params
  //
  // struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
  // struct ExactInputSingleParams { PoolKey key; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData; }
  //
  // หมายเหตุ: USDT→THBT คาด order เป็น (USDT, THBT) และ zeroForOne = true
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
      true,
      amountIn,
      minOut,
      "0x"
    ]
  );

  //    2.2) SETTLE_ALL params -> (address currency, bool payerIsUser)
  const settleAll = encodeAbiParameters(
    [{ type: "address" }, { type: "bool" }],
    [USDT, true]
  );

  //    2.3) TAKE_ALL params -> (address currency, address recipient)
  const takeAll = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
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

// ---------- Swap (simulate first, then send) ----------
async function doSwap() {
  try {
    if (!account) await connect();

    const amountStr = $("#amountIn").value.trim();
    if (!amountStr || Number(amountStr) <= 0) { status("ใส่จำนวน USDT ก่อนนะคะ", "warn"); return; }
    // ตั้งค่าเริ่มต้น slippage = 1% ถ้าไม่ได้กรอก
    const slippagePct = Math.max(0, Number($("#slippage").value || "1"));
    const amountIn = parseUnits(amountStr, usdtDec);

    // ประเมิน minOut แบบคร่าว ๆ จากเรต ref-tx (แนะนำต่อ quoter v4 ภายหลัง)
    const approxRateTimes1e6 = 32352156n; // 1 USDT → ~32.352156 THBT
    const rawEstOut = (amountIn * approxRateTimes1e6) / 10n**6n;
    const minOut = slippagePct > 0
      ? (rawEstOut * BigInt(Math.floor((100 - slippagePct) * 1000)) / 100000n)
      : 0n;

    $("#amountOutEst").value = formatUnits(rawEstOut, thbtDec);

    status("กำลังจำลองธุรกรรม (simulate) ...");
    const deadline = BigInt(Math.floor(Date.now()/1000) + 60 * 10); // 10 นาที

    // commands: 0x10 (V4_SWAP)
    const commands = "0x10";
    const inputs0 = encodeV4SwapExactInSingle({
      amountIn, minOut, recipient: account
    });

    // ✅ จำลองก่อน เพื่อให้ได้ gas/params ที่แม่น → MM จะไม่เตือน Inaccurate fee
    const sim = await wallet.simulateContract({
      account,
      address: ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [commands, [inputs0], deadline],
      value: 0n,
      chain: base
    });

    status("กำลังส่งธุรกรรม Swap...");
    const hash = await wallet.writeContract(sim.request); // ส่งด้วย request จาก simulation

    $("#txLink").href = `https://basescan.org/tx/${hash}`;
    status("กำลังรอยืนยันบนเครือข่าย...");

    await pub.waitForTransactionReceipt({ hash });
    status("Swap สำเร็จ ✓", "ok");
    refreshBalances();
  } catch(err){
    console.error(err);
    // ถ้ายังเตือน likely-to-fail ลองเพิ่ม slippage เป็น 2% หรือเปลี่ยน TICK_SPACING = 200
    status("Swap ล้มเหลว: " + (err?.shortMessage || err.message || err), "err");
  }
}
