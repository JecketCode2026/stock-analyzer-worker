export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路由 1：提供分析流 (SSE 接口)
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

    // 路由 2：渲染前端主页
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

  // 异步执行数据采集流程，不阻塞响应返回
  (async () => {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // 阶段 1：获取公司概况与分类
      await sendEvent('progress', { percent: 20, message: `[1/4] 正在连接 Yahoo Finance，获取 ${symbol} 基本概况...` });
      const profileRes = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,price`,
        { headers }
      );
      if (!profileRes.ok) throw new Error(`无法获取股票信息，请检查代码 ${symbol} 是否正确。`);
      const profileData = await profileRes.json();
      const profileResult = profileData.quoteSummary?.result?.[0];
      if (!profileResult) throw new Error(`未找到股票代码 ${symbol} 的数据。`);

      // 阶段 2：获取行情与交易细节
      await sendEvent('progress', { percent: 45, message: `[2/4] 正在拉取实时行情与统计指标...` });
      const detailRes = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics`,
        { headers }
      );
      const detailData = await detailRes.json();
      const detailResult = detailData.quoteSummary?.result?.[0] || {};

      // 阶段 3：获取财务健康数据
      await sendEvent('progress', { percent: 70, message: `[3/4] 正在分析财务报表与盈利能力...` });
      const finRes = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData`,
        { headers }
      );
      const finData = await finRes.json();
      const finResult = finData.quoteSummary?.result?.[0] || {};

      // 阶段 4：获取机构评级与汇总
      await sendEvent('progress', { percent: 90, message: `[4/4] 正在生成机构目标价与综合报告...` });
      const recRes = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=recommendationTrend`,
        { headers }
      );
      const recData = await recRes.json();
      const recResult = recData.quoteSummary?.result?.[0] || {};

      // 数据清洗与组合
      const summary = formatStockData(symbol, profileResult, detailResult, finResult, recResult);

      // 完成推送
      await sendEvent('progress', { percent: 100, message: '数据采集与分析完成！' });
      await sendEvent('complete', summary);

    } catch (err) {
      await sendEvent('error', { message: err.message || '分析过程中发生未知错误。' });
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
 * 数据清洗与格式化工具函数
 */
function formatStockData(symbol, profileObj, detailObj, finObj, recObj) {
  const price = profileObj.price || {};
  const profile = profileObj.assetProfile || {};
  const detail = detailObj.summaryDetail || {};
  const stats = detailObj.defaultKeyStatistics || {};
  const fin = finObj.financialData || {};
  const rec = recObj.recommendationTrend?.trend?.[0] || {};

  const fmtNum = (val, isCurrency = false, symbolStr = '$') => {
    if (!val || val.raw === undefined) return 'N/A';
    const num = val.raw;
    if (Math.abs(num) >= 1e12) return `${symbolStr}${(num / 1e12).toFixed(2)}T`;
    if (Math.abs(num) >= 1e9) return `${symbolStr}${(num / 1e9).toFixed(2)}B`;
    if (Math.abs(num) >= 1e6) return `${symbolStr}${(num / 1e6).toFixed(2)}M`;
    return isCurrency ? `${symbolStr}${num.toFixed(2)}` : num.toFixed(2);
  };

  const fmtPct = (val) => (val && val.raw !== undefined ? `${(val.raw * 100).toFixed(2)}%` : 'N/A');

  return {
    symbol,
    shortName: price.shortName || symbol,
    longName: price.longName || price.shortName || symbol,
    exchangeName: price.exchangeName || 'N/A',
    currency: price.currency || 'USD',
    currentPrice: price.regularMarketPrice?.raw ?? 'N/A',
    priceChange: price.regularMarketChange?.raw ?? 0,
    priceChangePercent: price.regularMarketChangePercent?.raw ?? 0,
    marketCap: fmtNum(price.marketCap, true, '$'),
    peRatio: fmtNum(detail.trailingPE),
    forwardPE: fmtNum(detail.forwardPE),
    eps: fmtNum(stats.trailingEps),
    beta: fmtNum(detail.beta),
    fiftyTwoWeekHigh: fmtNum(detail.fiftyTwoWeekHigh, true, '$'),
    fiftyTwoWeekLow: fmtNum(detail.fiftyTwoWeekLow, true, '$'),
    dividendYield: fmtPct(detail.dividendYield),
    
    // 财务健康
    totalRevenue: fmtNum(fin.totalRevenue, true, '$'),
    grossMargins: fmtPct(fin.grossMargins),
    profitMargins: fmtPct(fin.profitMargins),
    returnOnEquity: fmtPct(fin.returnOnEquity),
    totalDebt: fmtNum(fin.totalDebt, true, '$'),
    freeCashflow: fmtNum(fin.freeCashflow, true, '$'),
    
    // 评级与目标价
    targetMeanPrice: fmtNum(fin.targetMeanPrice, true, '$'),
    recommendationKey: (fin.recommendationKey || 'N/A').toUpperCase(),
    analystBuyCount: (rec.strongBuy || 0) + (rec.buy || 0),
    analystHoldCount: rec.hold || 0,
    analystSellCount: (rec.sell || 0) + (rec.strongSell || 0),

    // 公司信息
    sector: profile.sector || 'N/A',
    industry: profile.industry || 'N/A',
    fullTimeEmployees: profile.fullTimeEmployees ? profile.fullTimeEmployees.toLocaleString() : 'N/A',
    longBusinessSummary: profile.longBusinessSummary || '无公司简介信息。'
  };
}

/**
 * 前端 单页应用 (SPA) UI
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
    
    <!-- 头部与搜索栏 -->
    <header class="mb-8 text-center">
      <h1 class="text-3xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
        <i class="fa-solid me-2 fa-chart-line"></i>个股状态智能分析总览
      </h1>
      <p class="text-slate-400 text-sm mb-6">基于 Yahoo Finance 数据源 · 实时数据采集与解析</p>
      
      <form id="searchForm" class="flex justify-center max-w-md mx-auto gap-2">
        <input 
          type="text" 
          id="symbolInput" 
          placeholder="输入股票代码 (例: AAPL, NVDA, 0700.HK)" 
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

    <!-- 进度条容器 (默认隐藏) -->
    <div id="progressContainer" class="hidden max-w-2xl mx-auto mb-10 bg-slate-800/80 border border-slate-700/60 p-6 rounded-xl shadow-xl backdrop-blur">
      <div class="flex justify-between text-sm font-medium mb-2">
        <span id="progressStatus" class="text-blue-400">正在初始化数据请求...</span>
        <span id="progressPercent" class="text-slate-300 font-mono">0%</span>
      </div>
      <div class="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
        <div id="progressBar" class="bg-gradient-to-r from-blue-500 to-emerald-400 h-3 rounded-full transition-all duration-300 ease-out" style="width: 0%"></div>
      </div>
    </div>

    <!-- 错误信息提示 -->
    <div id="errorMessage" class="hidden max-w-2xl mx-auto mb-8 bg-red-900/40 border border-red-500/50 text-red-200 p-4 rounded-xl text-center text-sm"></div>

    <!-- 仪表盘主体 (初始隐藏) -->
    <main id="dashboard" class="hidden space-y-6">
      
      <!-- 股票名片与实时价格 -->
      <div class="bg-slate-800 border border-slate-700/60 rounded-xl p-6 flex flex-col md:flex-row justify-between md:items-center gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h2 id="stockName" class="text-2xl font-bold text-white">--</h2>
            <span id="stockSymbol" class="px-2.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono text-sm">--</span>
            <span id="stockExchange" class="text-xs text-slate-400">--</span>
          </div>
          <p id="stockIndustry" class="text-sm text-slate-400 mt-1">-- | --</p>
        </div>
        <div class="text-left md:text-right">
          <div id="stockPrice" class="text-3xl font-bold font-mono">--</div>
          <div id="stockChange" class="text-sm font-mono mt-0.5">--</div>
        </div>
      </div>

      <!-- 核心指标网格 -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">市值 (Market Cap)</div>
          <div id="mktCap" class="text-lg font-semibold font-mono text-slate-200">--</div>
        </div>
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div class="text-xs text-slate-400 mb-1">市盈率 P/E (TTM / 静)</div>
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

      <!-- 详细卡片组：三列布局 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        <!-- 交易与估值 -->
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-blue-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-sliders me-1.5"></i>交易与价格范围
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
            <span class="text-slate-400">股息率 (Dividend Yield)</span>
            <span id="divYield" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">Beta (波动系数)</span>
            <span id="beta" class="font-mono text-slate-200">--</span>
          </div>
        </div>

        <!-- 财务与盈利 -->
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-emerald-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-vault me-1.5"></i>财务健康指标
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">总营收 (Revenue)</span>
            <span id="totalRevenue" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">毛利率 (Gross Margin)</span>
            <span id="grossMargins" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">净利率 (Profit Margin)</span>
            <span id="profitMargins" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">净资产收益率 (ROE)</span>
            <span id="roe" class="font-mono text-slate-200">--</span>
          </div>
        </div>

        <!-- 分析师观点与评级 -->
        <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <h3 class="text-sm font-semibold text-purple-400 uppercase tracking-wider border-b border-slate-700 pb-2">
            <i class="fa-solid fa-user-tie me-1.5"></i>机构综合评级
          </h3>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">一致评级建言</span>
            <span id="recKey" class="font-bold font-mono text-blue-400">--</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-slate-700/40">
            <span class="text-slate-400">机构平均目标价</span>
            <span id="targetPrice" class="font-mono text-slate-200">--</span>
          </div>
          <div class="flex justify-between text-sm py-1">
            <span class="text-slate-400">买入 / 持有 / 卖出 人数</span>
            <span id="analystVotes" class="font-mono text-slate-200">--</span>
          </div>
        </div>

      </div>

      <!-- 公司简介 -->
      <div class="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5">
        <h3 class="text-sm font-semibold text-slate-300 uppercase tracking-wider border-b border-slate-700 pb-2 mb-3">
          <i class="fa-solid fa-building me-1.5"></i>公司业务简介
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

      // 重置界面状态
      errorMessage.classList.add('hidden');
      dashboard.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-50');
      
      updateProgress(0, '正在建立连接...');

      // 创建 SSE 链接监听后端进度
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
      document.getElementById('stockIndustry').textContent = \`\${data.sector} | \${data.industry} (员工数: \${data.fullTimeEmployees})\`;

      // 价格颜色
      const priceEl = document.getElementById('stockPrice');
      const changeEl = document.getElementById('stockChange');
      const isPositive = data.priceChange >= 0;
      const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
      
      priceEl.textContent = \`\${data.currentPrice} \${data.currency}\`;
      changeEl.className = \`text-sm font-mono mt-0.5 \${colorClass}\`;
      changeEl.textContent = \`\${isPositive ? '+' : ''}\${data.priceChange.toFixed(2)} (\${isPositive ? '+' : ''}\${(data.priceChangePercent * 100).toFixed(2)}%)\`;

      // 核心指标
      document.getElementById('mktCap').textContent = data.marketCap;
      document.getElementById('peRatio').textContent = data.peRatio;
      document.getElementById('forwardPE').textContent = data.forwardPE;
      document.getElementById('eps').textContent = data.eps;

      // 交易范围
      document.getElementById('high52').textContent = data.fiftyTwoWeekHigh;
      document.getElementById('low52').textContent = data.fiftyTwoWeekLow;
      document.getElementById('divYield').textContent = data.dividendYield;
      document.getElementById('beta').textContent = data.beta;

      // 财务健康
      document.getElementById('totalRevenue').textContent = data.totalRevenue;
      document.getElementById('grossMargins').textContent = data.grossMargins;
      document.getElementById('profitMargins').textContent = data.profitMargins;
      document.getElementById('roe').textContent = data.returnOnEquity;

      // 分析师评级
      document.getElementById('recKey').textContent = data.recommendationKey;
      document.getElementById('targetPrice').textContent = data.targetMeanPrice;
      document.getElementById('analystVotes').textContent = \`\${data.analystBuyCount} / \${data.analystHoldCount} / \${data.analystSellCount}\`;

      // 公司简介
      document.getElementById('businessSummary').textContent = data.longBusinessSummary;
    }
  </script>
</body>
</html>`;
}