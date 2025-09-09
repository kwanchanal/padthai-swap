<!-- ใส่ไว้ท้าย <body> ของหน้า index.html -->
<script type="module">
import { EthereumClient, w3mConnectors, w3mProvider } from 'https://unpkg.com/@web3modal/ethereum@2.7.1/dist/index.js?module';
import { Web3Modal } from 'https://unpkg.com/@web3modal/html@2.7.1/dist/index.js?module';
import { ethers } from 'https://esm.sh/ethers@5.7.2';

/// ================== CONFIG ==================
const CHAIN_ID = 8453; // Base
const ADDR = {
  base: {
    // Uniswap v3
    QUOTER_V3: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    SWAP_ROUTER_02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    // Uniswap v4
    POOL_MANAGER: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    QUOTER_V4: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
    UNIVERSAL_ROUTER: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    WETH: '0x4200000000000000000000000000000000000006'
  }
};
// Defaults ตามที่คุณบอก
const DEFAULTS = {
  tokenIn:  '0x2d1aDB45Bb1d7D2556c6558aDb76CFD4F9F4ed16', // USDT (ตัวที่คุณใช้)
  tokenOut: '0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F', // THBT
  // ลองค่ามาตรฐานก่อน ถ้า pool จริงต่างไป ให้เปลี่ยนให้ตรง:
  v4: { fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' },
  v3: { fee: 3000 }
};

/// ================== ABIs ==================
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const QUOTER_V3_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

// IV4Quoter: quoteExactInputSingle((poolKey, zeroForOne, exactAmount, hookData))
const QUOTER_V4_ABI = [
  "function quoteExactInputSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),bool,uint256,bytes) external returns (uint256 amountOut,uint256 gasEstimate)"
];

// Universal Router (v2) minimal
const UR_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"
];

// Permit2 minimal
const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external"
];

/// ================== Web3Modal ==================
const projectId = "demo"; // ใส่ของคุณ
const chains = [{ id: CHAIN_ID, name: 'Base', network: 'base', rpcUrls: {default: {http: ['https://mainnet.base.org']}} }];
const { modal, getProvider, getAccount, getSigner } = initWeb3Modal();

function initWeb3Modal(){
  const ethersConfig = {
    autoConnect: true,
    connectors: w3mConnectors({ chains, version: 2, projectId }),
    provider: w3mProvider({ projectId })
  };
  const ethereumClient = new EthereumClient(ethersConfig, chains);
  const modal = new Web3Modal({ projectId, themeMode: 'light', walletImages: {}} , ethereumClient);
  return {
    modal,
    async getProvider(){ 
      const p = new ethers.providers.Web3Provider(ethereumClient.getProvider(), 'any');
      return p;
    },
    async getAccount(){ return ethereumClient.getAccount(); },
    async getSigner(){ const p = await getProvider(); return p.getSigner(); }
  };
}

/// ================== UI HELPERS ==================
const $ = (sel)=>document.querySelector(sel);
const log = (msg)=>{ const box = $('#logs'); if(box){ box.textContent += (msg + '\n'); box.scrollTop = box.scrollHeight; } };

/// ================== TOKEN HELPERS ==================
async function tokenMeta(provider, addr){
  const t = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([t.symbol().catch(()=>''), t.decimals().catch(()=>18)]);
  return { contract: t, symbol, decimals };
}

/// ================== QUOTE (v4 first, then v3 fallback) ==================
async function quote({ tokenIn, tokenOut, amountInHuman, preferV4=true, v4={fee:3000,tickSpacing:60,hooks:ethers.constants.AddressZero}, v3={fee:3000} }){
  const provider = await getProvider();
  const { decimals: dIn }  = await tokenMeta(provider, tokenIn);
  const { decimals: dOut } = await tokenMeta(provider, tokenOut);
  const amountIn = ethers.utils.parseUnits(amountInHuman, dIn);

  // v4 try
  if (preferV4){
    try{
      const quoter = new ethers.Contract(ADDR.base.QUOTER_V4, QUOTER_V4_ABI, provider);
      // ต้องจัดเรียง currency0 < currency1 ตาม v4
      const [c0,c1] = (tokenIn.toLowerCase() < tokenOut.toLowerCase())
        ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
      const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase();

      const poolKey = {
        currency0: c0,
        currency1: c1,
        fee: v4.fee,
        tickSpacing: v4.tickSpacing,
        hooks: v4.hooks
      };

      const res = await quoter.callStatic.quoteExactInputSingle(poolKey, zeroForOne, amountIn, '0x');
      const amountOut = res.amountOut || res[0];
      return {
        engine: 'v4',
        amountOut,
        amountOutHuman: ethers.utils.formatUnits(amountOut, dOut)
      };
    }catch(e){
      log(`v4 quote failed: ${shortErr(e)}`);
      // fall through
    }
  }

  // v3 fallback
  try{
    const quoterV3 = new ethers.Contract(ADDR.base.QUOTER_V3, QUOTER_V3_ABI, provider);
    // sqrtPriceLimitX96 = 0 (ไม่จำกัด)
    const out = await quoterV3.callStatic.quoteExactInputSingle(tokenIn, tokenOut, v3.fee, amountIn, 0);
    return {
      engine: 'v3',
      amountOut: out,
      amountOutHuman: ethers.utils.formatUnits(out, dOut)
    };
  }catch(e){
    throw new Error(`Both v4 and v3 quotes failed. Last error: ${shortErr(e)}`);
  }
}

/// ================== APPROVALS (Permit2 flow for Universal Router) ==================
async function ensurePermit2(tokenAddr, owner){
  const signer = await getSigner();
  const provider = await getProvider();
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const permit2 = new ethers.Contract(ADDR.base.PERMIT2, PERMIT2_ABI, signer);

  // Step 1: approve token -> Permit2 (Max)
  const cur = await token.allowance(owner, ADDR.base.PERMIT2);
  if (cur.lt(ethers.constants.MaxUint256.div(2))){
    log(`Approving ERC20 -> Permit2 ...`);
    const tx = await token.approve(ADDR.base.PERMIT2, ethers.constants.MaxUint256);
    await tx.wait();
  }

  // Step 2: approve Permit2 -> Universal Router
  // amount: uint160 max, expiration: now + 1y (uint48)
  const amountMaxUint160 = ethers.BigNumber.from(2).pow(160).sub(1);
  const expiration = Math.floor(Date.now()/1000) + 3600*24*365;
  log(`Approving Permit2 -> Universal Router ...`);
  const tx2 = await permit2.approve(tokenAddr, ADDR.base.UNIVERSAL_ROUTER, amountMaxUint160, expiration);
  await tx2.wait();

  log(`Permit2 approvals ready.`);
}

/// ================== SWAP via Universal Router (V3_SWAP_EXACT_IN single-hop) ==================
async function swapViaUR_V3Single({ tokenIn, tokenOut, amountInHuman, minOutHuman, fee=3000 }){
  const signer = await getSigner();
  const provider = await getProvider();
  const acct = await getAccount();
  const recipient = acct.address;

  const metaIn  = await tokenMeta(provider, tokenIn);
  const metaOut = await tokenMeta(provider, tokenOut);

  const amountIn  = ethers.utils.parseUnits(amountInHuman,  metaIn.decimals);
  const amountOutMin = ethers.utils.parseUnits(minOutHuman||'0', metaOut.decimals);

  // approvals via Permit2
  await ensurePermit2(tokenIn, recipient);

  // build v3 path: tokenIn -> tokenOut with fee
  // solidityPack(address,uint24,address)
  const path = ethers.utils.solidityPack(
    ['address','uint24','address'],
    [tokenIn, fee, tokenOut]
  );

  // build command & input
  const CMD_V3_SWAP_EXACT_IN = '0x00';
  const commands = CMD_V3_SWAP_EXACT_IN;

  // inputs[i] = abi.encode(recipient, amountIn, amountOutMin, path, payerIsUser=true)
  const abiCoder = new ethers.utils.AbiCoder();
  const input0 = abiCoder.encode(
    ['address','uint256','uint256','bytes','bool'],
    [recipient, amountIn, amountOutMin, path, true]
  );

  const ur = new ethers.Contract(ADDR.base.UNIVERSAL_ROUTER, UR_ABI, signer);
  const deadline = Math.floor(Date.now()/1000) + 60*10;

  log(`Sending swap via Universal Router (V3_SWAP_EXACT_IN)…`);
  const tx = await ur.execute(commands, [input0], deadline, { value: 0 });
  const rc = await tx.wait();
  log(`Swap done. Tx: ${tx.hash}`);
  return rc;
}

/// ================== WIRES TO YOUR UI ==================
/// ปุ่ม/อินพุต: ปรับ selector ให้ตรงกับหน้า HTML ของคุณ
$('#connectBtn')?.addEventListener('click', ()=> modal.open());
$('#quoteBtn')?.addEventListener('click', async ()=>{
  try{
    const tokenIn  = ($('#tokenIn')?.value || DEFAULTS.tokenIn).trim();
    const tokenOut = ($('#tokenOut')?.value || DEFAULTS.tokenOut).trim();
    const amount   = ($('#amountIn')?.value || '1').trim();

    // ค่าตาม pool v4 ของจริง: เปลี่ยนได้ที่กล่อง config หรือฮาร์ดโค้ดด้านบน
    const v4 = {
      fee: Number($('#v4fee')?.value || DEFAULTS.v4.fee),
      tickSpacing: Number($('#v4tick')?.value || DEFAULTS.v4.tickSpacing),
      hooks: ($('#v4hooks')?.value || DEFAULTS.v4.hooks).trim()
    };
    const v3 = { fee: Number($('#v3fee')?.value || DEFAULTS.v3.fee) };

    const q = await quote({ tokenIn, tokenOut, amountInHuman: amount, preferV4: true, v4, v3 });
    $('#quoteOut').textContent = q.amountOutHuman;
    $('#engine').textContent = q.engine.toUpperCase();
    log(`Quoted (${q.engine}): ${q.amountOutHuman}`);
  }catch(e){
    log(`Quote error: ${shortErr(e)}`);
    alert(`Quote error: ${e.message}`);
  }
});

$('#swapBtn')?.addEventListener('click', async ()=>{
  try{
    const tokenIn  = ($('#tokenIn')?.value || DEFAULTS.tokenIn).trim();
    const tokenOut = ($('#tokenOut')?.value || DEFAULTS.tokenOut).trim();
    const amount   = ($('#amountIn')?.value || '1').trim();
    const minOut   = ($('#minOut')?.value || '0').trim();
    const fee      = Number($('#v3fee')?.value || DEFAULTS.v3.fee);

    const router = ($('#router')?.value || ADDR.base.UNIVERSAL_ROUTER).trim();

    if (router.toLowerCase() === ADDR.base.UNIVERSAL_ROUTER.toLowerCase()){
      await swapViaUR_V3Single({ tokenIn, tokenOut, amountInHuman: amount, minOutHuman: minOut, fee });
    } else if (router.toLowerCase() === ADDR.base.SWAP_ROUTER_02.toLowerCase()){
      alert('This build focuses on Universal Router. If you need SwapRouter02 path, ping me and I’ll add it.');
    } else {
      alert('Unknown router. Use Universal Router on Base: ' + ADDR.base.UNIVERSAL_ROUTER);
    }
  }catch(e){
    log(`Swap error: ${shortErr(e)}`);
    alert(`Swap error: ${e.message}`);
  }
});

function shortErr(e){
  const s = (e && (e.reason || e.data?.message || e.error?.message || e.message)) || String(e);
  return s.length>220 ? s.slice(0,220)+'…' : s;
}

</script>
