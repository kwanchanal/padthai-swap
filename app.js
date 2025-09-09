/* app.js (ESM module) */
import * as viemLib from "https://esm.sh/viem@2.21.5";

(() => {
  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const log = (...args) => {
    const box = $('logBox');
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
    if (box) box.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + box.textContent;
    console.log(...args);
  };
  $('clearLog')?.addEventListener('click', () => { const b=$('logBox'); if (b) b.textContent=''; });

  // ---------- chain & addresses ----------
  const CHAIN = {
    id: 8453,
    name: 'Base',
    rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
  };
  const ADDR = {
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // 6
    THBT: '0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F', // 18
    UNIVERSAL_ROUTER: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    POOL_MANAGER:     '0x498581ff718922c3f8e6a244956af099b2652b2b',
    PERMIT2:          '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  };

  // PoolKey ของคู่ THBT/USDT (อิงจาก tx)
  const V4 = {
    poolKey: {
      currency0: viemLib.getAddress(ADDR.THBT),
      currency1: viemLib.getAddress(ADDR.USDT),
      fee: 0,                 // dynamic fee
      tickSpacing: 1,
      hooks: '0x37cfc3ec1297e71499e846eb38710aa1a7aa4a00'
    },
    COMMAND_V4_SWAP: 0x10,
    ACTION_SWAP_EXACT_IN_SINGLE: 6,
    ACTION_SETTLE_ALL: 12,
    ACTION_TAKE_ALL: 15
  };

  // ---------- ABIs ----------
  const ABI = {
    erc20: [
      { type:'function', name:'decimals', stateMutability:'view', inputs:[], outputs:[{type:'uint8'}]},
      { type:'function', name:'symbol',   stateMutability:'view', inputs:[], outputs:[{type:'string'}]},
      { type:'function', name:'balanceOf',stateMutability:'view', inputs:[{name:'a',type:'address'}], outputs:[{type:'uint256'}]},
      { type:'function', name:'approve',  stateMutability:'nonpayable', inputs:[{name:'s',type:'address'},{name:'a',type:'uint256'}], outputs:[{type:'bool'}] }
    ],
    permit2: [
      { type:'function', name:'approve', stateMutability:'nonpayable',
        inputs:[{name:'token',type:'address'},{name:'spender',type:'address'},{name:'amount',type:'uint160'},{name:'expiration',type:'uint48'}], outputs:[] }
    ],
    universalRouter: [
      { type:'function', name:'execute', stateMutability:'payable',
        inputs:[{name:'commands',type:'bytes'},{name:'inputs',type:'bytes[]'},{name:'deadline',type:'uint256'}], outputs:[] }
    ]
  };

  // ---------- state ----------
  let state = {
    from: { addr: ADDR.USDT, symbol: 'USDT', decimals: 6 },
    to:   { addr: ADDR.THBT, symbol: 'THBT', decimals: 18 },
    slip: 0.5
  };

  // ---------- viem clients ----------
  let publicClient = viemLib.createPublicClient({ chain: CHAIN, transport: viemLib.http() });
  let walletClient = null;
  let account = null;

  // ---------- balances ----------
  async function balanceOf(addr, who) {
    return publicClient.readContract({ address: viemLib.getAddress(addr), abi: ABI.erc20, functionName: 'balanceOf', args: [who] });
  }
  async function refreshBalances() {
    try {
      if (!account) return;
      const [fromBal, toBal] = await Promise.all([balanceOf(state.from.addr, account), balanceOf(state.to.addr, account)]);
      const fromFmt = viemLib.formatUnits(fromBal, state.from.decimals);
      const toFmt   = viemLib.formatUnits(toBal,   state.to.decimals);
      $('fromBalance').textContent = Number(fromFmt).toLocaleString(undefined,{maximumFractionDigits:6});
      $('toBalance').textContent   = Number(toFmt).toLocaleString(undefined,{maximumFractionDigits:6});
    } catch (e) { log('refreshBalances error', e); }
  }

  // ---------- quote (UI heuristic) ----------
  let quoteTimer = null;
  function lazyQuote(){ clearTimeout(quoteTimer); quoteTimer=setTimeout(quote, 200); }
  function quote(){
    const n = parseFloat(($('amountIn').value || '0'));
    if (!n || n<=0){ $('rateText').textContent='–'; $('amountOut').value=''; return; }
    const roughRate = (state.from.symbol==='USDT' && state.to.symbol==='THBT') ? 32.0
                     : (state.from.symbol==='THBT' && state.to.symbol==='USDT') ? (1/32.0) : 1;
    const out = n * roughRate;
    $('amountOut').value = out.toFixed(4);
    $('rateText').textContent = `~ 1 ${state.from.symbol} ≈ ${roughRate.toFixed(4)} ${state.to.symbol} (heuristic)`;
  }

  // ---------- Permit2 approvals ----------
  async function approvePermit2() {
    try {
      if (!account) await connect();

      // 1) USDT.approve(PERMIT2, Max)  ← ใช้ viemLib.maxUint256 (ตัว m เล็ก)
      const tx1 = await walletClient.writeContract({
        account,
        address: viemLib.getAddress(ADDR.USDT),
        abi: ABI.erc20, functionName: 'approve',
        args: [viemLib.getAddress(ADDR.PERMIT2), viemLib.maxUint256]
      });
      log('approve(USDT -> Permit2) tx:', tx1);
      await publicClient.waitForTransactionReceipt({ hash: tx1 }); log('approve #1 confirmed');

      // 2) Permit2.approve(token, spender=UniversalRouter, amount(uint160), expiration(uint48))
      //    expiration ใช้ now + 5 ปี (วินาที)
      const nowSec = BigInt(Math.floor(Date.now()/1000));
      const exp48  = nowSec + BigInt(60*60*24*365*5);
      const max160 = BigInt("0xffffffffffffffffffffffffffffffff"); // max uint160

      const tx2 = await walletClient.writeContract({
        account,
        address: viemLib.getAddress(ADDR.PERMIT2),
        abi: ABI.permit2, functionName: 'approve',
        args: [viemLib.getAddress(ADDR.USDT), viemLib.getAddress(ADDR.UNIVERSAL_ROUTER), max160, exp48]
      });
      log('Permit2.approve → Router tx:', tx2);
      await publicClient.waitForTransactionReceipt({ hash: tx2 }); log('approve #2 confirmed');
    } catch (e) {
      log('Permit2 error', { message: e?.message, shortMessage: e?.shortMessage, cause: e?.cause });
      alert(e?.shortMessage || e?.message || String(e));
    }
  }

  // ---------- encode params (UR v4) ----------
  function encodeExactInSingleParams({ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData }) {
    const poolKeyType = {
      type: 'tuple',
      components: [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee',       type: 'uint24'  },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks',     type: 'address' }
      ]
    };
    const exactInSingleType = {
      type: 'tuple',
      components: [
        poolKeyType,
        { name: 'zeroForOne', type: 'bool'    },
        { name: 'amountIn',   type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'hookData',   type: 'bytes'   }
      ]
    };
    return viemLib.encodeAbiParameters(
      [{ type: exactInSingleType.type, components: exactInSingleType.components }],
      [[poolKey, zeroForOne, amountIn, amountOutMinimum, hookData]]
    );
  }
  function encodeSettleAllParams(currency, amount) {
    return viemLib.encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currency, amount]
    );
  }
  function encodeTakeAllParams(currency, minAmount) {
    return viemLib.encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currency, minAmount]
    );
  }

  // ---------- swap (v4 Universal Router) ----------
  function parseUserAmountIn() {
    const v = parseFloat(($('amountIn').value || '0'));
    if (!v || v<=0) throw new Error('Invalid amount');
    return viemLib.parseUnits(v.toString(), state.from.decimals);
  }
  function minOutFromEst(estHumanStr) {
    const est = parseFloat(estHumanStr || '0'); const mul = (100 - Number(state.slip||0)) / 100;
    const min = Math.max(est * mul, 0);
    return viemLib.parseUnits(min.toString(), state.to.decimals);
  }
  async function swapV4() {
    try {
      if (!account) await connect();

      const amountIn = parseUserAmountIn();
      const estOutHuman = $('amountOut').value || '0';
      const minOut = minOutFromEst(estOutHuman);

      // poolKey: currency0=THBT, currency1=USDT → ถ้า from == currency0 → zeroForOne=true
      const zeroForOne = viemLib.isAddressEqual(state.from.addr, V4.poolKey.currency0);

      // actions & params
      const actionsBytes = Uint8Array.from([V4.ACTION_SWAP_EXACT_IN_SINGLE, V4.ACTION_SETTLE_ALL, V4.ACTION_TAKE_ALL]);
      const actionsEncoded = '0x' + Array.from(actionsBytes).map(b => b.toString(16).padStart(2,'0')).join('');

      const swapParams = encodeExactInSingleParams({
        poolKey: V4.poolKey,
        zeroForOne,
        amountIn: viemLib.toHex(amountIn, { size: 16 }),           // uint128
        amountOutMinimum: viemLib.toHex(minOut, { size: 16 }),     // uint128
        hookData: '0x'
      });

      const currencyIn  = zeroForOne ? V4.poolKey.currency0 : V4.poolKey.currency1;
      const currencyOut = zeroForOne ? V4.poolKey.currency1 : V4.poolKey.currency0;

      const settleParams = encodeSettleAllParams(currencyIn, amountIn);
      const takeParams   = encodeTakeAllParams(currencyOut, minOut);

      // inputs payload (ตาม Universal Router)
      const paramsArrayEncoded = viemLib.encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes[]' }],
        [actionsEncoded, [swapParams, settleParams, takeParams]]
      );
      const commandsHex = '0x10'; // COMMAND_V4_SWAP

      const tx = await walletClient.writeContract({
        account,
        address: viemLib.getAddress(ADDR.UNIVERSAL_ROUTER),
        abi: ABI.universalRouter,
        functionName: 'execute',
        args: [commandsHex, [paramsArrayEncoded], Math.floor(Date.now()/1000) + 60*10],
        value: 0n
      });
      log('UniversalRouter.execute sent:', tx);
      const rc = await publicClient.waitForTransactionReceipt({ hash: tx });
      log('Swap receipt:', rc);
      refreshBalances();
    } catch (e) {
      log('Swap error', { message: e?.message, shortMessage: e?.shortMessage, cause: e?.cause, meta: e?.metaMessages });
      alert(e?.shortMessage || e?.message || String(e));
    }
  }

  // ---------- connect (MetaMask only) ----------
  async function connect() {
    try {
      if (!window.ethereum) { alert('MetaMask not found. Please install it.'); return; }

      // 1) ขอสิทธิ์บัญชี
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) throw new Error('No account granted');
      account = viemLib.getAddress(accounts[0]);

      // 2) ตรวจ/สลับเชนเป็น Base
      const baseHex = '0x2105'; // 8453
      const current = await window.ethereum.request({ method: 'eth_chainId' });
      if (current !== baseHex) {
        try {
          await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: baseHex }] });
        } catch (e) {
          if (e.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: baseHex,
                chainName: 'Base Mainnet',
                rpcUrls: ['https://mainnet.base.org'],
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                blockExplorerUrls: ['https://basescan.org']
              }]
            });
          } else { throw e; }
        }
      }

      // 3) สร้าง walletClient พร้อม account (สำคัญ!)
      walletClient = viemLib.createWalletClient({
        chain: CHAIN,
        transport: viemLib.custom(window.ethereum),
        account
      });

      // UI
      $('connectBtn').textContent = account.slice(0,6) + '...' + account.slice(-4);
      $('permit2Btn').disabled = false;
      $('swapBtn').disabled = false;

      refreshBalances();

      // auto refresh on change
      window.ethereum.on?.('accountsChanged', () => window.location.reload());
      window.ethereum.on?.('chainChanged', () => window.location.reload());

      log('✅ Connected', account);
    } catch (err) {
      log('❌ Connect error:', { message: err?.message, shortMessage: err?.shortMessage, cause: err?.cause });
      alert(err?.message || String(err));
    }
  }

  // ---------- DOM wiring ----------
  window.addEventListener('DOMContentLoaded', () => {
    $('connectBtn')?.addEventListener('click', connect);
    $('permit2Btn')?.addEventListener('click', async () => { try { await approvePermit2(); } catch (e) { log('Permit2 error outer', e); }});
    $('swapBtn')?.addEventListener('click', async () => { try { await swapV4(); } catch (e) { log('Swap error outer', e); }});

    $('flipBtn')?.addEventListener('click', () => {
      [state.from, state.to] = [state.to, state.from];
      $('fromTokenBtn').textContent = state.from.symbol;
      $('toTokenBtn').textContent   = state.to.symbol;
      $('amountOut').value = '';
      refreshBalances(); lazyQuote();
    });

    document.querySelectorAll('.slip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); state.slip = parseFloat(btn.dataset.slip); lazyQuote();
      });
    });
    $('slippageCustom')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value || 'NaN');
      if (!Number.isNaN(v)) { state.slip = v; document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active')); lazyQuote(); }
    });
    $('amountIn')?.addEventListener('input', () => lazyQuote());

    // initial paint
    $('fromTokenBtn').textContent = state.from.symbol;
    $('toTokenBtn').textContent   = state.to.symbol;

    log('Ready • Base(8453) • UR(v4)=', ADDR.UNIVERSAL_ROUTER);
    log('PoolManager=', ADDR.POOL_MANAGER, ' Permit2=', ADDR.PERMIT2);
    log('PoolKey (THBT⇄USDT):', V4.poolKey);
  });
})();
