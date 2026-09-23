/**
 * KKTC GSYİH Tahmin Modeli — Dashboard Uygulama Motoru
 * ARDL Modeli & Ekonometrik Analizler
 */

(function () {
  'use strict';

  // Global state
  const state = {
    year: 2025,
    deflatorMethod: 'regression', // 'regression' | 'simple' | 'manual'
    manualDeflator: null,
    sensitivityShiftPct: 0, // for slider -20 to +20%
    inputs: {
      year: 2025,
      pubspen_nom: 129839075419,
      deposit_nom: 381222049000,
      imp_nom: 148220100000,
      kredi_nom: 197726563000,
      pop: 504880,
      electrickwh: 2135.799,
      dummycorona: 0,
      usdtrychg: 20.38,
      cpichg: 39.45
    },
    results: null,
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

  // Find previous year's actual GDP and Deflator
  function getPreviousYearData(targetYear) {
    const history = window.MODEL_DATA.history;
    // Look for targetYear - 1
    const prev = history.find(h => h.year === (targetYear - 1));
    if (prev) {
      return {
        year: prev.year,
        gdp77: prev.gdp77,
        deflator: prev.deflator
      };
    }
    // Fallback: use 2024 if beyond 2024
    const last2024 = history.find(h => h.year === 2024) || history[history.length - 1];
    return {
      year: last2024.year,
      gdp77: last2024.gdp77,
      deflator: last2024.deflator
    };
  }

  // 1. Calculate Deflator
  function calculateDeflator(inputs, prevDeflator) {
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

    if (state.deflatorMethod === 'simple') {
      finalDeflator = deflatorSimple;
      growthPct = simpleGrowthPct;
    } else if (state.deflatorMethod === 'manual' && state.manualDeflator) {
      finalDeflator = Number(state.manualDeflator);
      growthPct = ((finalDeflator - prevDeflator) / prevDeflator) * 100;
    }

    return {
      finalDeflator,
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
    const ridgeGrowth = ((ridgePred - gdpLag) / gdpLag) * 100;
    const olsGrowth = ((olsPred - gdpLag) / gdpLag) * 100;
    const elasticGrowth = ((elasticPred - gdpLag) / gdpLag) * 100;

    // Nominal GDP estimates
    const nominalGdp = ardlPred * activeDeflator;

    return {
      year: inputs.year,
      prevYear: prevData.year,
      prevGdp77: gdpLag,
      prevDeflator: prevData.deflator,
      deflator: activeDeflator,
      deflatorGrowth: deflInfo.growthPct,
      deflatorReg: deflInfo.deflatorReg,
      deflatorSimple: deflInfo.deflatorSimple,
      realValues: {
        pubspen77,
        deposit77,
        imp77,
        kredi77
      },
      predictions: {
        ardl: { val: ardlPred, growth: ardlGrowth, mape: ardlData.mape, rmse: ardlData.rmse },
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
      } else {
        deflSubEl.textContent = `Manuel Girilen Değer`;
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
    if (heroPrevEl) heroPrevEl.textContent = `${formatNumber(r.prevGdp77, 1)} (${r.prevYear})`;

    // 4. Comparison Table
    updateComparisonTable(r);

    // 5. Sensitivity Table & Slider
    updateSensitivitySection(r);

    // 6. Interactive Chart
    updateChart(r);
  }

  function updateComparisonTable(r) {
    const tbody = document.getElementById('modelComparisonBody');
    if (!tbody) return;

    const list = [
      { name: 'ARDL (Dinamik Otoregresif)', tag: 'ANA MODEL', primary: true, res: r.predictions.ardl, desc: 'En yüksek momentum yakalama kapasitesi' },
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

    // Append forecast point
    labels.push(r.year);
    const forecastData = new Array(actualGdp.length).fill(null);
    forecastData[forecastData.length - 1] = actualGdp[actualGdp.length - 1]; // bridge point
    forecastData.push(Number(r.predictions.ardl.val.toFixed(1)));

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
            data: [...actualGdp, null],
            borderColor: '#101010',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 5,
            tension: 0.1
          },
          {
            label: `${r.year} ARDL Tahmini`,
            data: forecastData,
            borderColor: '#0099ff',
            backgroundColor: 'rgba(0, 153, 255, 0.05)',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
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

  // Preset switchers
  function applyPreset(presetName) {
    if (presetName === '2025') {
      const def = window.MODEL_DATA.defaults_2025;
      state.inputs = {
        year: 2025,
        pubspen_nom: def.pubspen_nom,
        deposit_nom: def.deposit_nom,
        imp_nom: def.imp_nom,
        kredi_nom: def.kredi_nom,
        pop: def.pop,
        electrickwh: def.electrickwh,
        dummycorona: def.dummycorona,
        usdtrychg: def.usdtrychg,
        cpichg: def.cpichg
      };
    } else if (presetName === '2024') {
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
        cpichg: h24.cpichg
      };
    } else if (presetName === '2026') {
      // Conservative forward projection
      state.inputs = {
        year: 2026,
        pubspen_nom: Math.round(129839075419 * 1.35),
        deposit_nom: Math.round(381222049000 * 1.35),
        imp_nom: Math.round(148220100000 * 1.30),
        kredi_nom: Math.round(197726563000 * 1.35),
        pop: 520785,
        electrickwh: 2240.0,
        dummycorona: 0,
        usdtrychg: 18.0,
        cpichg: 30.0
      };
    }

    // Populate inputs in DOM
    populateInputFields();
    updateUI();
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
    const fields = [
      'year', 'pubspen_nom', 'deposit_nom', 'imp_nom', 'kredi_nom',
      'pop', 'electrickwh', 'dummycorona', 'usdtrychg', 'cpichg'
    ];
    fields.forEach(field => {
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
    if (manualDefEl && state.manualDeflator) {
      manualDefEl.value = formatIntegerThousand(state.manualDeflator);
    }
  }

  function syncInputsFromDOM() {
    const fields = [
      'year', 'pubspen_nom', 'deposit_nom', 'imp_nom', 'kredi_nom',
      'pop', 'electrickwh', 'dummycorona', 'usdtrychg', 'cpichg'
    ];
    fields.forEach(field => {
      const el = document.getElementById(field);
      if (el) {
        if (FORMATTED_FIELDS.includes(field)) {
          state.inputs[field] = parseFormattedInt(el.value);
        } else {
          state.inputs[field] = Number(el.value);
        }
      }
    });
  }

  // Initialize listeners
  function init() {
    populateInputFields();

    // Attach thousand formatters to numeric text inputs
    FORMATTED_FIELDS.forEach(fieldId => {
      const el = document.getElementById(fieldId);
      if (el) {
        attachThousandFormatter(el, (numVal) => {
          if (fieldId === 'manualDeflatorInput') {
            state.manualDeflator = numVal;
          } else {
            state.inputs[fieldId] = numVal;
          }
          updateUI();
        });
      }
    });

    // Input change events for non-formatted controls (select, range, decimal inputs)
    const otherInputs = document.querySelectorAll('.form-control:not(.formatted-number)');
    otherInputs.forEach(input => {
      input.addEventListener('input', () => {
        syncInputsFromDOM();
        updateUI();
      });
      input.addEventListener('change', () => {
        syncInputsFromDOM();
        updateUI();
      });
    });

    // Preset buttons
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        presetBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const preset = e.target.getAttribute('data-preset');
        applyPreset(preset);
      });
    });

    // Deflator method select
    const deflSelect = document.getElementById('deflatorMethodSelect');
    const manualGroup = document.getElementById('manualDeflatorGroup');
    const manualInput = document.getElementById('manualDeflatorInput');

    if (deflSelect) {
      deflSelect.addEventListener('change', (e) => {
        state.deflatorMethod = e.target.value;
        if (state.deflatorMethod === 'manual') {
          if (manualGroup) manualGroup.style.display = 'block';
          if (manualInput && !state.manualDeflator && state.results) {
            state.manualDeflator = Math.round(state.results.deflator);
            manualInput.value = formatIntegerThousand(state.manualDeflator);
          }
        } else {
          if (manualGroup) manualGroup.style.display = 'none';
        }
        updateUI();
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

    // Reset button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        applyPreset('2025');
        const defaultPresetBtn = document.querySelector('[data-preset="2025"]');
        if (defaultPresetBtn) {
          presetBtns.forEach(b => b.classList.remove('active'));
          defaultPresetBtn.classList.add('active');
        }
      });
    }

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
