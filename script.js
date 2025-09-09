// ===== Addresses (Base) =====
const ADDR = {
  POOL_MANAGER: '0x498581ff718922c3f8e6a244956af099b2652b2b', // v4 PoolManager
  QUOTER_V4:    '0x0d5e0f971ed27fbff6c2837bf31316121532048d', // v4 Quoter
  UNIVERSAL:    '0x6fF5693b99212Da76ad316178A184AB56D299b43', // Universal Router
  PERMIT2:      '0x000000000022D473030F116dDEE9F6B43aC78BA3'  // Permit2
};
// Default tokens (ตามที่ต้องการ)
const TOKENS = {
  USDT: { symbol:'USDT', address:'0x2d1aDB45Bb1d7D2556c6558aDb76CFD4F9F4ed16' },
  THBT: { symbol:'THBT', address:'0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F' }
};
const DEFAULT_HOOKS = '0x0000000000000000000000000000000000000000';

// ===== ใช้ ethers UMD ผ่าน window =====
const { ethers } = window;

// ===== ESM imports สำหรับ planner/SDK =====
const { RoutePlanner, CommandType } = await import('https://esm.sh/@uniswap/universal-router-sdk@4.19.7');
const { Actions, V4Planner }       = await import('https://esm.sh/@uniswap/v4-sdk@1.3.0');

// ===== ABIs =====
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)'
];
const PERMIT2_ABI = [
  'function approve(address token,address spender,uint160 amount,uint48 expiration) external'
];
const V4_QUOTER_ABI = [
  'function quoteExactInputSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint256 exactAmount,bytes hookData) external returns (uint256 amountOut,uint256 gasEstimate)'
];
const UR_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];

// PoolManager Initialize event → ใช้ค้นหา PoolKey
const POOLMANAGER_INIT_IFACE = new ethers.utils.Interface([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)'
]);
const INIT_TOPIC = POOLMANAGER_INIT_IFACE.getEventTopic('Initialize');

// ===== Web3Modal v1 (Injected only) =====
let web3Modal, extProvider=null, provider=null, signer=null, account=null;
function initWeb3Modal(){
  const Ctor = (window.Web3Modal && window.Web3Modal.default) || window.Web3Modal;
  web3Modal = new Ctor({ cacheProvider:true, providerOptions:{}, theme:'dark' });
  if (web3Modal.cachedProvider) connect();
}
async function connect(){
  try{
    extProvider = await web3Modal.connect();                   // injected
    provider = new ethers.providers.Web3Provider(extProvider); // 'any' ไม่จำเป็น
    signer = provider.getSigner();

    const net = await provider.getNetwork();
    if (net.chainId !== 8453){
      try { await provider.send('wallet_switchEthereumChain', [{ chainId: '0x2105' }]); }
      catch {
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x2105', chainName: 'Base',
          nativeCurrency: { name:'Ether', symbol:'ETH', decimals:18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org']
        }]);
      }
    }
    account = await signer.getAddress();
    updateNetUI();
  }catch(e){ alert(e.message||e); }
}
function updateNetUI(){
  const tag = account ? `${account.slice(0,6)}…${account.slice(-4)}` : 'Not connected';
  document.getElementById('acctTag').textContent = tag;
  document.getElementById('netA').textContent = 'Base (8453)';
  document.getElementById('netB').textContent = 'Base (8453)';
}
document.getElementById('btn-connect').onclick = connect;
initWeb3Modal();

// ===== helpers =====
const nowSec = () => Math.floor(Date.now()/1000);
const byId = (id)=>document.getElementById(id);
const uiA = { in: 'tokenInA', out:'tokenOutA', amt:'amountInA', slip:'slippageA', q:'qA', pk:'pkA', dbg:'dbgA', router:'routerA' };
const uiB = { in: 'tokenInB', out:'tokenOutB', amt:'amountInB', slip:'slippageB', q:'qB', pk:'pkB', dbg:'dbgB', router:'routerB' };

function fillTokenSelects(){
  const opts = [
    {symbol:TOKENS.USDT.symbol, address:TOKENS.USDT.address},
    {symbol:TOKENS.THBT.symbol, address:TOKENS.THBT.address}
  ];
  for (const selId of [uiA.in, uiA.out, uiB.in, uiB.out]){
    const sel = byId(selId); sel.innerHTML = '';
    opts.forEach(t=>{
      const o = document.createElement('option');
      o.value = t.address; o.textContent = `${t.symbol} (${t.address.slice(0,6)}…${t.address.slice(-4)})`;
      sel.appendChild(o);
    });
  }
  byId(uiA.in).value  = TOKENS.USDT.address;
  byId(uiA.out).value = TOKENS.THBT.address;
  byId(uiB.in).value  = TOKENS.USDT.address;
  byId(uiB.out).value = TOKENS.THBT.address;
}
fillTokenSelects();

async function ensureProvider(){
  if (provider) return provider;
  // ถ้ายังไม่ connect ให้ใช้ RPC read-only สำหรับ quote/getLogs
  provider = new ethers.providers.JsonRpcProvider('https://mainnet.base.org');
  return provider;
}

// ===== discover PoolKey =====
async function discoverPoolKey(addrA, addrB){
  const p = await ensureProvider();
  const [a,b] = [addrA.toLowerCase(), addrB.toLowerCase()].sort();
  const topics = [
    INIT_TOPIC,
    null,
    ethers.utils.hexZeroPad(a, 32),
    ethers.utils.hexZeroPad(b, 32)
  ];
  let fee = 3000, tickSpacing = 60, hooks = DEFAULT_HOOKS, found=false;
  try{
    const logs = await p.getLogs({ address: ADDR.POOL_MANAGER, topics, fromBlock: 0, toBlock:'latest' });
    if (logs.length){
      const parsed = POOLMANAGER_INIT_IFACE.parseLog(logs[logs.length-1]);
      fee = Number(parsed.args.fee);
      tickSpacing = Number(parsed.args.tickSpacing);
      hooks = parsed.args.hooks;
      found = true;
    }
  }catch(e){ /* ignore */ }
  return { currency0:a, currency1:b, fee, tickSpacing, hooks, found };
}

// ===== Quote (v4) =====
async function quoteV4(tokenIn, tokenOut, amountInHuman, ui){
  const p = await ensureProvider();
  const inC  = new ethers.Contract(tokenIn,  ERC20_ABI, p);
  const outC = new ethers.Contract(tokenOut, ERC20_ABI, p);
  const [dIn, dOut, symOut] = await Promise.all([inC.decimals(), outC.decimals(), outC.symbol()]);

  const amtIn = ethers.utils.parseUnits(String(amountInHuman||'0'), dIn);
  const { currency0, currency1, fee, tickSpacing, hooks, found } = await discoverPoolKey(tokenIn, tokenOut);
  const zeroForOne = (tokenIn.toLowerCase() === currency0);

  const quoter = new ethers.Contract(ADDR.QUOTER_V4, V4_QUOTER_ABI, p);
  const hookData = hooks; // จาก tx คุณ: ส่ง address เป็น bytes

  try{
    const res = await quoter.quoteExactInputSingle({currency0, currency1, fee, tickSpacing, hooks}, zeroForOne, amtIn, hookData);
    const amountOut = res[0] || res.amountOut;
    const outStr = ethers.utils.formatUnits(amountOut, dOut);
    byId(ui.q).textContent = `${outStr} ${symOut}`;
    byId(ui.pk).textContent = `fee=${fee}, tickSpacing=${tickSpacing}, hooks=${hooks}${found?'':' (fallback)'}`;
    return { amountOut, dOut, fee, tickSpacing, hooks, zeroForOne };
  }catch(e){
    byId(ui.q).textContent = 'Quote error';
    byId(ui.dbg).textContent = (e && (e.reason||e.message)) || String(e);
    throw e;
  }
}

// ===== Approvals (ERC20->Permit2 + Permit2->Universal) =====
async function setupApprovals(tokenIn){
  if (!signer) { alert('กด Connect ก่อนนะคะ'); return; }
  const erc = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  // 1) approve token -> Permit2 (Max)
  const tx1 = await erc.approve(ADDR.PERMIT2, ethers.constants.MaxUint256);
  await tx1.wait();
  // 2) Permit2 approve -> Universal Router
  const amountUint160 = ethers.BigNumber.from(2).pow(160).sub(1);
  const expiration = nowSec() + 60*60*24*365*5; // 5 ปี
  const permit2 = new ethers.Contract(ADDR.PERMIT2, PERMIT2_ABI, signer);
  const tx2 = await permit2.approve(tokenIn, ADDR.UNIVERSAL, amountUint160, expiration);
  await tx2.wait();
  return true;
}

// ===== Swap (UR • V4 Planner → RoutePlanner → execute) =====
async function swapV4(tokenIn, tokenOut, amountInHuman, slippagePct, ui){
  if (!signer){ alert('กด Connect ก่อนค่ะ'); return; }

  const p = await ensureProvider();
  const inC  = new ethers.Contract(tokenIn,  ERC20_ABI, p);
  const outC = new ethers.Contract(tokenOut, ERC20_ABI, p);
  const [dIn, dOut] = await Promise.all([inC.decimals(), outC.decimals()]);
  const amtIn = ethers.utils.parseUnits(String(amountInHuman||'0'), dIn);

  // PoolKey
  const { currency0, currency1, fee, tickSpacing, hooks } = await discoverPoolKey(tokenIn, tokenOut);
  const zeroForOne = (tokenIn.toLowerCase() === currency0);

  // Planner
  const v4Planner = new V4Planner();
  v4Planner.addAction(Actions.V4_SWAP_EXACT_IN_SINGLE, [
    { currency0, currency1, fee, tickSpacing, hooks },
    zeroForOne,
    amtIn.toString(),
    hooks // hookData
  ]);
  v4Planner.addSettle(tokenIn, true); // payer user
  v4Planner.addTake(tokenOut, (await signer.getAddress()));

  const actionsBytes = v4Planner.finalize();
  const routePlanner = new RoutePlanner();
  routePlanner.addCommand(CommandType.V4_SWAP, [actionsBytes]);

  const { commands, inputs } = routePlanner.toHex();

  // minOut จาก quote
  const { amountOut } = await quoteV4(tokenIn, tokenOut, amountInHuman, ui);
  const slipBps = Math.floor((Number(slippagePct||0.5)) * 100); // 0.5% -> 50
  const minOut = amountOut.mul(10000 - slipBps).div(10000);

  byId(ui.dbg).textContent = `commands=${commands} inputs[0]=${inputs[0].slice(0,80)}… minOut=${ethers.utils.formatUnits(minOut, dOut)}`;

  const ur = new ethers.Contract(ADDR.UNIVERSAL, UR_ABI, signer);
  const tx = await ur.execute(commands, inputs, nowSec()+60*15, { value: 0 });
  byId(ui.q).innerHTML = `Tx: <a target="_blank" href="https://basescan.org/tx/${tx.hash}">${tx.hash}</a>`;
  const rc = await tx.wait();
  byId(ui.q).innerHTML = `✅ Success: <a target="_blank" href="https://basescan.org/tx/${rc.transactionHash}">${rc.transactionHash}</a>`;
}

// ===== Wire UI =====
function bindBox(prefix){
  const ui = prefix==='A'
    ? { in: 'tokenInA', out:'tokenOutA', amt:'amountInA', slip:'slippageA', q:'qA', pk:'pkA', dbg:'dbgA' }
    : { in: 'tokenInB', out:'tokenOutB', amt:'amountInB', slip:'slippageB', q:'qB', pk:'pkB', dbg:'dbgB' };

  document.getElementById(`quote${prefix}`).onclick = async ()=>{
    try{ await quoteV4(byId(ui.in).value, byId(ui.out).value, byId(ui.amt).value, ui); }catch{}
  };
  document.getElementById(`approve${prefix}`).onclick = async ()=>{
    try{ await setupApprovals(byId(ui.in).value); byId(ui.dbg).textContent = 'Approvals complete'; }
    catch(e){ byId(ui.dbg).textContent = (e && (e.reason||e.message)) || String(e); }
  };
  document.getElementById(`swap${prefix}`).onclick = async ()=>{
    try{ await swapV4(byId(ui.in).value, byId(ui.out).value, byId(ui.amt).value, byId(ui.slip).value, ui); }
    catch(e){ byId(ui.dbg).textContent = (e && (e.reason||e.message)) || String(e); }
  };
}
bindBox('A'); bindBox('B');
