// PadThai Swap • Base (Router direct) — vanilla JS + Web3Modal v1 + ethers v5
// FIX: use callStatic for QuoterV2 to avoid "requires a signer" on quote

const $ = (id)=>document.getElementById(id);
const log = (m)=>{ const a=$("logs"); a.textContent+=`${new Date().toLocaleTimeString()}  ${m}\n`; a.scrollTop=a.scrollHeight; };

// ----- Web3Modal bootstrap (UMD) -----
let web3Modal, extProvider=null, provider=null, signer=null;

function initModal(){
  const Web3ModalCtor = (window.Web3Modal && window.Web3Modal.default) || window.Web3Modal;
  const WCProviderCtor = (window.WalletConnectProvider && window.WalletConnectProvider.default) || window.WalletConnectProvider;

  if(!Web3ModalCtor) log("❌ Web3Modal not loaded");
  if(!WCProviderCtor) log("❌ WalletConnectProvider not loaded");
  if(!window.ethers) log("❌ ethers not loaded");

  web3Modal = new Web3ModalCtor({
    cacheProvider:true,
    providerOptions:{
      walletconnect:{ package:WCProviderCtor, options:{ rpc:{ 8453:"https://mainnet.base.org" } } }
    },
    theme:"light"
  });

  if(web3Modal.cachedProvider) connect();
}

async function connect(){
  try{
    extProvider = await web3Modal.connect();
    provider = new ethers.providers.Web3Provider(extProvider);
    signer = provider.getSigner();

    const net = await provider.getNetwork();
    $("netLabel").textContent = `${net.name} (chainId ${net.chainId})`;
    log(`Connected ${await signer.getAddress()}`);
  }catch(e){ log(`Connect error: ${e.message||e}`); alert(e.message||e); }
}

async function disconnect(){
  try{
    if(web3Modal) await web3Modal.clearCachedProvider();
    if(extProvider && extProvider.disconnect) await extProvider.disconnect();
  }catch{} finally{
    extProvider=null; provider=null; signer=null;
    $("netLabel").textContent="Not connected";
    log("Disconnected");
  }
}

// ----- ABIs -----
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)"
];

// Router entrypoints we’ll try
const SWAP_ABI = [
  // v3-style
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  // fallback (path-encoded)
  "function exactInput(bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) payable returns (uint256)"
];

// Quoter V2 (NOT view → must use callStatic)
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle(address,address,uint256,uint24,uint160) external returns (uint256)"
];

// helpers
const toUnits = (v,d)=>ethers.utils.parseUnits(v, d);
const fmt = (v,d)=>ethers.utils.formatUnits(v, d);

async function requireBase(){
  if(!signer) throw new Error("Connect wallet first");
  const net = await provider.getNetwork();
  $("netLabel").textContent = `${net.name} (chainId ${net.chainId})`;
  if(Number(net.chainId)!==8453) throw new Error("Please switch network to Base (8453)");
}

// ----- Quote (use callStatic) -----
async function doQuote(){
  try{
    await requireBase();
    const tokenIn  = $("tokenIn").value.trim();
    const tokenOut = $("tokenOut").value.trim();
    const fee      = Number($("fee").value||3000);
    const amount   = $("amountIn").value.trim();
    const quoter   = $("quoter").value.trim();

    if(!tokenIn || !tokenOut) throw new Error("Fill token addresses");
    if(!amount || Number(amount)<=0) throw new Error("Fill a valid amount");

    const [decIn, decOut] = await Promise.all([
      new ethers.Contract(tokenIn, ERC20_ABI, provider).decimals(),
      new ethers.Contract(tokenOut, ERC20_ABI, provider).decimals()
    ]);

    const amountIn = toUnits(amount, decIn);

    if(!quoter) throw new Error("No Quoter set — quote unavailable (still can Swap)");

    const quoterC = new ethers.Contract(quoter, QUOTER_V2_ABI, provider);
    // ✅ simulate instead of sending a tx
    const out = await quoterC.callStatic.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, 0);

    const slip = Number($("slippage").value||"0.5");
    const outMin = out.mul(10000 - Math.round(slip*100)).div(10000);

    $("quoteBox").textContent = `≈ ${fmt(out,decOut)} (min ~${fmt(outMin,decOut)} @ ${slip}%)`;
    log(`Quote: ${amount} in -> ${fmt(out,decOut)} out (fee ${fee})`);
  }catch(e){
    $("quoteBox").textContent = "—";
    log(`Quote error: ${e.message||e}`);
  }
}

// ----- Approve -----
async function doApprove(){
  try{
    await requireBase();
    const router = $("router").value.trim();
    const tokenIn = $("tokenIn").value.trim();
    const amount  = $("amountIn").value.trim();
    if(!tokenIn || !router) throw new Error("Missing token/router");

    const decIn = await new ethers.Contract(tokenIn, ERC20_ABI, provider).decimals();
    const amountIn = toUnits(amount, decIn);

    const erc = new ethers.Contract(tokenIn, ERC20_ABI, signer);
    const owner = await signer.getAddress();
    const allowance = await erc.allowance(owner, router);
    if(allowance.gte(amountIn)){ log("Approve skipped (enough allowance)"); return; }

    log(`Approving ${amount} to router...`);
    const tx = await erc.approve(router, amountIn);
    log(`Approve tx: ${tx.hash}`); await tx.wait(); log("✅ Approve confirmed");
  }catch(e){ log(`Approve error: ${e.message||e}`); }
}

// ----- Swap (try exactInputSingle → fallback exactInput) -----
function buildPath(tokenIn, fee, tokenOut){
  return ethers.utils.solidityPack(["address","uint24","address"], [tokenIn, fee, tokenOut]);
}

async function doSwap(){
  try{
    await requireBase();

    const router   = $("router").value.trim();   // default: 0x6fF5693b99212Da76ad316178A184AB56D299b43
    const tokenIn  = $("tokenIn").value.trim();
    const tokenOut = $("tokenOut").value.trim();
    const fee      = Number($("fee").value||3000);
    const amount   = $("amountIn").value.trim();
    const slip     = Number($("slippage").value||"0.5");
    const ddlMin   = Number($("deadline").value||"10");

    const tIn  = new ethers.Contract(tokenIn,  ERC20_ABI, provider);
    const tOut = new ethers.Contract(tokenOut, ERC20_ABI, provider);
    const [decIn, decOut] = await Promise.all([tIn.decimals(), tOut.decimals()]);
    const amountIn = toUnits(amount, decIn);

    // (optional) re-quote → minOut (callStatic)
    let minOut = ethers.constants.Zero;
    try{
      const quoter = $("quoter").value.trim();
      if(quoter){
        const q = new ethers.Contract(quoter, QUOTER_V2_ABI, provider);
        const quoted = await q.callStatic.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, 0); // ✅
        minOut = quoted.mul(10000 - Math.round(slip*100)).div(10000);
      } else {
        log("⚠️ No Quoter set — using minOut=0");
      }
    }catch(qe){ log(`Quoter failed (${qe.message||qe}) — using minOut=0`); }

    const owner   = await signer.getAddress();
    const routerC = new ethers.Contract(router, SWAP_ABI, signer);
    const deadline = Math.floor(Date.now()/1000) + ddlMin*60;

    const params = {
      tokenIn, tokenOut,
      fee,
      recipient: owner,
      deadline,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0
    };

    log(`Trying exactInputSingle(...) on router ${router}`);
    try{
      const tx = await routerC.exactInputSingle(params, { value: 0 });
      log(`Swap tx: ${tx.hash}`);
      const rc = await tx.wait();
      log(`✅ Swap confirmed in block ${rc.blockNumber}`);
      return;
    }catch(e1){
      log(`exactInputSingle failed: ${e1.reason||e1.message||e1}`);
      // Fallback: exactInput(path,...)
      const path = buildPath(tokenIn, fee, tokenOut);
      log(`Trying exactInput(path, ...) fallback`);
      const tx2 = await routerC.exactInput(path, owner, deadline, amountIn, minOut, { value: 0 });
      log(`Swap tx: ${tx2.hash}`);
      const rc2 = await tx2.wait();
      log(`✅ Swap (fallback) confirmed in block ${rc2.blockNumber}`);
    }
  }catch(e){ log(`Swap error: ${e.reason||e.message||e}`); }
}

// ----- wireup -----
window.addEventListener("DOMContentLoaded", ()=>{
  initModal();
  $("connectBtn").onclick = connect;
  $("disconnectBtn").onclick = disconnect;
  $("quoteBtn").onclick = doQuote;
  $("approveBtn").onclick = doApprove;
  $("swapBtn").onclick = doSwap;
});
