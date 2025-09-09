/* PadThai Swap
 * - Web3Modal v1 + WalletConnect + ethers v5
 * - Card #1: Uniswap V2 (ETH mainnet) — like before
 * - Card #2: Base + Uniswap V3 (SwapRouter02.exactInputSingle)
 */

const $ = (id) => document.getElementById(id);
const log = (m) => { const a = $("logArea"); a.textContent += `${new Date().toLocaleTimeString()}  ${m}\n`; a.scrollTop = a.scrollHeight; };

// -------------------- Common: Web3Modal --------------------
let web3Modal, extProvider = null, ethersProvider = null, signer = null;

function initWeb3Modal() {
  const providerOptions = {
    walletconnect: {
      package: window.WalletConnectProvider.default,
      options: {
        rpc: {
          1: "https://cloudflare-eth.com",           // Ethereum
          8453: "https://mainnet.base.org"           // Base
        }
      }
    }
  };

  web3Modal = new window.Web3Modal.default({
    cacheProvider: true,
    providerOptions,
    theme: "dark"
  });

  if (web3Modal.cachedProvider) connect();
}

async function connect() {
  try {
    if (!window.Web3Modal || !window.ethers) throw new Error("Dependencies not loaded");

    extProvider = await web3Modal.connect();
    subscribeProvider(extProvider);

    ethersProvider = new ethers.providers.Web3Provider(extProvider);
    signer = ethersProvider.getSigner();

    const network = await ethersProvider.getNetwork();
    $("networkLabel").textContent = `${network.name} (chainId ${network.chainId})`;
    $("baseNetworkLabel").textContent = `${network.name} (chainId ${network.chainId})`;

    const addr = await signer.getAddress();
    log(`Connected: ${addr}`);
  } catch (err) {
    log(`Connect error: ${err.message || err}`);
    alert(err.message || err);
  }
}

async function disconnect() {
  try {
    if (web3Modal) await web3Modal.clearCachedProvider();
    if (extProvider && extProvider.disconnect && typeof extProvider.disconnect === "function") {
      await extProvider.disconnect();
    }
  } catch (_) {}
  extProvider = null; ethersProvider = null; signer = null;
  $("networkLabel").textContent = "Not connected";
  $("baseNetworkLabel").textContent = "Not connected";
  $("quoteText").textContent = "—";
  $("baseQuoteText").textContent = "—";
  log("Disconnected");
}

function subscribeProvider(provider) {
  if (!provider || !provider.on) return;
  provider.on("accountsChanged", (a) => log(`accountsChanged: ${a.join(",")}`));
  provider.on("chainChanged", (cid) => log(`chainChanged: ${cid}`));
  provider.on("disconnect", (c, r) => log(`provider disconnect: ${c} ${r||""}`));
}

// -------------------- Card #1: Uniswap V2 (ETH) --------------------
const WETH_MAIN = "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2";
const ROUTER_V2_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)"
];

function toWeiEth(v){ if(!v||Number(v)<=0) throw new Error("Invalid amount"); return ethers.utils.parseEther(v.toString()); }
function fmt(v, d=18){ try{ return ethers.utils.formatUnits(v, d);}catch{return v.toString();} }

async function getQuoteV2(){
  try{
    if(!signer) throw new Error("Connect wallet first");
    const routerAddr = $("routerAddress").value.trim();
    const tokenOut = $("tokenOut").value.trim();
    const amountInEth = $("amountIn").value.trim();
    const amountInWei = toWeiEth(amountInEth);

    const router = new ethers.Contract(routerAddr, ROUTER_V2_ABI, ethersProvider);
    const path = [WETH_MAIN, tokenOut];
    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length-1];
    $("quoteText").textContent = `~ ${fmt(outWei)} tokens (before slippage)`;
    log(`Quote (V2): ${amountInEth} ETH -> ~${fmt(outWei)} tokens`);
  }catch(err){
    $("quoteText").textContent = "—";
    log(`Quote error: ${err.message||err}`);
  }
}

async function swapV2(){
  try{
    if(!signer) throw new Error("Connect wallet first");
    const routerAddr = $("routerAddress").value.trim();
    const tokenOut = $("tokenOut").value.trim();
    const amountInEth = $("amountIn").value.trim();
    const slippagePct = Number($("slippage").value||"0.5");
    const deadlineMins = Number($("deadlineMins").value||"10");

    const router = new ethers.Contract(routerAddr, ROUTER_V2_ABI, signer);
    const to = await signer.getAddress();
    const path = [WETH_MAIN, tokenOut];
    const amountInWei = toWeiEth(amountInEth);

    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length-1];

    const million = ethers.BigNumber.from(1_000_000);
    const factor  = million.mul(1000 - Math.round(slippagePct*10)).div(1000);
    const outMinWei = outWei.mul(factor).div(million);
    const deadline = Math.floor(Date.now()/1000) + deadlineMins*60;

    log(`Swap V2: ${amountInEth} ETH, minOut=${fmt(outMinWei)} (slip ${slippagePct}%)`);
    const tx = await router.swapExactETHForTokens(outMinWei, path, to, deadline, { value: amountInWei });
    log(`Submitted tx: ${tx.hash}`);
    const rc = await tx.wait();
    log(`✅ Confirmed block ${rc.blockNumber}`);
  }catch(err){
    log(`Swap error: ${err.reason||err.message||err}`);
  }
}

// -------------------- Card #2: Base + Uniswap V3 --------------------
// We’ll use SwapRouter02.exactInputSingle()
// Router (Base): 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
// QuoterV2 (Base)*: commonly 0x61fFE014bA17989E743c5F6cB21bF9697530B21e (edit if needed)
const CHAIN_ID_BASE = 8453;
const QUOTER_V2_ADDR_DEFAULT = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const SWAPROUTER02_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"
];

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
];

async function ensureBase(){
  if(!signer) throw new Error("Connect wallet first");
  const net = await ethersProvider.getNetwork();
  $("baseNetworkLabel").textContent = `${net.name} (chainId ${net.chainId})`;
  if(Number(net.chainId)!==CHAIN_ID_BASE){
    $("baseNetworkLabel").style.background = "#2a1b1b";
    $("baseNetworkLabel").style.color = "#fca5a5";
    throw new Error("Please switch to Base (chainId 8453)");
  }else{
    $("baseNetworkLabel").style.background = "#102215";
    $("baseNetworkLabel").style.color = "#86efac";
  }
}

async function baseQuoteV3(){
  try{
    await ensureBase();
    const tokenIn  = $("baseTokenIn").value.trim();
    const tokenOut = $("baseTokenOut").value.trim();
    const fee      = Number($("baseFee").value||3000);
    const amountInStr = $("baseAmountIn").value.trim();
    const quoterAddr = QUOTER_V2_ADDR_DEFAULT;

    const tIn  = new ethers.Contract(tokenIn,  ERC20_ABI, ethersProvider);
    const tOut = new ethers.Contract(tokenOut, ERC20_ABI, ethersProvider);
    const [decIn, decOut] = await Promise.all([tIn.decimals(), tOut.decimals()]);
    const amountIn = ethers.utils.parseUnits(amountInStr||"0", decIn);

    const quoter = new ethers.Contract(quoterAddr, QUOTER_V2_ABI, ethersProvider);
    const out = await quoter.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, 0);
    const outFmt = ethers.utils.formatUnits(out, decOut);

    const slip = Number($("baseSlippage").value||"0.5");
    const outMin = out.mul(10000 - Math.round(slip*100)).div(10000);
    const outMinFmt = ethers.utils.formatUnits(outMin, decOut);

    $("baseQuoteText").textContent = `~ ${outFmt} (min ~${outMinFmt} @ ${slip}% slippage)`;
    log(`Quote (V3/Base): ${amountInStr} in -> ~${outFmt}`);
  }catch(err){
    $("baseQuoteText").textContent = "—";
    log(`Base quote error: ${err.message||err}`);
  }
}

async function baseSwapV3(){
  try{
    await ensureBase();
    const routerAddr = $("baseRouter").value.trim();
    const tokenIn  = $("baseTokenIn").value.trim();
    const tokenOut = $("baseTokenOut").value.trim();
    const fee      = Number($("baseFee").value||3000);
    const amtStr   = $("baseAmountIn").value.trim();
    const slipPct  = Number($("baseSlippage").value||"0.5");
    const deadlineMins = Number($("baseDeadlineMins").value||"10");

    const tIn  = new ethers.Contract(tokenIn,  ERC20_ABI, signer);
    const tOut = new ethers.Contract(tokenOut, ERC20_ABI, signer);
    const [decIn, decOut] = await Promise.all([tIn.decimals(), tOut.decimals()]);
    const amountIn = ethers.utils.parseUnits(amtStr, decIn);

    // Approve router if needed
    const owner = await signer.getAddress();
    const allowance = await tIn.allowance(owner, routerAddr);
    if(allowance.lt(amountIn)){
      log(`Approving ${amtStr} to router...`);
      const txA = await tIn.approve(routerAddr, amountIn);
      await txA.wait();
      log("✅ Approve confirmed");
    }

    // Get fresh quote -> outMin
    const quoter = new ethers.Contract(QUOTER_V2_ADDR_DEFAULT, QUOTER_V2_ABI, ethersProvider);
    const quotedOut = await quoter.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, 0);
    const outMin = quotedOut.mul(10000 - Math.round(slipPct*100)).div(10000);
    const deadline = Math.floor(Date.now()/1000) + deadlineMins*60;

    const router = new ethers.Contract(routerAddr, SWAPROUTER02_ABI, signer);
    const params = {
      tokenIn, tokenOut,
      fee,
      recipient: owner,
      deadline,
      amountIn,
      amountOutMinimum: outMin,
      sqrtPriceLimitX96: 0
    };

    log(`Swapping V3/Base: ${amtStr} in, minOut=${fmt(outMin, decOut)} (fee ${fee})`);
    const tx = await router.exactInputSingle(params, { value: 0 });
    log(`Submitted tx: ${tx.hash}`);
    const rc = await tx.wait();
    log(`✅ Confirmed block ${rc.blockNumber}`);
  }catch(err){
    log(`Base swap error: ${err.reason||err.message||err}`);
  }
}

// -------------------- Wire up UI --------------------
window.addEventListener("DOMContentLoaded", () => {
  initWeb3Modal();

  // Card #1
  $("connectButton").addEventListener("click", connect);
  $("disconnectButton").addEventListener("click", disconnect);
  $("quoteButton").addEventListener("click", getQuoteV2);
  $("swapButton").addEventListener("click", swapV2);
  $("amountIn").addEventListener("keydown", (e)=>{ if(e.key==="Enter") getQuoteV2(); });

  // Card #2
  $("baseQuoteButton").addEventListener("click", baseQuoteV3);
  $("baseSwapButton").addEventListener("click", baseSwapV3);

  // Sanity checks
  if(!window.Web3Modal) log("❌ Web3Modal not loaded");
  if(!window.WalletConnectProvider) log("❌ WalletConnectProvider not loaded");
  if(!window.ethers) log("❌ ethers not loaded");
});
