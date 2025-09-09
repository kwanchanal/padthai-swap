/* PadThai Swap • Web3Modal v1 + ethers v5 + Uniswap V2
 * - รองรับ Injected (MetaMask/Brave) + WalletConnect (QR)
 * - Quote: router.getAmountsOut
 * - Swap:  router.swapExactETHForTokens (ETH -> ERC20)
 */

const $ = (id) => document.getElementById(id);
const log = (m) => { const a = $("logArea"); a.textContent += `${new Date().toLocaleTimeString()}  ${m}\n`; a.scrollTop = a.scrollHeight; };

// Constants (Ethereum Mainnet)
const WETH = "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2";
const DEFAULT_TO = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)"
];

// State
let web3Modal;              // Web3Modal instance
let extProvider = null;     // EIP-1193 provider from Web3Modal
let ethersProvider = null;  // ethers.providers.Web3Provider
let signer = null;

// Init Web3Modal
function initWeb3Modal() {
  const providerOptions = {
    walletconnect: {
      package: window.WalletConnectProvider.default,
      options: {
        // ตั้ง RPC สำหรับ mainnet (ใช้ Cloudflare public endpoint)
        rpc: { 1: "https://cloudflare-eth.com" }
        // ถ้ามี Alchemy/Infura ใส่ได้ เช่น: rpc: {1: "https://eth-mainnet.g.alchemy.com/v2/XXXX"}
      }
    }
    // เพิ่มผู้ให้บริการอื่นได้ในอนาคต
  };

  web3Modal = new window.Web3Modal.default({
    cacheProvider: true,
    providerOptions,
    theme: "dark"
  });

  if (web3Modal.cachedProvider) {
    connect(); // auto-reconnect
  }
}

async function connect() {
  try {
    if (!window.Web3Modal || !window.ethers) {
      throw new Error("Dependencies not loaded");
    }
    extProvider = await web3Modal.connect(); // opens modal (Injected / QR)
    subscribeProvider(extProvider);

    ethersProvider = new ethers.providers.Web3Provider(extProvider);
    signer = ethersProvider.getSigner();

    const network = await ethersProvider.getNetwork();
    $("networkLabel").textContent = `${network.name} (chainId ${network.chainId})`;

    if (Number(network.chainId) !== 1) {
      $("networkLabel").style.background = "#2a1b1b";
      $("networkLabel").style.color = "#fca5a5";
      log(`Warning: chainId=${network.chainId}. โค้ดนี้ตั้ง address สำหรับ Ethereum mainnet`);
    } else {
      $("networkLabel").style.background = "#102215";
      $("networkLabel").style.color = "#86efac";
    }

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
  } catch (e) { /* ignore */ }
  extProvider = null; ethersProvider = null; signer = null;
  $("networkLabel").textContent = "Not connected";
  $("quoteText").textContent = "—";
  log("Disconnected");
}

function subscribeProvider(provider) {
  if (!provider || !provider.on) return;

  provider.on("accountsChanged", async (accounts) => {
    log(`accountsChanged: ${accounts.join(", ")}`);
    if (ethersProvider) signer = ethersProvider.getSigner();
  });

  provider.on("chainChanged", async (chainId) => {
    log(`chainChanged: ${chainId}`);
    if (ethersProvider) {
      const network = await ethersProvider.getNetwork();
      $("networkLabel").textContent = `${network.name} (chainId ${network.chainId})`;
    }
  });

  provider.on("disconnect", (code, reason) => {
    log(`provider disconnect: ${code} ${reason || ""}`);
  });
}

function toWeiEth(v) {
  if (!v || Number(v) <= 0) throw new Error("Invalid amount");
  return ethers.utils.parseEther(v.toString());
}

function fmt(v, d = 18) {
  try { return ethers.utils.formatUnits(v, d); } catch { return v.toString(); }
}

async function getQuote() {
  try {
    if (!signer) throw new Error("Connect wallet first");
    const routerAddr = $("routerAddress").value.trim();
    const tokenOut = $("tokenOut").value.trim() || DEFAULT_TO;
    const amountInEth = $("amountIn").value.trim();
    const amountInWei = toWeiEth(amountInEth);

    const router = new ethers.Contract(routerAddr, ROUTER_ABI, ethersProvider);
    const path = [WETH, tokenOut];
    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length - 1];

    $("quoteText").textContent = `~ ${fmt(outWei)} tokens (before slippage)`;
    log(`Quote: ${amountInEth} ETH -> ~${fmt(outWei)} tokens`);
  } catch (err) {
    $("quoteText").textContent = "—";
    log(`Quote error: ${err.message || err}`);
  }
}

async function doSwap() {
  try {
    if (!signer) throw new Error("Connect wallet first");
    const routerAddr = $("routerAddress").value.trim();
    const tokenOut = $("tokenOut").value.trim() || DEFAULT_TO;

    const amountInEth = $("amountIn").value.trim();
    const slippagePct = Number($("slippage").value || "0.5");
    const deadlineMins = Number($("deadlineMins").value || "10");

    const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
    const to = await signer.getAddress();
    const path = [WETH, tokenOut];
    const amountInWei = toWeiEth(amountInEth);

    // Quote → outMin (apply slippage)
    const amounts = await router.getAmountsOut(amountInWei, path);
    const outWei = amounts[amounts.length - 1];

    const million = ethers.BigNumber.from(1_000_000);
    const factor = million.mul(1000 - Math.round(slippagePct * 10)).div(1000); // (1 - p%) scaled by 1e6
    const outMinWei = outWei.mul(factor).div(million);
    const deadline = Math.floor(Date.now() / 1000) + deadlineMins * 60;

    log(`Swapping ${amountInEth} ETH with outMin=${fmt(outMinWei)} (slippage ${slippagePct}%)...`);

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
    log(`Swap error: ${err.reason || err.message || err}`);
  }
}

// Wire up UI
window.addEventListener("DOMContentLoaded", () => {
  initWeb3Modal();
  $("connectButton").addEventListener("click", connect);
  $("disconnectButton").addEventListener("click", disconnect);
  $("quoteButton").addEventListener("click", getQuote);
  $("swapButton").addEventListener("click", doSwap);
  $("amountIn").addEventListener("keydown", (e) => { if (e.key === "Enter") getQuote(); });

  // Sanity checks
  if (!window.Web3Modal) log("❌ Web3Modal not loaded");
  if (!window.WalletConnectProvider) log("❌ WalletConnectProvider not loaded");
  if (!window.ethers) log("❌ ethers not loaded");
});
