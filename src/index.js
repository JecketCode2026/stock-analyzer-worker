export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/analyze') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) {
        return new Response(JSON.stringify({ error: '请提供股票代码 (symbol)' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      return handleSSEAnalysis(symbol.trim());
    }

    return new Response(getHTMLPage(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

/**
 * 处理 SSE 实时推送与数据获取（使用腾讯财经数据源，兼容美股/港股/A股）
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

      await sendEvent('progress', { percent: 30, message: `[1/3] 连接数据节点，查询代码 [${rawSymbol.toUpperCase()}]...` });

      const apiUrl = `https://qt.gtimg.cn/q=${targetSymbol}`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Referer': 'https://finance.qq.com/'
        }
      });

      if (!res.ok) {
        throw new Error(`数据源响应异常 (HTTP ${res.status})`);
      }

      await sendEvent('progress', { percent: 70, message: `[2/3] 正在解析行情指标与计算状态...` });

      const text = await res.text();
      const parsedData = parseTencentStockData(rawSymbol, text);

      if (!parsedData) {
        throw new Error(`未找到股票代码 "${rawSymbol}" 的数据，请确认代码（如 NVDA, AAPL, 0700.HK, 600519）。`);
      }

      await sendEvent('progress', { percent: 90, message: `[3/3] 生成数据面板...` });
      await sendEvent('progress', { percent: 100, message: '数据采集与分析完成！' });

      await sendEvent('complete', parsedData);

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

/**
 * 将股票代码转换为腾讯接口格式
 */
function formatSymbolForTencent(symbol) {
  const s = symbol.toUpperCase().trim();
  if (s.endsWith('.HK')) {
    const code = s.replace('.HK', '').padStart(5, '0');
    return `hk${code}`;
  }
  if (s.endsWith('.SH') || (s.length === 6 && s.startsWith('6'))) {
    return `sh${s.replace('.SH', '')}`;
  }
  if (s.endsWith('.SZ') || (s.length === 6 && (s.startsWith('0') || s.startsWith('3')))) {
    return `sz${s.replace('.SZ', '')}`;
  }
  return `us${s.replace('US', '')}`;
}

/**
 * 解析行情数据
 */
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

  const marketCapRaw = parseFloat(parts[45]) || 0;
  const peRatio = parts[53] && parts[53] !== '' ? parseFloat(parts[53]).toFixed(2) : 'N/A';

  const formatCap = (val) => {
    if (!val) return 'N/A';
    if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}万亿`;
    if (val >= 1e8) return `$${(val / 1e8).toFixed(2)}亿`;
    if (val >= 1e4) return `$${(val / 1e4).toFixed(2)}万`;
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
    exchangeName: parts[2] || 'Global Market',
    currency: currencyStr,
    currentPrice: currentPrice.toFixed(2),
    priceChange: changePrice.toFixed(2),
    priceChangePercent: (changePercent / 100).toFixed(4),
    marketCap: formatCap(marketCapRaw),
    peRatio: peRatio !== 'NaN' ? peRatio : 'N/A',
    forwardPE: 'N/A',
    eps: 'N/A',
    beta: 'N/A',
    fiftyTwoWeekHigh: `${symbolPrefix}${high.toFixed(2)}`,
    fiftyTwoWeekLow: `${symbolPrefix}${low.toFixed(2)}`,
    dividendYield: 'N/A',
    recommendationKey: '行情中立',
    targetMeanPrice: 'N/A',
    longBusinessSummary: `【实时交易概况】\n- 开盘价：${symbolPrefix}${openPrice.toFixed(2)}\n- 最高价：${symbolPrefix}${high.toFixed(2)}\n- 最低价：${symbolPrefix}${low.toFixed(2)}\n- 昨收价：${symbolPrefix}${prevClose.toFixed(2)}\n- 成交量：${volume ? volume.toLocaleString() : 'N/A'} 股`
  };
}

/**
 * 前端 SPA 页面
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
  <div class="max-w-6xl mx-auto px-4 py-8">
    
    <header class="mb-8 text-center">
      <h1 class="text-3xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
        <i class="fa-solid me-2 fa-chart-line"></i>个股状态智能分析总览
      </h1>
      <p class="text-slate-400 text-sm mb-6">实时数据采集 · 支持美股、港股、A股</p>
      
      <form id="searchForm" class="flex justify-center max-w-md mx-auto gap-2">
        <input 
          type="text" 
          id="symbolInput" 
          placeholder="股票代码 (如 NVDA, AAPL, 0700.HK, 600519)" 
          class="flex-1 px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono uppercase"
          required
        />
        <button 
          type="submit" 
          id="submitBtn"
          class="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          <span>分析</span>
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
      </form>
    </header>

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
          <p id="stockIndustry" class="text-sm text-slate-400 mt-1">--</p>
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
          <div class="text-xs text-slate-400 mb-1">当日最高价</div>
          <div id="high52" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">当日最低价</div>
          <div id="low52" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
      </div>

      <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5">
        <h3 class="text-sm font-semibold text-slate-300 uppercase tracking-wider border-b border-slate-700 pb-2 mb-3">
          <i class="fa-solid fa-circle-info me-1.5"></i>交易详情数据
        </h3>
        <p id="businessSummary" class="text-slate-300 text-sm leading-relaxed whitespace-pre-line"></p>
      </div>
    </main>

  </div>

  <script>
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
      const symbol = symbolInput.value.trim().toUpperCase();
      if (!symbol) return;

      errorMessage.classList.add('hidden');
      dashboard.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-50');
      
      updateProgress(0, '建立连接中...');

      const eventSource = new EventSource('/api/analyze?symbol=' + encodeURIComponent(symbol));

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
        let errorText = '请求超时或错误，请稍后重试。';
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
      document.getElementById('stockName').textContent = data.longName;
      document.getElementById('stockSymbol').textContent = data.symbol;
      document.getElementById('stockExchange').textContent = data.exchangeName;
      document.getElementById('stockIndustry').textContent = \`计价货币: \${data.currency}\`;

      const priceEl = document.getElementById('stockPrice');
      const changeEl = document.getElementById('stockChange');
      const isPositive = data.priceChange >= 0;
      const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
      
      priceEl.textContent = \`\${data.currentPrice} \${data.currency}\`;
      changeEl.className = \`text-sm font-mono mt-0.5 \${colorClass}\`;
      changeEl.textContent = \`\${isPositive ? '+' : ''}\${Number(data.priceChange).toFixed(2)} (\${isPositive ? '+' : ''}\${(data.priceChangePercent * 100).toFixed(2)}%)\`;

      document.getElementById('mktCap').textContent = data.marketCap;
      document.getElementById('peRatio').textContent = data.peRatio;
      document.getElementById('high52').textContent = data.fiftyTwoWeekHigh;
      document.getElementById('low52').textContent = data.fiftyTwoWeekLow;

      document.getElementById('businessSummary').textContent = data.longBusinessSummary;
    }
  </script>
</body>
</html>`;
}