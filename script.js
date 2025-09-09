/* Simple Swap MVP - Uniswap V2 (ETH -> ERC20)
 * - Connect wallet
 * - Quote via getAmountsOut
 * - Swap via swapExactETHForTokens
 * - Ethers v6
 */

const el = (id) => document.getElementById(id);
const log = (m) => {
  const a = el("logArea");
  a.textContent += `${new Date().toLocaleTimeString()}  ${m}\n`;
  a.scrollTop = a.scrollHeight;
};

let provider = null;
let signer = null;

const DEFAULT_WETH = "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2"; // WETH (Mainnet)
const DEFAULT_DAI  = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI  (Mainnet)

// Minimal ABI: swap + quote
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)"
];

async function connect() {
  if (!window.ethereum) {
    alert("Please install MetaMask or a compatible wallet.");
    return;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();

  const net = await provider.getNetwork();
  const chainIdHex = "0x" + net.chainId.toString(16);
  el("networkLabel").textContent = `${net.name} (chainId ${net.chainId})`;
  if (Number(net.chainId) !== 1) {
    el("networkLabel").style.background = "#2a1b1b";
    el("networkLabel").style.color = "#fca5a5";
    log(`Warning: You are not on Ethereum mainnet. Quotes/Swaps expect Mainnet addresses.`);
  } else {
    el("networkLabel").style.background = "#102215";
    el("networkLabel").style.color = "#86efac";
  }

  const addr = await signer.getAddress();
  log(`Connected: ${addr}`);
}

function parseUnitsEth(v) {
  if (!v || Number(v) <= 0) throw new Error("Invalid amount");
  return ethers.parseEther(v.toString());
}

function formatUnits(v, decimals = 18) {
  try { return ethers.formatUnits(v, decimals); } catch { return v.toString(); }
}

async function getQuote() {
  try {
    if (!signer) throw new Error("Connect wallet first");
    const routerAddr = el("routerAddress").value.trim();
    const tokenOut = el("tokenOut").value.trim() || DEFAULT_DAI;
    const amountInEth = el("amountIn").value.trim();

    const amountInWei = parseUnitsEth(amountInEth);
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);

    const path = [DEFAULT_WETH, tokenOut]; // ETH wraps to WETH internally
    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length - 1];

    const outFormatted = formatUnits(outWei, 18);
    el("quoteText").textContent = `~ ${outFormatted} tokens (before slippage)`;
    log(`Quote: ${amountInEth} ETH -> ~${outFormatted} tokens (path WETH -> tokenOut)`);
  } catch (err) {
    log(`Quote error: ${err.message || err}`);
    el("quoteText").textContent = "—";
  }
}

async function doSwap() {
  try {
    if (!signer) throw new Error("Connect wallet first");
    const routerAddr = el("routerAddress").value.trim();
    const tokenOut = el("tokenOut").value.trim() || DEFAULT_DAI;

    const amountInEth = el("amountIn").value.trim();
    const slippagePct = Number(el("slippage").value || "0.5");
    const deadlineMins = Number(el("deadlineMins").value || "10");

    // Prepare
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
    const to = await signer.getAddress();
    const path = [DEFAULT_WETH, tokenOut];
    const amountInWei = parseUnitsEth(amountInEth);

    // 1) Quote for amountOutMin with slippage buffer
    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length - 1];

    const slip = ethers.toBigInt(Math.floor((1 - slippagePct / 100) * 1e6));
    const outMinWei = (outWei * slip) / ethers.toBigInt(1e6);
    const deadline = Math.floor(Date.now() / 1000) + deadlineMins * 60;

    log(`Swapping ${amountInEth} ETH with outMin=${formatUnits(outMinWei)} (slippage ${slippagePct}%)...`);

    // 2) Call swapExactETHForTokens (payable)
    const tx = await router.swapExactETHForTokens(
      outMinWei,
      path,
      to,
      deadline,
      { value: amountInWei }
    );

    log(`Submitted tx: ${tx.hash}`);
    const receipt = await tx.wait();
    log(`✅ Confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    log(`Swap error: ${err.shortMessage || err.message || err}`);
  }
}

// Wire up UI
window.addEventListener("DOMContentLoaded", () => {
  el("connectButton").addEventListener("click", connect);
  el("quoteButton").addEventListener("click", getQuote);
  el("swapButton").addEventListener("click", doSwap);

  // small UX touch: pressing Enter in amount triggers quote
  el("amountIn").addEventListener("keydown", (e) => {
    if (e.key === "Enter") getQuote();
  });
});
