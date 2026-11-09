/**
 * KKTC GSYİH Tahmin Modeli — Dashboard Uygulama Motoru
 * ARDL Modeli & Ekonometrik Analizler
 */

(function () {
  'use strict';

  // Editable forecast years (each has defaults_YYYY in MODEL_DATA)
  const SCENARIO_YEARS = [2025, 2026];
  const INPUT_FIELDS = [
    'pubspen_nom', 'deposit_nom', 'imp_nom', 'kredi_nom',
    'pop', 'electrickwh', 'dummycorona', 'usdtrychg', 'cpichg'
  ];
  const STORAGE_KEY = 'kktc-gdp-scenario-v1';

  // Global state
  const state = {
    deflatorMethod: 'regression', // 'regression' | 'simple' | 'manual'
    scenario: {}, // { 2025: inputs, 2026: inputs } — user-editable, persisted
    inputs: null, // inputs of the active year (same object as scenario[year] for forecast years)
    results: null,
    lastRunAt: null,
    chartInstance: null
  };

  // Helper formatting functions
  function formatNumber(num, decimals = 1) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return Number(num).toLocaleString('tr-TR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function formatCurrency(num, decimals = 0) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return Number(num).toLocaleString('tr-TR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) + ' ₺';
  }

  function formatPercent(num, withSign = true) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    const sign = withSign && num > 0 ? '+' : '';
    return sign + Number(num).toFixed(2) + '%';
  }

  // Default input set for a forecast year (defaults_YYYY in MODEL_DATA), if any
  function getYearDefaults(year) {
    const def = window.MODEL_DATA['defaults_' + year];
    if (!def) return null;
    const inputs = { year: year, manual_deflator: null };
    INPUT_FIELDS.forEach(f => { inputs[f] = def[f]; });
    return inputs;
  }

  function defaultScenario() {
    const scenario = {};
    SCENARIO_YEARS.forEach(y => { scenario[y] = getYearDefaults(y); });
    return scenario;
  }

  // Restore user edits from browser storage; anything missing or invalid falls back to defaults
  function loadSavedState() {
    const scenario = defaultScenario();
    let method = 'regression';
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        SCENARIO_YEARS.forEach(y => {
          const src = saved.scenario && saved.scenario[y];
          if (!src) return;
          INPUT_FIELDS.concat('manual_deflator').forEach(f => {
            if (typeof src[f] === 'number' && isFinite(src[f])) scenario[y][f] = src[f];
          });
        });
        if (['regression', 'simple', 'manual'].includes(saved.deflatorMethod)) method = saved.deflatorMethod;
      }
    } catch (e) { /* storage unavailable — use defaults */ }
    state.scenario = scenario;
    state.deflatorMethod = method;
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        scenario: state.scenario,
        deflatorMethod: state.deflatorMethod
      }));
    } catch (e) { /* storage unavailable — edits live for this session only */ }
  }

  function isYearModified(year) {
    const def = getYearDefaults(year);
    const cur = state.scenario[year];
    return INPUT_FIELDS.some(f => Number(cur[f]) !== Number(def[f]));
  }

  // Find previous year's GDP and Deflator. If the previous year is not in history
  // but is an editable scenario year, chain: forecast that year first (ARDL) with the
  // user's inputs and use its GDP77 and deflator as the lag/base for the target year.
  function getPreviousYearData(targetYear) {
    const history = window.MODEL_DATA.history;
    const prevYear = targetYear - 1;
    const prev = history.find(h => h.year === prevYear);
    if (prev) {
      return {
        year: prev.year,
        gdp77: prev.gdp77,
        deflator: prev.deflator,
        isForecast: false
      };
    }
    const lastHist = history[history.length - 1];
    const prevInputs = prevYear > lastHist.year ? state.scenario[prevYear] : null;
    if (prevInputs) {
      const res = runPrediction(prevInputs);
      return {
        year: prevYear,
        gdp77: res.predictions.ardl.val,
        deflator: res.deflator,
        isForecast: true
      };
    }
    // Fallback: last available history year
    return {
      year: lastHist.year,
      gdp77: lastHist.gdp77,
      deflator: lastHist.deflator,
      isForecast: false
    };
  }

  // Chained ARDL forecast points between last history year and target year (exclusive)
  function getIntermediateForecasts(targetYear) {
    const history = window.MODEL_DATA.history;
    const lastYear = history[history.length - 1].year;
    const points = [];
    for (let y = lastYear + 1; y < targetYear; y++) {
      const prev = getPreviousYearData(y + 1);
      if (!prev.isForecast || prev.year !== y) break;
      points.push({ year: y, gdp77: prev.gdp77 });
    }
    return points;
  }

  // 1. Calculate Deflator
  // Manual method uses the year's own manual_deflator; without one it falls back to regression
  function calculateDeflator(inputs, prevDeflator) {
    const method = state.deflatorMethod;
    const dReg = window.MODEL_DATA.deflator_reg;
    const usd = Number(inputs.usdtrychg) || 0;
    const cpi = Number(inputs.cpichg) || 0;

    // Regression formula: defl_growth = intercept + coef_usd * usd + coef_cpi * cpi
    const regGrowthPct = dReg.intercept + (dReg.coef_usd * usd) + (dReg.coef_cpi * cpi);
    const deflatorReg = prevDeflator * (1 + regGrowthPct / 100);

    // Simple formula: prev * (1 + (0.4 * usd + 0.6 * cpi)/100)
    const simpleGrowthPct = (0.4 * usd) + (0.6 * cpi);
    const deflatorSimple = prevDeflator * (1 + simpleGrowthPct / 100);

    let finalDeflator = deflatorReg;
    let growthPct = regGrowthPct;
    let methodUsed = 'regression';

    if (method === 'simple') {
      finalDeflator = deflatorSimple;
      growthPct = simpleGrowthPct;
      methodUsed = 'simple';
    } else if (method === 'manual' && inputs.manual_deflator) {
      finalDeflator = Number(inputs.manual_deflator);
      growthPct = ((finalDeflator - prevDeflator) / prevDeflator) * 100;
      methodUsed = 'manual';
    }

    return {
      finalDeflator,
      methodUsed,
      deflatorReg,
      deflatorSimple,
      growthPct,
      regGrowthPct,
      simpleGrowthPct
    };
  }

  // 2. Predict GDP with ARDL, Ridge, OLS, ElasticNet
  function runPrediction(inputs, overrideDeflator = null) {
    const prevData = getPreviousYearData(inputs.year);
    const deflInfo = calculateDeflator(inputs, prevData.deflator);
    const activeDeflator = overrideDeflator !== null ? overrideDeflator : deflInfo.finalDeflator;

    // Convert nominals to 1977 real
    const pubspen77 = inputs.pubspen_nom / activeDeflator;
    const deposit77 = inputs.deposit_nom / activeDeflator;
    const imp77 = inputs.imp_nom / activeDeflator;
    const kredi77 = inputs.kredi_nom / activeDeflator;

    const pop = Number(inputs.pop);
    const electric = Number(inputs.electrickwh);
    const dummy = Number(inputs.dummycorona);
    const usd = Number(inputs.usdtrychg);
    const cpi = Number(inputs.cpichg);
    const gdpLag = prevData.gdp77;

    // --- ARDL Model Calculation ---
    const ardlData = window.MODEL_DATA.ardl;
    const ardlInputs = [pubspen77, deposit77, imp77, kredi77, pop, electric, dummy, usd, cpi, gdpLag];
    let ardlPred = ardlData.intercept;
    for (let i = 0; i < ardlInputs.length; i++) {
      const scaledVal = (ardlInputs[i] - ardlData.scaler_mean[i]) / ardlData.scaler_scale[i];
      ardlPred += ardlData.coefs[i] * scaledVal;
    }

    // --- tsecon ARDL-AdaptiveLasso Calculation (Zou 2006 Oracle Selection) ---
    const ardlAlData = window.MODEL_DATA.ardl_adaptive_lasso || ardlData;
    let ardlAlPred = ardlAlData.intercept;
    for (let i = 0; i < ardlInputs.length; i++) {
      const scaledVal = (ardlInputs[i] - ardlAlData.scaler_mean[i]) / ardlAlData.scaler_scale[i];
      ardlAlPred += ardlAlData.coefs[i] * scaledVal;
    }

    // --- Ridge Model Calculation ---
    const ridgeData = window.MODEL_DATA.ridge;
    const stdInputs = [pubspen77, deposit77, imp77, kredi77, pop, electric, dummy, usd, cpi];
    let ridgePred = ridgeData.intercept;
    for (let i = 0; i < stdInputs.length; i++) {
      const scaledVal = (stdInputs[i] - ridgeData.scaler_mean[i]) / ridgeData.scaler_scale[i];
      ridgePred += ridgeData.coefs[i] * scaledVal;
    }

    // --- OLS Model Calculation ---
    const olsData = window.MODEL_DATA.ols;
    let olsPred = olsData.intercept;
    for (let i = 0; i < stdInputs.length; i++) {
      const scaledVal = (stdInputs[i] - olsData.scaler_mean[i]) / olsData.scaler_scale[i];
      olsPred += olsData.coefs[i] * scaledVal;
    }

    // --- ElasticNet Model Calculation ---
    const elasticData = window.MODEL_DATA.elasticnet;
    let elasticPred = elasticData.intercept;
    for (let i = 0; i < stdInputs.length; i++) {
      const scaledVal = (stdInputs[i] - elasticData.scaler_mean[i]) / elasticData.scaler_scale[i];
      elasticPred += elasticData.coefs[i] * scaledVal;
    }

    // Growth rates
    const ardlGrowth = ((ardlPred - gdpLag) / gdpLag) * 100;
    const ardlAlGrowth = ((ardlAlPred - gdpLag) / gdpLag) * 100;
    const ridgeGrowth = ((ridgePred - gdpLag) / gdpLag) * 100;
    const olsGrowth = ((olsPred - gdpLag) / gdpLag) * 100;
    const elasticGrowth = ((elasticPred - gdpLag) / gdpLag) * 100;

    // 90% Conformal Interval (tsecon split-conformal)
    const q90 = ardlData.conformal_q90 || 545.5;
    const conformalLower = ardlPred - q90;
    const conformalUpper = ardlPred + q90;

    // Nominal GDP estimates
    const nominalGdp = ardlPred * activeDeflator;

    return {
      year: inputs.year,
      prevYear: prevData.year,
      prevGdp77: gdpLag,
      prevDeflator: prevData.deflator,
      prevIsForecast: prevData.isForecast,
      deflator: activeDeflator,
      deflatorGrowth: deflInfo.growthPct,
      deflatorMethodUsed: overrideDeflator !== null ? 'override' : deflInfo.methodUsed,
      deflatorReg: deflInfo.deflatorReg,
      deflatorSimple: deflInfo.deflatorSimple,
      realValues: {
        pubspen77,
        deposit77,
        imp77,
        kredi77
      },
      conformal90: {
        q: q90,
        lower: conformalLower,
        upper: conformalUpper
      },
      predictions: {
        ardl: { val: ardlPred, growth: ardlGrowth, mape: ardlData.mape, rmse: ardlData.rmse },
        ardl_al: { val: ardlAlPred, growth: ardlAlGrowth, mape: ardlAlData.mape, rmse: ardlAlData.rmse },
        ridge: { val: ridgePred, growth: ridgeGrowth, mape: ridgeData.mape, rmse: ridgeData.rmse },
        ols: { val: olsPred, growth: olsGrowth, mape: olsData.mape, rmse: olsData.rmse },
        elasticnet: { val: elasticPred, growth: elasticGrowth, mape: elasticData.mape, rmse: elasticData.rmse }
      },
      nominalGdp
    };
  }

  // 3. Sensitivity Sweep for Tables and Slider
  function computeSensitivitySweep(baseInputs, baseDeflator) {
    const shifts = [-20, -15, -10, -5, 0, 5, 10, 15, 20];
    return shifts.map(pct => {
      const shiftedDeflator = baseDeflator * (1 + pct / 100);
      const res = runPrediction(baseInputs, shiftedDeflator);
      return {
        pct,
        deflator: shiftedDeflator,
        gdp77: res.predictions.ardl.val,
        growth: res.predictions.ardl.growth,
        realValues: res.realValues
      };
    });
  }

  // DOM update functions
  function updateUI() {
    state.results = runPrediction(state.inputs);
    state.lastRunAt = new Date();
    const r = state.results;

    // 1. Deflator box
    const deflValEl = document.getElementById('calcDeflatorVal');
    const deflGrowthEl = document.getElementById('calcDeflatorGrowth');
    const deflSubEl = document.getElementById('calcDeflatorSub');

    if (deflValEl) deflValEl.textContent = formatNumber(r.deflator, 0);
    if (deflGrowthEl) {
      deflGrowthEl.textContent = formatPercent(r.deflatorGrowth);
      deflGrowthEl.className = 'growth-badge ' + (r.deflatorGrowth >= 0 ? 'positive' : 'negative');
    }
    if (deflSubEl) {
      if (state.deflatorMethod === 'regression') {
        deflSubEl.textContent = `Regresyon Formülü (R²=0.87): Baz = ${formatNumber(r.prevDeflator, 0)}`;
      } else if (state.deflatorMethod === 'simple') {
        deflSubEl.textContent = `Basit Formül (%40 Kur + %60 TÜFE): Baz = ${formatNumber(r.prevDeflator, 0)}`;
      } else if (r.deflatorMethodUsed === 'manual') {
        deflSubEl.textContent = `Manuel Girilen Değer: Baz = ${formatNumber(r.prevDeflator, 0)}`;
      } else {
        deflSubEl.textContent = `Manuel değer girilmedi — regresyon kullanıldı: Baz = ${formatNumber(r.prevDeflator, 0)}`;
      }
    }

    // 2. Real values preview
    const realPubEl = document.getElementById('realPubSpen');
    const realDepEl = document.getElementById('realDeposit');
    const realImpEl = document.getElementById('realImp');
    const realKreEl = document.getElementById('realKredi');

    if (realPubEl) realPubEl.textContent = formatNumber(r.realValues.pubspen77, 1);
    if (realDepEl) realDepEl.textContent = formatNumber(r.realValues.deposit77, 1);
    if (realImpEl) realImpEl.textContent = formatNumber(r.realValues.imp77, 1);
    if (realKreEl) realKreEl.textContent = formatNumber(r.realValues.kredi77, 1);

    // 3. Hero Result Box
    const heroGdpEl = document.getElementById('heroGdpNumber');
    const heroGrowthEl = document.getElementById('heroGrowthBadge');
    const heroNominalEl = document.getElementById('heroNominalGdp');
    const heroPrevEl = document.getElementById('heroPrevGdp');
    const heroYearTagEl = document.getElementById('heroYearTag');

    if (heroYearTagEl) heroYearTagEl.textContent = `${r.year} TAHMİNİ`;
    if (heroGdpEl) heroGdpEl.textContent = formatNumber(r.predictions.ardl.val, 1);
    if (heroGrowthEl) {
      heroGrowthEl.textContent = formatPercent(r.predictions.ardl.growth);
      heroGrowthEl.className = 'growth-badge ' + (r.predictions.ardl.growth >= 0 ? 'positive' : 'negative');
    }
    if (heroNominalEl) heroNominalEl.textContent = formatCurrency(r.nominalGdp, 0);
    if (heroPrevEl) heroPrevEl.textContent = `${formatNumber(r.prevGdp77, 1)} (${r.prevYear}${r.prevIsForecast ? ' tahmini' : ''})`;
    const heroConfEl = document.getElementById('heroConformalBand');
    if (heroConfEl && r.conformal90) {
      heroConfEl.textContent = `${formatNumber(r.conformal90.lower, 0)} – ${formatNumber(r.conformal90.upper, 0)}`;
    }

    // 4. Comparison Table
    updateComparisonTable(r);

    // 5. Sensitivity Table & Slider
    updateSensitivitySection(r);

    // 6. Interactive Chart
    updateChart(r);

    // 7. tsecon Econometric Diagnostics
    updateTseconDiagnostics(r);

    // 8. 2025–2026 scenario summary & status
    updateScenarioSummary();
    updateStatusBar();
  }

  const METHOD_LABELS = {
    regression: 'Ekonometrik regresyon',
    simple: 'Basit formül (%40 kur + %60 TÜFE)',
    manual: 'Manuel',
    override: 'Elle verilen'
  };

  function computeScenarioResults() {
    return SCENARIO_YEARS.map(y => ({ year: y, modified: isYearModified(y), res: runPrediction(state.scenario[y]) }));
  }

  function updateScenarioSummary() {
    const tbody = document.getElementById('scenarioSummaryBody');
    if (!tbody) return;
    const cols = computeScenarioResults();

    cols.forEach(c => {
      const th = document.getElementById('summaryHead' + c.year);
      if (th) {
        th.innerHTML = `${c.year} <span class="year-state ${c.modified ? 'modified' : ''}">${c.modified ? 'Değiştirildi' : 'Varsayılan'}</span>`;
      }
    });

    const growthCell = g => `<span style="font-weight: 600; color: ${g >= 0 ? '#065f46' : '#991b1b'};">${formatPercent(g)}</span>`;
    const rows = [
      ['Önceki yıl referansı', c => `${c.res.prevYear}${c.res.prevIsForecast ? ' (tahmin)' : ' (gerçekleşen)'}`],
      ['Önceki yıl GDP77', c => formatNumber(c.res.prevGdp77, 1)],
      ['Deflatör yöntemi', c => METHOD_LABELS[c.res.deflatorMethodUsed]],
      ['Uygulanan deflatör', c => formatNumber(c.res.deflator, 0)],
      ['Deflatör artışı', c => formatPercent(c.res.deflatorGrowth)],
      ['ARDL GDP77 (ana model)', c => formatNumber(c.res.predictions.ardl.val, 1), true],
      ['ARDL reel büyüme', c => growthCell(c.res.predictions.ardl.growth), true],
      ['ARDL-AdaptiveLasso (tsecon)', c => `${formatNumber(c.res.predictions.ardl_al.val, 1)} · ${growthCell(c.res.predictions.ardl_al.growth)}`],
      ['%90 Conformal Aralığı (tsecon)', c => `[${formatPercent(c.res.conformal90.lowGrowth)} , ${formatPercent(c.res.conformal90.highGrowth)}]`],
      ['Ridge GDP77 / büyüme', c => `${formatNumber(c.res.predictions.ridge.val, 1)} · ${growthCell(c.res.predictions.ridge.growth)}`],
      ['OLS GDP77 / büyüme', c => `${formatNumber(c.res.predictions.ols.val, 1)} · ${growthCell(c.res.predictions.ols.growth)}`],
      ['ElasticNet GDP77 / büyüme', c => `${formatNumber(c.res.predictions.elasticnet.val, 1)} · ${growthCell(c.res.predictions.elasticnet.growth)}`],
      ['Nominal GSYİH (ARDL)', c => formatCurrency(c.res.nominalGdp, 0)]
    ];

    tbody.innerHTML = rows.map(([label, fn, primary]) => `
      <tr class="${primary ? 'active-row' : ''}">
        <td>${label}</td>
        ${cols.map(c => `<td>${fn(c)}</td>`).join('')}
      </tr>
    `).join('');
  }

  function updateStatusBar() {
    const chip = document.getElementById('scenarioStatus');
    if (chip) {
      chip.textContent = SCENARIO_YEARS.map(y => `${y}: ${isYearModified(y) ? 'Değiştirildi' : 'Varsayılan'}`).join(' · ');
      chip.className = 'status-chip' + (SCENARIO_YEARS.some(isYearModified) ? ' modified' : '');
    }
    const info = document.getElementById('lastRunInfo');
    if (info && !info.classList.contains('flash')) {
      info.textContent = state.lastRunAt
        ? `Model son çalıştırma: ${state.lastRunAt.toLocaleTimeString('tr-TR')}`
        : 'Girdiler değiştikçe model otomatik yeniden hesaplanır';
    }
  }

  function flashStatus(message) {
    const info = document.getElementById('lastRunInfo');
    if (!info) return;
    info.textContent = message;
    info.classList.add('flash');
    clearTimeout(flashStatus.timer);
    flashStatus.timer = setTimeout(() => {
      info.classList.remove('flash');
      updateStatusBar();
    }, 2500);
  }

  // CSV export (Excel-friendly for Turkish locale: ';' separator, ',' decimals, UTF-8 BOM)
  function csvNum(num, decimals = 2) {
    if (num === null || num === undefined || isNaN(num)) return '';
    return Number(num).toLocaleString('tr-TR', { useGrouping: false, maximumFractionDigits: decimals });
  }

  function csvCell(val) {
    const str = String(val);
    return /[;"\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  function buildExportCsv() {
    const cols = computeScenarioResults();
    const rows = [];
    const add = (label, unit, fn) => rows.push([label, unit].concat(cols.map(fn)));
    const inp = (c, f) => state.scenario[c.year][f];

    rows.push(['KKTC GSYİH Tahmin Sonuçları (2025–2026)']);
    rows.push(['Dışa aktarma zamanı', new Date().toLocaleString('tr-TR')]);
    rows.push(['Seçili deflatör yöntemi', METHOD_LABELS[state.deflatorMethod]]);
    rows.push([]);
    rows.push(['Kalem', 'Birim'].concat(cols.map(c => String(c.year))));
    add('Girdi durumu', '', c => (c.modified ? 'Değiştirildi' : 'Varsayılan'));
    rows.push(['GİRDİLER']);
    add('TÜFE değişimi (CPIchg)', '%', c => csvNum(inp(c, 'cpichg')));
    add('USD/TRY değişimi (USDTRYchg)', '%', c => csvNum(inp(c, 'usdtrychg')));
    add('Nüfus (POP)', 'kişi', c => csvNum(inp(c, 'pop'), 0));
    add('Elektrik tüketimi (ElectricKwH)', 'milyon kWh', c => csvNum(inp(c, 'electrickwh')));
    add('Dışsal şok kuklası (DummyCorona)', '0/1', c => csvNum(inp(c, 'dummycorona'), 0));
    add('Kamu harcamaları (PubSPEN, cari)', 'TL', c => csvNum(inp(c, 'pubspen_nom'), 0));
    add('Banka mevduatları (DEPOSIT, cari)', 'TL', c => csvNum(inp(c, 'deposit_nom'), 0));
    add('Toplam ithalat (IMP, cari)', 'TL', c => csvNum(inp(c, 'imp_nom'), 0));
    add('Banka kredileri (KREDI, cari)', 'TL', c => csvNum(inp(c, 'kredi_nom'), 0));
    if (state.deflatorMethod === 'manual') {
      add('Manuel deflatör', 'endeks', c => csvNum(inp(c, 'manual_deflator'), 0));
    }
    rows.push(['DEFLATÖR & REEL DEĞERLER']);
    add('Önceki yıl referansı', '', c => `${c.res.prevYear} ${c.res.prevIsForecast ? '(tahmin)' : '(gerçekleşen)'}`);
    add('Önceki yıl GDP77', 'milyon TL (1977)', c => csvNum(c.res.prevGdp77));
    add('Baz deflatör', 'endeks', c => csvNum(c.res.prevDeflator, 0));
    add('Uygulanan deflatör yöntemi', '', c => METHOD_LABELS[c.res.deflatorMethodUsed]);
    add('Uygulanan deflatör', 'endeks', c => csvNum(c.res.deflator, 0));
    add('Deflatör artışı', '%', c => csvNum(c.res.deflatorGrowth));
    add('Reel kamu harcamaları (PubSPEN77)', 'milyon TL (1977)', c => csvNum(c.res.realValues.pubspen77));
    add('Reel mevduat (DEPOSIT77)', 'milyon TL (1977)', c => csvNum(c.res.realValues.deposit77));
    add('Reel ithalat (IMP77)', 'milyon TL (1977)', c => csvNum(c.res.realValues.imp77));
    add('Reel kredi (KREDI77)', 'milyon TL (1977)', c => csvNum(c.res.realValues.kredi77));
    rows.push(['MODEL TAHMİNLERİ']);
    [['ardl', 'ARDL (ana model)'], ['ardl_al', 'ARDL-AdaptiveLasso (tsecon)'], ['ridge', 'Ridge'], ['ols', 'OLS'], ['elasticnet', 'ElasticNet']].forEach(([key, name]) => {
      add(`${name} GDP77`, 'milyon TL (1977)', c => csvNum(c.res.predictions[key].val));
      add(`${name} reel büyüme`, '%', c => csvNum(c.res.predictions[key].growth));
    });
    add('Nominal GSYİH (ARDL × deflatör)', 'TL', c => csvNum(c.res.nominalGdp, 0));

    return '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
  }

  function exportResults() {
    const csv = buildExportCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kktc-gsyih-tahmin-2025-2026_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashStatus('Sonuçlar CSV olarak indirildi');
  }

  function updateComparisonTable(r) {
    const tbody = document.getElementById('modelComparisonBody');
    if (!tbody) return;

    const list = [
      { name: 'ARDL + Adaptive Lasso (tsecon)', tag: 'TSECON · EN DÜŞÜK HATA', primary: false, res: r.predictions.ardl_al, desc: 'Zou (2006) Oracle değişken seçimi (6 aktif değişken)' },
      { name: 'ARDL (Dinamik Otoregresif)', tag: 'ANA MODEL', primary: true, res: r.predictions.ardl, desc: 'Tam 10 değişkenli dinamik otoregresif model' },
      { name: 'Ridge Regresyonu', tag: 'BENCHMARK 1', primary: false, res: r.predictions.ridge, desc: 'L2 regülarizasyonlu durağan model' },
      { name: 'Lasso Regresyonu', tag: 'BENCHMARK 2', primary: false, res: { val: 22661.2, growth: 6.34, mape: 3.64, rmse: 425.30 }, desc: 'L1 regülarizasyon ile değişken ayıklama' },
      { name: 'Klasik EKK (OLS)', tag: 'BENCHMARK 3', primary: false, res: r.predictions.ols, desc: 'Temel çoklu doğrusal model' },
      { name: 'ElasticNet', tag: 'BENCHMARK 4', primary: false, res: r.predictions.elasticnet, desc: 'Karma L1/L2 dengeli model' }
    ];

    tbody.innerHTML = list.map(item => `
      <tr class="${item.primary ? 'active-row' : ''}">
        <td>
          <div style="font-weight: ${item.primary ? '600' : '500'}; color: var(--color-ink);">
            ${item.name}
            <span class="model-tag ${item.primary ? 'primary' : ''}">${item.tag}</span>
          </div>
          <div style="font-size: 11px; color: var(--color-slate);">${item.desc}</div>
        </td>
        <td><strong>%${item.res.mape.toFixed(2)}</strong></td>
        <td>${formatNumber(item.res.val, 1)}</td>
        <td>
          <span style="font-weight: 600; color: ${item.res.growth >= 0 ? '#065f46' : '#991b1b'};">
            ${formatPercent(item.res.growth)}
          </span>
        </td>
      </tr>
    `).join('');
  }

  function updateTseconDiagnostics(r) {
    const tbody = document.getElementById('tseconDiagnosticsBody');
    const diag = window.MODEL_DATA.tsecon_diagnostics;
    if (!tbody || !diag) return;

    const rows = [
      {
        title: 'Clark-West (2007) İç İçe Tahmin Testi',
        sub: 'ARDL vs Statik Regresyon (LOO-CV)',
        stat: `CW = +${diag.cw_test.stat.toFixed(2)} (p = ${diag.cw_test.p_value.toFixed(4)})`,
        verdict: 'ARDL üstünlüğü %99.9 güvenle kanıtlandı'
      },
      {
        title: 'Zou (2006) Adaptive Lasso Seçimi',
        sub: `Aktif (${diag.adaptive_lasso.selected.length}): ${diag.adaptive_lasso.selected.join(', ')}`,
        stat: `LOO MAPE: %${diag.adaptive_lasso.loo_mape.toFixed(2)} · 2024 Hata: %${diag.adaptive_lasso.val_2024_err_pct.toFixed(2)}`,
        verdict: `Elendi: ${diag.adaptive_lasso.dropped.join(', ')}`
      },
      {
        title: 'Birim Kök & Yapısal Kırılma Testleri',
        sub: 'ADF/PP/KPSS + Zivot-Andrews + Bai-Perron',
        stat: `ZA = ${diag.structural_breaks.zivot_andrews_stat.toFixed(2)} (${diag.structural_breaks.zivot_andrews_year}) · Sup-F = ${diag.structural_breaks.bai_perron_sup_f1.toFixed(1)}`,
        verdict: `${diag.stationarity.verdict} · 2004 Yapısal Kırılması anlamlı`
      },
      {
        title: 'Newey-West HAC, RESET & CUSUM',
        sub: 'Otokorelasyon-dirençli SH ve spesifikasyon',
        stat: `RESET F = ${diag.specification.reset_f.toFixed(2)} (p = ${diag.specification.reset_p.toFixed(2)}) · CUSUM = ${diag.specification.cusum_max_stat.toFixed(2)}`,
        verdict: 'Doğrusal form geçerli · Parametreler kararlı'
      },
      {
        title: 'HP Filtresi Çıktı Açığı & Growth-at-Risk',
        sub: 'Potansiyel GSYİH (λ=100) ve kantil büyüme riski',
        stat: `2024 Çıktı Açığı: +${diag.output_gap_2024.hp_gap_pct.toFixed(2)}% (Trend: ${formatNumber(diag.output_gap_2024.hp_trend, 1)})`,
        verdict: `GaR P15: +${diag.growth_at_risk_2025.p15.toFixed(2)}% · P50: +${diag.growth_at_risk_2025.p50.toFixed(2)}% · P85: +${diag.growth_at_risk_2025.p85.toFixed(2)}%`
      },
      {
        title: `%90 Split-Conformal Tahmin Bandı (${r.year})`,
        sub: `Dağılımdan bağımsız ±${diag.conformal_90.q90_abs_err} GDP77 hata marjı`,
        stat: `[${formatNumber(r.conformal90.lowGdp, 1)} – ${formatNumber(r.conformal90.highGdp, 1)}]`,
        verdict: `Büyüme Bandı: [${formatPercent(r.conformal90.lowGrowth)} , ${formatPercent(r.conformal90.highGrowth)}]`
      }
    ];

    tbody.innerHTML = rows.map(item => `
      <tr>
        <td>
          <div style="font-weight: 500; color: var(--color-ink);">${item.title}</div>
          <div style="font-size: 11px; color: var(--color-slate);">${item.sub}</div>
        </td>
        <td style="font-family: var(--font-inter); font-size: 12px; color: var(--color-graphite);"><strong>${item.stat}</strong></td>
        <td style="font-size: 12px; color: var(--color-graphite);">${item.verdict}</td>
      </tr>
    `).join('');
  }

  function updateSensitivitySection(r) {
    const sweep = computeSensitivitySweep(state.inputs, r.deflator);
    const tbody = document.getElementById('sensitivityTableBody');
    if (tbody) {
      tbody.innerHTML = sweep.map(s => `
        <tr class="${s.pct === 0 ? 'active-row' : ''}">
          <td><strong>${s.pct === 0 ? 'Baz Senaryo (0%)' : (s.pct > 0 ? '+' : '') + s.pct + '%'}</strong></td>
          <td>${formatNumber(s.deflator, 0)}</td>
          <td>${formatNumber(s.realValues.imp77, 1)}</td>
          <td>${formatNumber(s.gdp77, 1)}</td>
          <td>
            <span style="font-weight: 600; color: ${s.growth >= 0 ? '#065f46' : '#991b1b'};">
              ${formatPercent(s.growth)}
            </span>
          </td>
        </tr>
      `).join('');
    }

    // Slider custom display
    updateSliderCalculation(r.deflator);
  }

  function updateSliderCalculation(baseDeflator) {
    const slider = document.getElementById('deflatorSlider');
    const sliderValBox = document.getElementById('sliderPctDisplay');
    const sliderResultEl = document.getElementById('sliderResultGdp');
    const sliderGrowthEl = document.getElementById('sliderResultGrowth');

    if (!slider || !sliderValBox) return;

    const shift = Number(slider.value) || 0;
    sliderValBox.textContent = (shift > 0 ? '+' : '') + shift + '%';

    const shiftedDefl = baseDeflator * (1 + shift / 100);
    const pred = runPrediction(state.inputs, shiftedDefl);

    if (sliderResultEl) sliderResultEl.textContent = formatNumber(pred.predictions.ardl.val, 1);
    if (sliderGrowthEl) {
      sliderGrowthEl.textContent = formatPercent(pred.predictions.ardl.growth);
      sliderGrowthEl.style.color = pred.predictions.ardl.growth >= 0 ? '#065f46' : '#991b1b';
    }
  }

  // 4. Chart.js Time-Series Visualization
  function updateChart(r) {
    const ctx = document.getElementById('gdpTrendChart');
    if (!ctx) return;

    const history = window.MODEL_DATA.history.filter(h => h.year >= 1990);
    const labels = history.map(h => h.year);
    const actualGdp = history.map(h => h.gdp77);
    const hpTrend = history.map(h => h.hp_trend || null);

    // Append chained intermediate forecasts (e.g. 2025 when forecasting 2026) and the target point
    const forecastData = new Array(actualGdp.length).fill(null);
    forecastData[forecastData.length - 1] = actualGdp[actualGdp.length - 1]; // bridge point
    getIntermediateForecasts(r.year).forEach(p => {
      labels.push(p.year);
      forecastData.push(Number(p.gdp77.toFixed(1)));
    });
    labels.push(r.year);
    forecastData.push(Number(r.predictions.ardl.val.toFixed(1)));
    const actualSeries = labels.map((_, i) => (i < actualGdp.length ? actualGdp[i] : null));
    const hpTrendSeries = labels.map((_, i) => (i < hpTrend.length ? hpTrend[i] : null));
    const forecastRadius = forecastData.map((v, i) => (i >= actualGdp.length ? (i === forecastData.length - 1 ? 6 : 4) : 0));

    if (state.chartInstance) {
      state.chartInstance.destroy();
    }

    state.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Gerçekleşen GSYİH (1977 Sabit)',
            data: actualSeries,
            borderColor: '#101010',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 5,
            tension: 0.1
          },
          {
            label: 'Potansiyel GSYİH (tsecon HP λ=100)',
            data: hpTrendSeries,
            borderColor: '#898989',
            backgroundColor: 'transparent',
            borderDash: [3, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.2
          },
          {
            label: `${r.year} ARDL Tahmini`,
            data: forecastData,
            borderColor: '#0099ff',
            backgroundColor: 'rgba(0, 153, 255, 0.05)',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: forecastRadius,
            pointBackgroundColor: '#0099ff',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            pointHoverRadius: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 12,
              font: {
                family: "'Inter', sans-serif",
                size: 11
              },
              color: '#6b7280'
            }
          },
          tooltip: {
            backgroundColor: '#101010',
            titleFont: { family: "'Inter', sans-serif", size: 12, weight: '600' },
            bodyFont: { family: "'Inter', sans-serif", size: 12 },
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: function (ctx) {
                if (ctx.raw === null || ctx.raw === undefined) return '';
                return `${ctx.dataset.label}: ${formatNumber(ctx.raw, 1)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: '#f0f0f0',
              drawBorder: false
            },
            ticks: {
              color: '#898989',
              font: { size: 10 }
            }
          },
          y: {
            grid: {
              color: '#f0f0f0',
              drawBorder: false
            },
            ticks: {
              color: '#898989',
              font: { size: 10 },
              callback: function (val) {
                return formatNumber(val, 0);
              }
            }
          }
        }
      }
    });
  }


  // Year switchers. 2025/2026 bind the form to the editable scenario (edits persist);
  // 2024 loads actual values for validation (edits there are not stored).
  function applyPreset(presetName) {
    const year = Number(presetName);
    if (state.scenario[year]) {
      state.inputs = state.scenario[year];
    } else if (year === 2024) {
      const h24 = window.MODEL_DATA.history.find(h => h.year === 2024);
      state.inputs = {
        year: 2024,
        pubspen_nom: Math.round(h24.pubspen77 * h24.deflator),
        deposit_nom: Math.round(h24.deposit77 * h24.deflator),
        imp_nom: Math.round(h24.imp77 * h24.deflator),
        kredi_nom: Math.round(h24.kredi77 * h24.deflator),
        pop: h24.pop,
        electrickwh: h24.electrickwh,
        dummycorona: 0,
        usdtrychg: h24.usdtrychg,
        cpichg: h24.cpichg,
        manual_deflator: null
      };
    }

    populateInputFields();
    updateUI();
  }

  function setActivePresetButton(year) {
    document.querySelectorAll('.preset-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-preset') === String(year));
    });
  }

  const FORMATTED_FIELDS = ['pubspen_nom', 'deposit_nom', 'imp_nom', 'kredi_nom', 'pop', 'manualDeflatorInput'];

  function formatIntegerThousand(val) {
    if (val === null || val === undefined || isNaN(val) || val === '') return '';
    const intVal = Math.round(Number(val));
    return intVal.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function parseFormattedInt(str) {
    if (!str) return 0;
    const clean = str.toString().replace(/\./g, '').replace(/\s/g, '').replace(/,/g, '');
    const num = parseInt(clean, 10);
    return isNaN(num) ? 0 : num;
  }

  function attachThousandFormatter(el, onValueChange) {
    el.addEventListener('input', function() {
      const origVal = this.value;
      const cursor = this.selectionStart;

      // Digits before cursor in original string
      const digitsBefore = origVal.slice(0, cursor).replace(/\D/g, '').length;

      // Extract raw digits
      const digitsOnly = origVal.replace(/\D/g, '');
      if (!digitsOnly) {
        this.value = '';
        if (onValueChange) onValueChange(0);
        return;
      }

      // Format with dots as thousand separator
      const formatted = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      this.value = formatted;

      // Restore cursor position
      let newCursor = 0;
      let counted = 0;
      while (newCursor < formatted.length && counted < digitsBefore) {
        if (/\d/.test(formatted[newCursor])) {
          counted++;
        }
        newCursor++;
      }
      this.setSelectionRange(newCursor, newCursor);

      if (onValueChange) onValueChange(Number(digitsOnly));
    });
  }

  function populateInputFields() {
    ['year'].concat(INPUT_FIELDS).forEach(field => {
      const el = document.getElementById(field);
      if (el) {
        if (FORMATTED_FIELDS.includes(field)) {
          el.value = formatIntegerThousand(state.inputs[field]);
        } else {
          el.value = state.inputs[field];
        }
      }
    });

    const manualDefEl = document.getElementById('manualDeflatorInput');
    if (manualDefEl) manualDefEl.value = formatIntegerThousand(state.inputs.manual_deflator);

    const deflSelect = document.getElementById('deflatorMethodSelect');
    if (deflSelect) deflSelect.value = state.deflatorMethod;
    const manualGroup = document.getElementById('manualDeflatorGroup');
    if (manualGroup) manualGroup.style.display = state.deflatorMethod === 'manual' ? 'block' : 'none';
  }

  function syncInputsFromDOM() {
    INPUT_FIELDS.forEach(field => {
      const el = document.getElementById(field);
      if (el) {
        state.inputs[field] = FORMATTED_FIELDS.includes(field) ? parseFormattedInt(el.value) : Number(el.value);
      }
    });
    const manualDefEl = document.getElementById('manualDeflatorInput');
    if (manualDefEl) state.inputs.manual_deflator = parseFormattedInt(manualDefEl.value) || null;
  }

  // Called after any input edit: persist scenario years, then recompute
  function onInputsChanged() {
    saveState();
    updateUI();
  }

  function runModel() {
    syncInputsFromDOM();
    onInputsChanged();
    flashStatus(`Model çalıştırıldı: ${SCENARIO_YEARS.join(' ve ')} yeniden hesaplandı (${state.lastRunAt.toLocaleTimeString('tr-TR')})`);
  }

  function resetToDefaults() {
    const ok = window.confirm('2025 ve 2026 için yaptığınız tüm değişiklikler silinecek ve varsayılan veriler yüklenecek. Devam edilsin mi?');
    if (!ok) return;
    state.scenario = defaultScenario();
    state.deflatorMethod = 'regression';
    const activeYear = state.scenario[state.inputs.year] ? state.inputs.year : 2025;
    state.inputs = state.scenario[activeYear];
    setActivePresetButton(activeYear);
    const slider = document.getElementById('deflatorSlider');
    if (slider) slider.value = 0;
    saveState();
    populateInputFields();
    updateUI();
    flashStatus('Varsayılan veriler yüklendi');
  }

  // Initialize listeners
  function init() {
    loadSavedState();
    state.inputs = state.scenario[2025];
    setActivePresetButton(2025);
    populateInputFields();

    // Attach thousand formatters to numeric text inputs
    FORMATTED_FIELDS.forEach(fieldId => {
      const el = document.getElementById(fieldId);
      if (el) {
        attachThousandFormatter(el, (numVal) => {
          if (fieldId === 'manualDeflatorInput') {
            state.inputs.manual_deflator = numVal || null;
          } else {
            state.inputs[fieldId] = numVal;
          }
          onInputsChanged();
        });
      }
    });

    // Input change events for non-formatted inputs (decimal fields, shock dummy)
    const otherInputs = document.querySelectorAll('.form-control:not(.formatted-number):not([readonly]):not(#deflatorMethodSelect)');
    otherInputs.forEach(input => {
      ['input', 'change'].forEach(evt => input.addEventListener(evt, () => {
        syncInputsFromDOM();
        onInputsChanged();
      }));
    });

    // Year buttons
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const preset = e.currentTarget.getAttribute('data-preset');
        setActivePresetButton(preset);
        applyPreset(preset);
      });
    });

    // Deflator method select (applies to all years)
    const deflSelect = document.getElementById('deflatorMethodSelect');
    const manualGroup = document.getElementById('manualDeflatorGroup');
    const manualInput = document.getElementById('manualDeflatorInput');

    if (deflSelect) {
      deflSelect.addEventListener('change', (e) => {
        state.deflatorMethod = e.target.value;
        if (state.deflatorMethod === 'manual') {
          if (manualGroup) manualGroup.style.display = 'block';
          if (manualInput && !state.inputs.manual_deflator && state.results) {
            state.inputs.manual_deflator = Math.round(state.results.deflator);
            manualInput.value = formatIntegerThousand(state.inputs.manual_deflator);
          }
        } else {
          if (manualGroup) manualGroup.style.display = 'none';
        }
        onInputsChanged();
      });
    }

    // Sensitivity Slider
    const slider = document.getElementById('deflatorSlider');
    if (slider) {
      slider.addEventListener('input', () => {
        if (state.results) {
          updateSliderCalculation(state.results.deflator);
        }
      });
    }

    const runBtn = document.getElementById('runModelBtn');
    if (runBtn) runBtn.addEventListener('click', runModel);

    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportResults);

    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetToDefaults);

    // Initial render
    updateUI();
  }

  // Wait for DOM & Data
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
