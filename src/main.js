const PAGE_SIZE = 50;

const data = window.AWARDS_DATA;
const $ = (id) => document.getElementById(id);

const controls = {
  search: $('search'),
  range: $('range'),
  source: $('source'),
  department: $('department'),
  sort: $('sort'),
  newOnly: $('new-only'),
};

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

let visibleCount = PAGE_SIZE;

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function daysBefore(isoDate, days) {
  const d = new Date(isoDate); // 'YYYY-MM-DD' 按 UTC 解析
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// 小写、去掉连字符和撇号（Ji-Xin -> jixin，O'Brien -> obrien），其他标点变空格
function normalize(text) {
  return text.toLowerCase().replace(/[-'’.]/g, '').replace(/[^\p{L}\p{N}$]+/gu, ' ').trim();
}

// 搜索索引：除了原名，再加上每个 PI 的“名+姓”和“姓+名”连写，
// 这样 "cheng jixin"、"jixin cheng"、"chengjixin" 都能搜到 Ji-Xin Cheng
function searchText(a) {
  if (!a._search) {
    const nameVariants = a.pis.flatMap((pi) => {
      const parts = normalize(pi).split(' ').filter((p) => p.length > 1); // 去掉中间名缩写
      if (parts.length < 2) return parts;
      const first = parts[0];
      const last = parts[parts.length - 1];
      return [first + last, last + first, `${last} ${first}`];
    });
    a._search = normalize([a.title, a.funder, a.funderName, a.program, a.department, ...a.pis].join(' '))
      + ' ' + nameVariants.join(' ');
  }
  return a._search;
}

function matchesQuery(a, tokens) {
  const text = searchText(a);
  return tokens.every((t) => text.includes(t));
}

function queryTokens() {
  return normalize(controls.search.value).split(' ').filter(Boolean);
}

function filteredAwards() {
  const tokens = queryTokens();
  const since = daysBefore(data.rangeEnd, Number(controls.range.value));
  const source = controls.source.value;
  const department = controls.department.value;

  const awards = data.awards.filter((a) => {
    if (a.date < since) return false;
    if (source && a.source !== source) return false;
    if (department && a.department !== department) return false;
    if (controls.newOnly.checked && !a.isNew) return false;
    return matchesQuery(a, tokens);
  });

  if (controls.sort.value === 'amount') {
    awards.sort((a, b) => b.amount - a.amount);
  } else {
    awards.sort((a, b) => b.date.localeCompare(a.date));
  }
  return awards;
}

function renderStats(awards) {
  const total = awards.reduce((sum, a) => sum + a.amount, 0);
  const pis = new Set(awards.map((a) => a.pis[0]));
  const stats = [
    ['资助项目', awards.length.toLocaleString()],
    ['资助总额', compactMoney.format(total)],
    ['涉及 PI', pis.size.toLocaleString()],
  ];
  $('stats').innerHTML = stats
    .map(([label, value]) => `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`)
    .join('');
}

function renderAward(a) {
  const [lead, ...others] = a.pis;
  const coPis = others.length ? `<span class="co-pis"> / ${others.map(escapeHtml).join(' / ')}</span>` : '';
  const total = a.totalAmount && a.totalAmount !== a.amount
    ? `<span class="amount-note">总额 ${compactMoney.format(a.totalAmount)}</span>`
    : '';
  const details = [a.funderName || a.funder, a.program, a.department].filter(Boolean).map(escapeHtml);

  return `
    <li class="award">
      <span class="award-marker"></span>
      <div class="award-main">
        <a class="award-title" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
        <div class="tags">
          <span class="tag">${a.source}${a.source === 'NIH' ? ' · ' + escapeHtml(a.funder) : ''}</span>
          <span class="tag ${a.isNew ? 'tag-new' : ''}">${escapeHtml(a.awardType)}</span>
        </div>
        <p class="pis"><button class="pi-link" data-pi="${escapeHtml(lead)}">${escapeHtml(lead)}</button>${coPis}</p>
        <p class="details">${details.join(' · ')}</p>
      </div>
      <div class="amount">
        ${money.format(a.amount)}
        ${total}
        <time class="date" datetime="${a.date}">${a.date}</time>
      </div>
    </li>`;
}

// 按日期排序时按月份分组成时间线；按金额排序时不分组
function renderAwardList(awards) {
  if (controls.sort.value !== 'date') {
    return `<ol class="awards">${awards.map(renderAward).join('')}</ol>`;
  }
  const groups = new Map();
  for (const a of awards) {
    const month = a.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(a);
  }
  return [...groups].map(([month, items]) => {
    const [year, m] = month.split('-');
    return `
      <div class="group">
        <div class="group-label">${year} 年 ${Number(m)} 月 · ${items.length}</div>
        <ol class="awards">${items.map(renderAward).join('')}</ol>
      </div>`;
  }).join('');
}

function renderLeaders(awards) {
  const byPi = new Map();
  for (const a of awards) {
    const pi = a.pis[0];
    const entry = byPi.get(pi) ?? { amount: 0, count: 0 };
    entry.amount += a.amount;
    entry.count += 1;
    byPi.set(pi, entry);
  }
  const top = [...byPi].sort((a, b) => b[1].amount - a[1].amount).slice(0, 10);
  $('leaders').innerHTML = top.length
    ? top.map(([pi, { amount, count }]) => `
        <li>
          <div>
            <button class="pi-link" data-pi="${escapeHtml(pi)}">${escapeHtml(pi)}</button>
            <span class="leader-amount">${compactMoney.format(amount)} · ${count} 项</span>
          </div>
        </li>`).join('')
    : '<li class="empty">暂无数据</li>';
}

function render() {
  const awards = filteredAwards();
  renderStats(awards);
  renderLeaders(awards);

  $('result-count').textContent = awards.length
    ? `${Math.min(visibleCount, awards.length)} / ${awards.length}`
    : '';
  $('awards').innerHTML = awards.length
    ? renderAwardList(awards.slice(0, visibleCount))
    : '<p class="empty">没有符合条件的资助，试试放宽筛选条件。</p>';

  // 搜索时，如果有匹配结果被时间、类型等筛选条件挡住，提示一下
  const tokens = queryTokens();
  const hidden = tokens.length
    ? data.awards.filter((a) => matchesQuery(a, tokens)).length - awards.length
    : 0;
  $('hint').hidden = hidden <= 0;
  $('hint-text').textContent = `另有 ${hidden} 条匹配的资助被筛选条件隐藏（如年度续拨、较早的资助）`;
  $('more').hidden = visibleCount >= awards.length;
}

// 主题：没手动选过就跟随系统；按钮显示的是“切换到”的模式
const systemLight = window.matchMedia('(prefers-color-scheme: light)');

function currentTheme() {
  return document.documentElement.dataset.theme || (systemLight.matches ? 'light' : 'dark');
}

function updateThemeToggle() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  $('theme-toggle').textContent = next;
  $('theme-toggle').setAttribute('aria-label', next === 'light' ? '切换到亮色模式' : '切换到暗色模式');
}

function initTheme() {
  $('theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    updateThemeToggle();
  });
  systemLight.addEventListener('change', updateThemeToggle);
  updateThemeToggle();
}

function init() {
  initTheme();

  if (!data) {
    $('result-count').textContent = '没有找到数据，请先运行 python3 scripts/fetch_data.py';
    return;
  }

  const updated = new Date(data.updatedAt).toLocaleString('zh-CN');
  $('meta').textContent = `${data.rangeStart} — ${data.rangeEnd} · 更新于 ${updated}`
    + (data.errors.length ? ` · 部分来源抓取失败：${data.errors.join('；')}` : '');

  const departments = [...new Set(data.awards.map((a) => a.department).filter(Boolean))].sort();
  controls.department.insertAdjacentHTML(
    'beforeend',
    departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join(''),
  );

  for (const control of Object.values(controls)) {
    control.addEventListener('input', () => {
      visibleCount = PAGE_SIZE;
      render();
    });
  }

  $('show-all').addEventListener('click', () => {
    controls.range.value = '365';
    controls.source.value = '';
    controls.department.value = '';
    controls.newOnly.checked = false;
    visibleCount = PAGE_SIZE;
    render();
  });

  $('more').addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  // 点击 PI 名字即按该 PI 搜索
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.pi-link');
    if (!button) return;
    controls.search.value = button.dataset.pi;
    visibleCount = PAGE_SIZE;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  render();
}

init();
