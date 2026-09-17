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
      return handleSSEAnalysis(symbol.toUpperCase().trim());
    }

    return new Response(getHTMLPage(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

/**
 * 处理 Server-Sent Events (SSE) 实时进度推送与 Yahoo Finance 数据获取
 */
function handleSSEAnalysis(symbol) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(payload));
  };

  (async () => {
    try {
      // 构造防拦截请求头
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`
      };

      // 阶段 1：连接 Yahoo Finance API
      await sendEvent('progress', { percent: 25, message: `[1/3] 正在建立连接，拉取 ${symbol} 行情数据...` });
      
      const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
      const quoteRes = await fetch(quoteUrl, { headers });

      if (!quoteRes.ok) {
        throw new Error(`Yahoo Finance 请求响应异常 (HTTP ${quoteRes.status})`);
      }

      const quoteJson = await quoteRes.json();
      const quoteData = quoteJson.quoteResponse?.result?.[0];

      if (!quoteData) {
        throw new Error(`未找到代码 ${symbol} 的数据，请检查代码是否输入正确（如 NVDA, AAPL, 0700.HK）。`);
      }

      // 阶段 2：获取公司详细与简介数据
      await sendEvent('progress', { percent: 60, message: `[2/3] 正在拉取 ${quoteData.shortName || symbol} 补充统计信息...` });
      
      let summaryProfile = {};
      try {
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
        const chartRes = await fetch(chartUrl, { headers });
        if (chartRes.ok) {
          const chartJson = await chartRes.json();
          summaryProfile = chartJson.chart?.result?.[0]?.meta || {};
        }
      } catch (e) {
        // 容错处理：即使补充数据拉取失败，也不中断主数据展示
      }

      // 阶段 3：格式化数据
      await sendEvent('progress', { percent: 90, message: `[3/3] 正在整合与计算股票指标...` });
      
      const summary = formatStockData(symbol, quoteData, summaryProfile);

      await sendEvent('progress', { percent: 100, message: '数据采集与分析完成！' });
      await sendEvent('complete', summary);

    } catch (err) {
      await sendEvent('error', { message: err.message || '数据拉取失败，请稍后重试。' });
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
 * 数据清洗与格式化
 */
function formatStockData(symbol, q, meta) {
  const fmtNum = (val, isCurrency = false, symbolStr = '$') => {
    if (val === undefined || val === null) return 'N/A';
    if (Math.abs(val) >= 1e12) return `${symbolStr}${(val / 1e12).toFixed(2)}T`;
    if (Math.abs(val) >= 1e9) return `${symbolStr}${(val / 1e9).toFixed(2)}B`;
    if (Math.abs(val) >= 1e6) return `${symbolStr}${(val / 1e6).toFixed(2)}M`;
    return isCurrency ? `${symbolStr}${val.toFixed(2)}` : val.toFixed(2);
  };

  const fmtPct = (val) => (val !== undefined && val !== null ? `${(val).toFixed(2)}%` : 'N/A');

  return {
    symbol: symbol,
    shortName: q.shortName || q.longName || symbol,
    longName: q.longName || q.shortName || symbol,
    exchangeName: q.fullExchangeName || q.exchange || 'N/A',
    currency: q.currency || meta.currency || 'USD',
    currentPrice: q.regularMarketPrice ?? meta.regularMarketPrice ?? 'N/A',
    priceChange: q.regularMarketChange ?? 0,
    priceChangePercent: q.regularMarketChangePercent ? (q.regularMarketChangePercent / 100) : 0,
    marketCap: fmtNum(q.marketCap, true, '$'),
    peRatio: fmtNum(q.trailingPE),
    forwardPE: fmtNum(q.forwardPE),
    eps: fmtNum(q.epsTrailingTwelveMonths),
    beta: fmtNum(q.beta),
    fiftyTwoWeekHigh: fmtNum(q.fiftyTwoWeekHigh, true, '$'),
    fiftyTwoWeekLow: fmtNum(q.fiftyTwoWeekLow, true, '$'),
    dividendYield: fmtPct(q.trailingAnnualDividendYield ? q.trailingAnnualDividendYield * 100 : undefined),
    
    // 财务健康
    totalRevenue: fmtNum(q.totalRevenue, true, '$'),
    grossMargins: 'N/A',
    profitMargins: 'N/A',
    returnOnEquity: 'N/A',
    
    // 评级与目标价
    targetMeanPrice: fmtNum(q.targetMeanPrice, true, '$'),
    recommendationKey: (q.averageAnalystRating || 'N/A').toUpperCase(),
    analystBuyCount: q.bookValue ? '参阅目标价' : 'N/A',
    analystHoldCount: '--',
    analystSellCount: '--',

    // 公司信息
    sector: q.sector || 'N/A',
    industry: q.industry || 'N/A',
    fullTimeEmployees: 'N/A',
    longBusinessSummary: `【实时行情概况】\n- 52周波动范围：$${q.fiftyTwoWeekLow ?? 'N/A'} - $${q.fiftyTwoWeekHigh ?? 'N/A'}\n- 盘中交易量：${q.regularMarketVolume ? q.regularMarketVolume.toLocaleString() : 'N/A'}\n- 均量 (10日)：${q.averageDailyVolume10Day ? q.averageDailyVolume10Day.toLocaleString() : 'N/A'}\n- 账面价值：${q.bookValue ? '$' + q.bookValue : 'N/A'}`
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
      <p class="text-slate-400 text-sm mb-6">基于 Yahoo Finance 数据源 · Cloudflare Worker 驱动</p>
      
      <form id="searchForm" class="flex justify-center max-w-md mx-auto gap-2">
        <input 
          type="text" 
          id="symbolInput" 
          placeholder="输入股票代码 (例: NVDA, AAPL, 0700.HK)" 
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
        <span id="progressStatus" class="text-blue-400">正在初始化数据请求...</span>
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
          <div class="text-xs text-slate-400 mb-1">市值 (Market Cap)</div>
          <div id="mktCap" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">市盈率 P/E (TTM)</div>
          <div id="peRatio" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">预测市盈率 (Forward P/E)</div>
          <div id="forwardPE" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">每股收益 EPS (TTM)</div>
          <div id="eps" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-blue-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-sliders me-1.5"></i>价格与波动
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">52 周最高价</span>
            <span id="high52" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">52 周最低价</span>
            <span id="low52" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">股息率</span>
            <span id="divYield" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">Beta (贝塔系数)</span>
            <span id="beta" class="font-mono text-slate-200">--</span>
          </div>
        </div>

        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-emerald-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-vault me-1.5"></i>机构共识与目标价
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">分析师综合评级</span>
            <span id="recKey" class="font-bold font-mono text-blue-400">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">机构平均目标价</span>
            <span id="targetPrice" class="font-mono text-slate-200">--</span>
          </div>
        </div>

        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-purple-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-circle-info me-1.5"></i>市场信息
          </h3>
          <p id="businessSummary" class="text-slate-300 text-xs leading-relaxed whitespace-pre-line"></p>
        </div>

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
      
      updateProgress(0, '正在连接服务器...');

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
        let errorText = '请求失败，请稍后重试。';
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
      document.getElementById('stockIndustry').textContent = \`货币: \${data.currency}\`;

      const priceEl = document.getElementById('stockPrice');
      const changeEl = document.getElementById('stockChange');
      const isPositive = data.priceChange >= 0;
      const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
      
      priceEl.textContent = \`\${data.currentPrice} \${data.currency}\`;
      changeEl.className = \`text-sm font-mono mt-0.5 \${colorClass}\`;
      changeEl.textContent = \`\${isPositive ? '+' : ''}\${Number(data.priceChange).toFixed(2)} (\${isPositive ? '+' : ''}\${(data.priceChangePercent * 100).toFixed(2)}%)\`;

      document.getElementById('mktCap').textContent = data.marketCap;
      document.getElementById('peRatio').textContent = data.peRatio;
      document.getElementById('forwardPE').textContent = data.forwardPE;
      document.getElementById('eps').textContent = data.eps;

      document.getElementById('high52').textContent = data.fiftyTwoWeekHigh;
      document.getElementById('low52').textContent = data.fiftyTwoWeekLow;
      document.getElementById('divYield').textContent = data.dividendYield;
      document.getElementById('beta').textContent = data.beta;

      document.getElementById('recKey').textContent = data.recommendationKey;
      document.getElementById('targetPrice').textContent = data.targetMeanPrice;

      document.getElementById('businessSummary').textContent = data.longBusinessSummary;
    }
  </script>
</body>
</html>`;
}