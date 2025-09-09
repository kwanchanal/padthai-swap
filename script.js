/* global viem, window, document */
(() => {
  // ===== utils / logger =====
  const log = (...args) => {
    const box = document.getElementById('logBox');
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
    box.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + box.textContent;
    console.log(...args);
  };
  document.getElementById('clearLog').onclick = () => (document.getElementById('logBox').textContent = '');

  // ===== chain & addresses =====
  const CHAIN = {
    id: 8453, name: 'Base',
    rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
  };

  // Tokens (from BaseScan)
  const ADDR = {
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // Bridged USDT (6)
    THBT: '0xdC200537D99d8b4f0C89D59A68e29b67057d2c5F', // THBT (18)
    // v4 infra
    UNIVERSAL_ROUTER: '0x6fF5693b99212Da76ad316178A184AB56D299b43', // Uniswap V4: Universal Router (Base)
    POOL_MANAGER:     '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap V4: PoolManager (Base)
    PERMIT2:          '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  };

  // PoolKey (USDT <-> THBT) extracted from your successful tx (Base)
  // PoolKey = (currency0, currency1, fee, tickSpacing, hooks)
  // currency0 must be lower-address; from tx it was (THBT, USDT), fee=0 (dynamic), tickSpacing=1, hooks=0x37cfc3ec...
  const V4 = {
    poolKey: {
      currency0: viem.getAddress(ADDR.THBT),
      currency1: viem.getAddress(ADDR.USDT),
      fee: 0, // dynamic fee
      tickSpacing: 1,
      hooks: '0x37cfc3ec1297e71499e846eb38710aa1a7aa4a00'
    },
    // Universal Router commands/actions (from Uniswap docs)
    COMMAND_V4_SWAP: 0x10,                   // Commands.V4_SWAP
    ACTION_SWAP_EXACT_IN_SINGLE: 6,          // Actions.SWAP_EXACT_IN_SINGLE
    ACTION_SETTLE_ALL: 12,                   // Actions.SETTLE_ALL
    ACTION_TAKE_ALL: 15                      // Actions.TAKE_ALL
  };

  // ABIs
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

  // ===== state =====
  let state = {
    from: { addr: ADDR.USDT, symbol: 'USDT', decimals: 6 },
    to:   { addr: ADDR.THBT, symbol: 'THBT', decimals: 18 },
    slip: 0.5
  };

  // ===== viem clients =====
  let publicClient = viem.createPublicClient({ chain: CHAIN, transport: viem.http() });
  let walletClient = null;
  let account = null;

  // ===== connect (MetaMask only) =====
  const connectBtn = document.getElementById('connectBtn');
  async function connect() {
    try {
      if (!window.ethereum) throw new Error('Please install MetaMask');
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: viem.numberToHex(CHAIN.id) }] }).catch(async (e) => {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: viem.numberToHex(CHAIN.id), chainName: CHAIN.name, rpcUrls: CHAIN.rpcUrls.default.http, nativeCurrency: CHAIN.nativeCurrency }]
          });
        } else throw e;
      });
      walletClient = viem.createWalletClient({ chain: CHAIN, transport: viem.custom(window.ethereum) });
      [account] = await walletClient.getAddresses();
      connectBtn.textContent = account.slice(0,6) + '...' + account.slice(-4);
      log('Connected', account);
      refreshBalances();
    } catch (err) {
      log('Connect error:', err); alert(err.message || String(err));
    }
  }
  connectBtn.onclick = connect;

  // ===== UI =====
  document.getElementById('flipBtn').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    document.getElementById('fromTokenBtn').textContent = state.from.symbol;
    document.getElementById('toTokenBtn').textContent = state.to.symbol;
    document.getElementById('amountOut').value = '';
    refreshBalances(); lazyQuote();
  };
  Array.from(document.querySelectorAll('.slip-btn')).forEach(btn => {
    btn.onclick = () => {
      Array.from(document.querySelectorAll('.slip-btn')).forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); state.slip = parseFloat(btn.dataset.slip); lazyQuote();
    };
  });
  document.getElementById('slippageCustom').oninput = (e) => {
    const v = parseFloat(e.target.value || 'NaN'); if (!Number.isNaN(v)) { state.slip = v; Array.from(document.querySelectorAll('.slip-btn')).forEach(b => b.classList.remove('active')); lazyQuote(); }
  };
  document.getElementById('amountIn').oninput = () => lazyQuote();

  // ===== balances =====
  async function balanceOf(addr, who) {
    return publicClient.readContract({ address: viem.getAddress(addr), abi: ABI.erc20, functionName: 'balanceOf', args: [who] });
  }
  async function refreshBalances() {
    try {
      if (!account) return;
      const [fromBal, toBal] = await Promise.all([balanceOf(state.from.addr, account), balanceOf(state.to.addr, account)]);
      const fromFmt = viem.formatUnits(fromBal, state.from.decimals);
      const toFmt   = viem.formatUnits(toBal,   state.to.decimals);
      document.getElementById('fromBalance').textContent = Number(fromFmt).toLocaleString(undefined,{maximumFractionDigits:6});
      document.getElementById('toBalance').textContent   = Number(toFmt).toLocaleString(undefined,{maximumFractionDigits:6});
    } catch (e) { log('refreshBalances error', e); }
  }

  // ===== simple heuristic quote (UI only) =====
  let quoteTimer = null;
  function lazyQuote(){ clearTimeout(quoteTimer); quoteTimer=setTimeout(quote, 200); }
  function quote(){
    const n = parseFloat(document.getElementById('amountIn').value || '0');
    if (!n || n<=0){ document.getElementById('rateText').textContent='–'; document.getElementById('amountOut').value=''; return; }
    const roughRate = (state.from.symbol==='USDT' && state.to.symbol==='THBT') ? 32.0
                     : (state.from.symbol==='THBT' && state.to.symbol==='USDT') ? (1/32.0) : 1;
    const out = n * roughRate;
    document.getElementById('amountOut').value = out.toFixed(4);
    document.getElementById('rateText').textContent = `~ 1 ${state.from.symbol} ≈ ${roughRate.toFixed(4)} ${state.to.symbol} (heuristic)`;
  }

  // ===== Permit2 approval flow (2 txs one-time) =====
  document.getElementById('permit2Btn').onclick = async () => {
    try {
      if (!account) await connect();
      // Step 1: token.approve(PERMIT2, Max)
      const approve1 = await walletClient.writeContract({
        address: viem.getAddress(ADDR.USDT),
        abi: ABI.erc20, functionName: 'approve',
        args: [viem.getAddress(ADDR.PERMIT2), viem.MaxUint256]
      });
      log('approve(USDT -> Permit2) tx:', approve1);
      await publicClient.waitForTransactionReceipt({ hash: approve1 }); log('approve #1 confirmed');

      // Step 2: Permit2.approve(token, spender=UniversalRouter, amount, expiration)
      const amount160 = BigInt('0xffffffffffffffffffffffffffffffff'); // ~max uint160
      const exp48 = BigInt(60*60*24*365*5); // ~5y
      const approve2 = await walletClient.writeContract({
        address: viem.getAddress(ADDR.PERMIT2),
        abi: ABI.permit2, functionName: 'approve',
        args: [viem.getAddress(ADDR.USDT), viem.getAddress(ADDR.UNIVERSAL_ROUTER), amount160, exp48]
      });
      log('Permit2.approve → Router tx:', approve2);
      await publicClient.waitForTransactionReceipt({ hash: approve2 }); log('approve #2 confirmed');

    } catch (e) { log('Permit2 approve error', e); alert(e.message || String(e)); }
  };

  // ===== swap via Universal Router (V4) =====
  function parseUserAmountIn() {
    const v = parseFloat(document.getElementById('amountIn').value || '0');
    if (!v || v<=0) throw new Error('Invalid amount');
    return viem.parseUnits(v.toString(), state.from.decimals);
  }
  function minOutFromEst(estHumanStr) {
    const est = parseFloat(estHumanStr || '0'); const mul = (100 - Number(state.slip||0)) / 100;
    const min = Math.max(est * mul, 0);
    return viem.parseUnits(min.toString(), state.to.decimals);
  }

  function encodeExactInSingleParams({ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData }) {
    // types for viem.encodeAbiParameters
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
    return viem.encodeAbiParameters(
      [{ type: exactInSingleType.type, components: exactInSingleType.components }],
      [[poolKey, zeroForOne, amountIn, amountOutMinimum, hookData]]
    );
  }
  function encodeSettleAllParams(currency, amount) {
    return viem.encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currency, amount]
    );
  }
  function encodeTakeAllParams(currency, minAmount) {
    return viem.encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currency, minAmount]
    );
  }

  async function swapV4() {
    if (!account) await connect();

    // input & minOut
    const amountIn = parseUserAmountIn();
    const estOutHuman = document.getElementById('amountOut').value || '0';
    const minOut = minOutFromEst(estOutHuman);

    // Determine zeroForOne relative to PoolKey (currency0=THBT, currency1=USDT)
    // If from == currency0 (THBT) → zeroForOne=true (0->1); If from == currency1 (USDT) → zeroForOne=false (1->0)
    const zeroForOne = (viem.isAddressEqual(state.from.addr, V4.poolKey.currency0)) ? true : false;

    // Build actions: [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
    const actionsBytes = Uint8Array.from([V4.ACTION_SWAP_EXACT_IN_SINGLE, V4.ACTION_SETTLE_ALL, V4.ACTION_TAKE_ALL]);
    const actionsEncoded = '0x' + Array.from(actionsBytes).map(b => b.toString(16).padStart(2,'0')).join('');

    // params[0] for swap
    const swapParams = encodeExactInSingleParams({
      poolKey: V4.poolKey,
      zeroForOne,
      amountIn: viem.toHex(amountIn, { size: 16 }),             // uint128
      amountOutMinimum: viem.toHex(minOut, { size: 16 }),       // uint128
      hookData: '0x'
    });

    // params[1] settle in (pay from user → router → pool)
    const currencyIn  = zeroForOne ? V4.poolKey.currency0 : V4.poolKey.currency1;
    const currencyOut = zeroForOne ? V4.poolKey.currency1 : V4.poolKey.currency0;

    const settleParams = encodeSettleAllParams(currencyIn, amountIn);
    const takeParams   = encodeTakeAllParams(currencyOut, minOut);

    // inputs = [ abi.encode(actions, params) ]
    const paramsArrayEncoded = viem.encodeAbiParameters(
      [
        { type: 'bytes' },
        { type: 'bytes[]' }
      ],
      [actionsEncoded, [swapParams, settleParams, takeParams]]
    );
    const commandsBytes = Uint8Array.from([V4.COMMAND_V4_SWAP]);
    const commandsHex = '0x' + Array.from(commandsBytes).map(b=>b.toString(16).padStart(2,'0')).join('');

    // final call
    const tx = await walletClient.writeContract({
      address: viem.getAddress(ADDR.UNIVERSAL_ROUTER),
      abi: ABI.universalRouter,
      functionName: 'execute',
      args: [commandsHex, [paramsArrayEncoded], Math.floor(Date.now()/1000) + 60*10],
      value: 0n
    });
    log('UniversalRouter.execute sent:', tx);
    const rc = await publicClient.waitForTransactionReceipt({ hash: tx });
    log('Swap receipt:', rc);
    refreshBalances();
  }

  // ===== buttons =====
  document.getElementById('swapBtn').onclick = async () => {
    try { await swapV4(); }
    catch (e) {
      log('Swap error', e);
      alert(e.shortMessage || e.message || String(e));
    }
  };

  // ===== onload =====
  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', () => window.location.reload());
    window.ethereum.on?.('chainChanged', () => window.location.reload());
  }
  document.getElementById('fromTokenBtn').textContent = state.from.symbol;
  document.getElementById('toTokenBtn').textContent   = state.to.symbol;
  log('Ready • Base(8453) • Universal Router(v4)=', ADDR.UNIVERSAL_ROUTER);
  log('PoolManager(Base)=', ADDR.POOL_MANAGER, ' Permit2=', ADDR.PERMIT2);
  log('PoolKey (USDT⇄THBT) from your tx:', V4.poolKey);
})();
