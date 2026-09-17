export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路由 1：处理登录
    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // 路由 2：个股分析 SSE 接口 (需要 Auth Token 验证)
    if (url.pathname === '/api/analyze') {
      const authHeader = request.headers.get('Authorization') || url.searchParams.get('token');
      if (!authHeader || authHeader !== 'Bearer worker-auth-valid-token') {
        return new Response(JSON.stringify({ error: '未经授权，请先登录' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const symbol = url.searchParams.get('symbol');
      if (!symbol) {
        return new Response(JSON.stringify({ error: '请提供股票代码 (symbol)' }), { status: 400 });
      }
      return handleSSEAnalysis(symbol.trim());
    }

    // 路由 3：提供前端 UI 页面
    return new Response(getHTMLPage(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

/**
 * 处理用户登录验证
 */
async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();

    // 账号密码校验 (可在 Cloudflare 环境变量中配置 ADMIN_USER / ADMIN_PASS，默认: admin / admin123)
    const validUser = env.ADMIN_USER || 'admin';
    const validPass = env.ADMIN_PASS || 'admin123';

    if (username === validUser && password === validPass) {
      return new Response(JSON.stringify({
        success: true,
        token: 'worker-auth-valid-token',
        user: username
      }), { headers: { 'Content-Type': 'application/json' } });
    } else {
      return new Response(JSON.stringify({ error: '用户名或密码错误' }), { status: 401 });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: '登录处理异常：' + err.message }), { status: 500 });
  }
}

/**
 * SSE 实时数据推送与技术指标计算
 */
function handleSSEAnalysis(rawSymbol) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(payload));
  };

  (async () => {
    try {
      const targetSymbol = formatSymbolForTencent(rawSymbol);

      // 阶段 1：获取实时行情数据并进行 GBK 解码
      await sendEvent('progress', { percent: 25, message: `[1/3] 正在拉取 ${rawSymbol.toUpperCase()} 行情数据...` });
      
      const res = await fetch(`https://qt.gtimg.cn/q=${targetSymbol}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.qq.com/'
        }
      });

      if (!res.ok) throw new Error(`数据源连接失败 (HTTP ${res.status})`);

      const buffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      const baseData = parseTencentStockData(rawSymbol, text);

      if (!baseData) throw new Error(`无法找到代码 "${rawSymbol}" 的有效股票信息。`);

      // 阶段 2：计算 MA5/10/20 及 RSI 指标
      await sendEvent('progress', { percent: 65, message: `[2/3] 计算均线 (MA5/10/20) 与 RSI 技术指标...` });
      
      const klineRes = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${targetSymbol},day,,,30,qfq`);
      let technicals = { ma5: 'N/A', ma10: 'N/A', ma20: 'N/A', rsi14: 'N/A', trend: '震荡整理', sector: '通用板块' };

      if (klineRes.ok) {
        const klineJson = await klineRes.json();
        const stockKey = Object.keys(klineJson.data || {})[0];
        const kdata = klineJson.data?.[stockKey]?.day || klineJson.data?.[stockKey]?.qfqday;
        if (kdata && kdata.length > 0) {
          technicals = calculateTechnicalIndicators(kdata);
        }
      }

      // 阶段 3：整合数据并输出
      await sendEvent('progress', { percent: 95, message: `[3/3] 生成分析仪表盘...` });
      
      const finalResult = { ...baseData, ...technicals };

      await sendEvent('progress', { percent: 100, message: '分析完成！' });
      await sendEvent('complete', finalResult);

    } catch (err) {
      await sendEvent('error', { message: err.message || '获取股票数据失败。' });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function formatSymbolForTencent(symbol) {
  const s = symbol.toUpperCase().trim();
  if (s.endsWith('.HK')) return `hk${s.replace('.HK', '').padStart(5, '0')}`;
  if (s.endsWith('.SH') || (s.length === 6 && s.startsWith('6'))) return `sh${s.replace('.SH', '')}`;
  if (s.endsWith('.SZ') || (s.length === 6 && (s.startsWith('0') || s.startsWith('3')))) return `sz${s.replace('.SZ', '')}`;
  return `us${s.replace('US', '')}`;
}

function parseTencentStockData(rawSymbol, text) {
  const match = text.match(/="([^"]+)"/);
  if (!match || !match[1]) return null;

  const parts = match[1].split('~');
  if (parts.length < 30) return null;

  const name = parts[1] || rawSymbol;
  const currentPrice = parseFloat(parts[3]) || 0;
  const prevClose = parseFloat(parts[4]) || 0;
  const openPrice = parseFloat(parts[5]) || 0;
  const volume = parseFloat(parts[6]) || 0;
  const high = parseFloat(parts[33] || parts[29]) || 0;
  const low = parseFloat(parts[34] || parts[30]) || 0;
  const changePrice = parseFloat(parts[31]) || (currentPrice - prevClose);
  const changePercent = parseFloat(parts[32]) || (prevClose ? (changePrice / prevClose) * 100 : 0);

  const turnoverRate = parts[38] ? `${parts[38]}%` : 'N/A';
  const pbRatio = parts[39] ? parts[39] : 'N/A';
  const amplitude = parts[43] ? `${parts[43]}%` : 'N/A';
  const marketCapRaw = parseFloat(parts[45]) || 0;
  const peRatio = parts[53] && parts[53] !== '' ? parseFloat(parts[53]).toFixed(2) : 'N/A';

  const formatCap = (val) => {
    if (!val) return 'N/A';
    if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}万亿`;
    if (val >= 1e8) return `$${(val / 1e8).toFixed(2)}亿`;
    return `$${val.toFixed(2)}`;
  };

  const isHK = rawSymbol.toUpperCase().includes('.HK');
  const isA = rawSymbol.length === 6 && !isNaN(rawSymbol);
  const currencyStr = isHK ? 'HKD' : (isA ? 'CNY' : 'USD');
  const symbolPrefix = isHK ? 'HK$' : (isA ? '¥' : '$');

  return {
    symbol: rawSymbol.toUpperCase(),
    shortName: name,
    longName: name,
    exchangeName: parts[2] || '主板',
    currency: currencyStr,
    currentPrice: currentPrice.toFixed(2),
    priceChange: changePrice.toFixed(2),
    priceChangePercent: (changePercent / 100).toFixed(4),
    marketCap: formatCap(marketCapRaw),
    peRatio: peRatio !== 'NaN' ? peRatio : 'N/A',
    pbRatio,
    turnoverRate,
    amplitude,
    fiftyTwoWeekHigh: `${symbolPrefix}${high.toFixed(2)}`,
    fiftyTwoWeekLow: `${symbolPrefix}${low.toFixed(2)}`,
    openPrice: `${symbolPrefix}${openPrice.toFixed(2)}`,
    prevClose: `${symbolPrefix}${prevClose.toFixed(2)}`,
    volume: volume ? volume.toLocaleString() : 'N/A'
  };
}

function calculateTechnicalIndicators(kdata) {
  const closes = kdata.map(item => parseFloat(item[2]));
  const len = closes.length;
  if (len === 0) return { ma5: 'N/A', ma10: 'N/A', ma20: 'N/A', rsi14: 'N/A', trend: '数据不足' };

  const getMA = (period) => {
    if (len < period) return 'N/A';
    const slice = closes.slice(len - period);
    const sum = slice.reduce((a, b) => a + b, 0);
    return (sum / period).toFixed(2);
  };

  const ma5 = getMA(5);
  const ma10 = getMA(10);
  const ma20 = getMA(20);
  const current = closes[len - 1];

  let rsi14 = 'N/A';
  if (len >= 15) {
    let gains = 0, losses = 0;
    for (let i = len - 14; i < len; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) rsi14 = '100.00';
    else {
      const rs = avgGain / avgLoss;
      rsi14 = (100 - (100 / (1 + rs))).toFixed(2);
    }
  }

  let trend = '震荡整理';
  if (ma5 !== 'N/A' && ma20 !== 'N/A') {
    if (current > parseFloat(ma5) && parseFloat(ma5) > parseFloat(ma20)) trend = '多头排列 (看涨)';
    else if (current < parseFloat(ma5) && parseFloat(ma5) < parseFloat(ma20)) trend = '空头排列 (看跌)';
  }

  return { ma5, ma10, ma20, rsi14, trend, sector: '资本市场与核心板块' };
}

/**
 * 前端界面 UI
 */
function getHTMLPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>个股智能分析看板</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">

  <!-- 登录模态框 -->
  <div id="loginModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
    <div class="bg-slate-800 border border-slate-700 p-8 rounded-2xl w-full max-w-md shadow-2xl space-y-6">
      <div class="text-center">
        <h2 class="text-2xl font-bold text-white mb-1"><i class="fa-solid fa-lock text-blue-400 me-2"></i>系统登录</h2>
        <p class="text-slate-400 text-sm">请输入账号凭证以访问分析服务</p>
      </div>

      <form id="loginForm" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1">用户名</label>
          <input type="text" id="username" value="admin" class="w-full px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500" required>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1">密码</label>
          <input type="password" id="password" value="admin123" class="w-full px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500" required>
        </div>

        <div id="loginError" class="hidden text-red-400 text-xs text-center"></div>

        <button type="submit" id="loginBtn" class="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors">
          登录
        </button>
      </form>
    </div>
  </div>

  <div class="max-w-6xl mx-auto px-4 py-8">
    
    <header class="mb-8 flex justify-between items-center border-b border-slate-800 pb-4">
      <div>
        <h1 class="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
          <i class="fa-solid me-2 fa-chart-line"></i>个股状态智能分析总览
        </h1>
        <p class="text-slate-400 text-xs mt-1">实时数据采集 · 修复GBK编码 · 集成技术指标分析</p>
      </div>
      <div id="userInfo" class="hidden flex items-center gap-3">
        <span class="text-xs text-slate-400"><i class="fa-solid fa-user me-1"></i><span id="userName">admin</span></span>
        <button id="logoutBtn" class="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded border border-slate-700 text-slate-300">退出</button>
      </div>
    </header>

    <section class="max-w-md mx-auto mb-8">
      <form id="searchForm" class="flex gap-2">
        <input 
          type="text" 
          id="symbolInput" 
          placeholder="股票代码 (如 601398, NVDA, 0700.HK)" 
          class="flex-1 px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono uppercase"
          required
        />
        <button type="submit" id="submitBtn" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors flex items-center gap-2">
          <span>分析</span>
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
      </form>
    </section>

    <div id="progressContainer" class="hidden max-w-2xl mx-auto mb-10 bg-slate-800/80 border border-slate-700/60 p-6 rounded-xl shadow-xl backdrop-blur">
      <div class="flex justify-between text-sm font-medium mb-2">
        <span id="progressStatus" class="text-blue-400">正在建立连接...</span>
        <span id="progressPercent" class="text-slate-300 font-mono">0%</span>
      </div>
      <div class="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
        <div id="progressBar" class="bg-gradient-to-r from-blue-500 to-emerald-400 h-3 rounded-full transition-all duration-300 ease-out" style="width: 0%"></div>
      </div>
    </div>

    <div id="errorMessage" class="hidden max-w-2xl mx-auto mb-8 bg-red-900/40 border border-red-500/50 text-red-200 p-4 rounded-xl text-center text-sm"></div>

    <main id="dashboard" class="hidden space-y-6">
      <div class="bg-slate-800 border border-slate-700/60 rounded-xl p-6 flex flex-col md:flex-row justify-between md:items-center gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h2 id="stockName" class="text-2xl font-bold text-white">--</h2>
            <span id="stockSymbol" class="px-2.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono text-sm">--</span>
            <span id="stockExchange" class="text-xs text-slate-400">--</span>
          </div>
          <p id="stockIndustry" class="text-sm text-slate-400 mt-1">行业板块: <span id="sectorName" class="text-slate-200">--</span></p>
        </div>
        <div class="text-left md:text-right">
          <div id="stockPrice" class="text-3xl font-bold font-mono">--</div>
          <div id="stockChange" class="text-sm font-mono mt-0.5">--</div>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">总市值</div>
          <div id="mktCap" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">市盈率 P/E</div>
          <div id="peRatio" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">市净率 P/B</div>
          <div id="pbRatio" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">换手率</div>
          <div id="turnoverRate" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-blue-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-chart-simple me-1.5"></i>技术指标与均线系统
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">均线形态 (Trend)</span>
            <span id="trendStatus" class="font-bold text-emerald-400">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">5日均线 (MA5)</span>
            <span id="ma5" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">10日均线 (MA10)</span>
            <span id="ma10" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">20日均线 (MA20)</span>
            <span id="ma20" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">相对强弱指标 (RSI 14)</span>
            <span id="rsi14" class="font-mono text-purple-400">--</span>
          </div>
        </div>

        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-emerald-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-arrows-up-down me-1.5"></i>价格范围与振幅
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">今开 / 昨收</span>
            <span id="openPrev" class="font-mono text-slate-200">-- / --</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">最高 / 最低</span>
            <span id="highLow" class="font-mono text-slate-200">-- / --</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">日振幅 (Amplitude)</span>
            <span id="amplitude" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">成交量</span>
            <span id="volume" class="font-mono text-slate-200">--</span>
          </div>
        </div>
      </div>
    </main>

  </div>

  <script>
    let authToken = localStorage.getItem('auth_token');
    const loginModal = document.getElementById('loginModal');
    const loginForm = document.getElementById('loginForm');
    const userInfo = document.getElementById('userInfo');
    const userName = document.getElementById('userName');
    const logoutBtn = document.getElementById('logoutBtn');

    if (authToken) {
      loginModal.classList.add('hidden');
      userInfo.classList.remove('hidden');
      userName.textContent = localStorage.getItem('auth_user') || 'Admin';
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loginError = document.getElementById('loginError');
      loginError.classList.add('hidden');

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          authToken = data.token;
          localStorage.setItem('auth_token', data.token);
          localStorage.setItem('auth_user', data.user);
          loginModal.classList.add('hidden');
          userInfo.classList.remove('hidden');
          userName.textContent = data.user;
        } else {
          loginError.textContent = data.error || '登录校验失败';
          loginError.classList.remove('hidden');
        }
      } catch (err) {
        loginError.textContent = '登录请求异常';
        loginError.classList.remove('hidden');
      }
    });

    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      location.reload();
    });

    const searchForm = document.getElementById('searchForm');
    const symbolInput = document.getElementById('symbolInput');
    const submitBtn = document.getElementById('submitBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');
    const progressPercent = document.getElementById('progressPercent');
    const errorMessage = document.getElementById('errorMessage');
    const dashboard = document.getElementById('dashboard');

    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!authToken) {
        loginModal.classList.remove('hidden');
        return;
      }

      const symbol = symbolInput.value.trim().toUpperCase();
      if (!symbol) return;

      errorMessage.classList.add('hidden');
      dashboard.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-50');
      
      updateProgress(0, '建立连接...');

      const eventSource = new EventSource(\`/api/analyze?symbol=\${encodeURIComponent(symbol)}&token=\${encodeURIComponent(authToken)}\`);

      eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        updateProgress(data.percent, data.message);
      });

      eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        eventSource.close();
        setTimeout(() => {
          progressContainer.classList.add('hidden');
          renderDashboard(data);
          dashboard.classList.remove('hidden');
          submitBtn.disabled = false;
          submitBtn.classList.remove('opacity-50');
        }, 300);
      });

      eventSource.addEventListener('error', (e) => {
        let errorText = '数据获取失败，可能未登录或连接中断。';
        try {
          if (e.data) {
            const data = JSON.parse(e.data);
            errorText = data.message || errorText;
          }
        } catch (_) {}
        
        eventSource.close();
        progressContainer.classList.add('hidden');
        showError(errorText);
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-50');
      });
    });

    function updateProgress(percent, message) {
      progressBar.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      progressStatus.textContent = message;
    }

    function showError(msg) {
      errorMessage.textContent = msg;
      errorMessage.classList.remove('hidden');
    }

    function renderDashboard(data) {
      document.getElementById('stockName').textContent = data.shortName;
      document.getElementById('stockSymbol').textContent = data.symbol;
      document.getElementById('stockExchange').textContent = data.exchangeName;
      document.getElementById('sectorName').textContent = data.sector;

      const priceEl = document.getElementById('stockPrice');
      const changeEl = document.getElementById('stockChange');
      const isPositive = parseFloat(data.priceChange) >= 0;
      const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
      
      priceEl.textContent = \`\${data.currentPrice} \${data.currency}\`;
      changeEl.className = \`text-sm font-mono mt-0.5 \${colorClass}\`;
      changeEl.textContent = \`\${isPositive ? '+' : ''}\${Number(data.priceChange).toFixed(2)} (\${isPositive ? '+' : ''}\${(parseFloat(data.priceChangePercent) * 100).toFixed(2)}%)\`;

      document.getElementById('mktCap').textContent = data.marketCap;
      document.getElementById('peRatio').textContent = data.peRatio;
      document.getElementById('pbRatio').textContent = data.pbRatio;
      document.getElementById('turnoverRate').textContent = data.turnoverRate;

      document.getElementById('trendStatus').textContent = data.trend;
      document.getElementById('ma5').textContent = data.ma5;
      document.getElementById('ma10').textContent = data.ma10;
      document.getElementById('ma20').textContent = data.ma20;
      document.getElementById('rsi14').textContent = data.rsi14;

      document.getElementById('openPrev').textContent = \`\${data.openPrice} / \${data.prevClose}\`;
      document.getElementById('highLow').textContent = \`\${data.fiftyTwoWeekHigh} / \${data.fiftyTwoWeekLow}\`;
      document.getElementById('amplitude').textContent = data.amplitude;
      document.getElementById('volume').textContent = \`\${data.volume} 股\`;
    }
  </script>
</body>
</html>`;
}
