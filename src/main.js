const PAGE_SIZE = 50;

const meta = window.FUNDING_META;
const $ = (id) => document.getElementById(id);

const controls = {
  professor: $('professor'),
  institution: $('institution'),
  department: $('department'),
  search: $('search'),
  range: $('range'),
  source: $('source'),
  state: $('state'),
  sort: $('sort'),
  newOnly: $('new-only'),
};
const TEXT_CONTROLS = [controls.professor, controls.institution, controls.department, controls.search];

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
let institutions = [];
const awards = []; // 已加载的资助；按月从新到旧加载，所以始终按日期倒序
let loadedMonths = 0;
const failedMonths = [];

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

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

function containsAll(text, words) {
  return words.every((w) => text.includes(w));
}

// ---------- 数据加载 ----------

// 字段顺序与 scripts/fetch_data.py 中 write_output 的编码对应
function decodeRow(row) {
  const [src, id, title, pis, amount, totalAmount, date, inst, dept, funder, program, type] = row;
  const source = src === 0 ? 'NIH' : 'NSF';
  const [funderAbbr, funderName] = meta.funders[funder];
  const [awardType, isNew] = meta.types[type];
  return {
    source,
    id,
    title,
    pis: pis ? pis.split('; ') : [],
    amount,
    totalAmount,
    date,
    institution: institutions[inst],
    department: meta.departments[dept],
    funder: funderAbbr,
    funderName,
    program: meta.programs[program],
    awardType,
    isNew,
    url: source === 'NIH'
      ? `https://reporter.nih.gov/project-details/${id}`
      : `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${id}`,
  };
}

// 用 <script> 而不是 fetch 加载，这样直接双击打开 index.html（file://）也能用
function loadShard(month) {
  return new Promise((resolve, reject) => {
    window.FUNDING_SHARD = (rows) => {
      for (const row of rows) awards.push(decodeRow(row));
    };
    const script = document.createElement('script');
    script.src = `data/shards/${month}.js`;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(month));
    };
    document.body.append(script);
  });
}

async function loadAllShards() {
  for (const [month] of meta.months) {
    try {
      await loadShard(month);
    } catch {
      failedMonths.push(month);
    }
    loadedMonths += 1;
    render();
  }
}

// ---------- 筛选 ----------

// 教授搜索：除了原名，再加上每个人的“名+姓”和“姓+名”连写，
// 这样 "cheng jixin"、"jixin cheng"、"chengjixin" 都能搜到 Ji-Xin Cheng
function professorText(a) {
  if (a._pi === undefined) {
    const variants = a.pis.flatMap((pi) => {
      const parts = normalize(pi).split(' ').filter((p) => p.length > 1); // 去掉中间名缩写
      if (parts.length < 2) return parts;
      const first = parts[0];
      const last = parts[parts.length - 1];
      return [first + last, last + first, `${last} ${first}`];
    });
    a._pi = normalize(a.pis.join(' ')) + ' ' + variants.join(' ');
  }
  return a._pi;
}

function keywordText(a) {
  if (a._kw === undefined) {
    a._kw = normalize([a.title, a.funder, a.funderName, a.program].join(' '));
  }
  return a._kw;
}

function departmentText(a) {
  if (a._dept === undefined) a._dept = normalize(a.department);
  return a._dept;
}

function textQuery() {
  return {
    professor: tokens(controls.professor.value),
    // 学校按整个短语匹配：否则 "boston university" 会因为 Harvard 名字里有 University 而误中
    institution: normalize(controls.institution.value),
    department: tokens(controls.department.value),
    keyword: tokens(controls.search.value),
  };
}

function hasText(q) {
  return Object.values(q).some((value) => value.length);
}

function matchesText(a, q) {
  return containsAll(professorText(a), q.professor)
    && a.institution.search.includes(q.institution)
    && containsAll(departmentText(a), q.department)
    && containsAll(keywordText(a), q.keyword);
}

function filteredAwards(q) {
  const since = daysBefore(meta.rangeEnd, Number(controls.range.value));
  const source = controls.source.value;
  const state = controls.state.value;
  const newOnly = controls.newOnly.checked;

  const result = awards.filter((a) => {
    if (a.date < since) return false;
    if (source && a.source !== source) return false;
    if (state && a.institution.state !== state) return false;
    if (newOnly && !a.isNew) return false;
    return matchesText(a, q);
  });

  if (controls.sort.value === 'amount') result.sort((a, b) => b.amount - a.amount);
  return result;
}

// ---------- 渲染 ----------

function renderStats(list) {
  const total = list.reduce((sum, a) => sum + a.amount, 0);
  const pis = new Set(list.map((a) => `${a.pis[0]}|${a.institution.name}`));
  const orgs = new Set(list.map((a) => a.institution));
  const stats = [
    ['资助项目', list.length.toLocaleString()],
    ['资助总额', compactMoney.format(total)],
    ['涉及 PI', pis.size.toLocaleString()],
    ['涉及机构', orgs.size.toLocaleString()],
  ];
  $('stats').innerHTML = stats
    .map(([label, value]) => `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`)
    .join('');
}

function orgButton(org) {
  return `<button class="org-link" data-org="${escapeHtml(org.name)}">${escapeHtml(org.name)}</button>`;
}

function place(org) {
  return [org.city, org.state].filter(Boolean).map(escapeHtml).join(', ');
}

function renderAward(a) {
  const [lead = '—', ...others] = a.pis;
  const coPis = others.length ? `<span class="co-pis"> / ${others.map(escapeHtml).join(' / ')}</span>` : '';
  const total = a.totalAmount && a.totalAmount !== a.amount
    ? `<span class="amount-note">总额 ${compactMoney.format(a.totalAmount)}</span>`
    : '';
  const details = [a.funderName || a.funder, a.program, a.department].filter(Boolean).map(escapeHtml);
  const where = place(a.institution);

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
        <p class="org">${orgButton(a.institution)}${where ? `<span class="place"> · ${where}</span>` : ''}</p>
        <p class="details">${details.join(' · ')}</p>
      </div>
      <div class="amount">
        ${a.amount ? money.format(a.amount) : '<span class="amount-note">金额未公开</span>'}
        ${total}
        <time class="date" datetime="${a.date}">${a.date}</time>
      </div>
    </li>`;
}

// 按日期排序时按月份分组成时间线；按金额排序时不分组
function renderAwardList(list) {
  if (controls.sort.value !== 'date') {
    return `<ol class="awards">${list.map(renderAward).join('')}</ol>`;
  }
  const groups = new Map();
  for (const a of list) {
    const month = a.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(a);
  }
  return [...groups].map(([month, items]) => {
    const [year, m] = month.split('-');
    return `
      <div class="group">
        <div class="group-label">${year} 年 ${Number(m)} 月</div>
        <ol class="awards">${items.map(renderAward).join('')}</ol>
      </div>`;
  }).join('');
}

function topBy(list, keyOf) {
  const totals = new Map();
  for (const a of list) {
    const key = keyOf(a);
    const entry = totals.get(key) ?? { amount: 0, count: 0, sample: a };
    entry.amount += a.amount;
    entry.count += 1;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
}

function renderLeaders(list) {
  const empty = '<li class="empty">暂无数据</li>';

  const orgs = topBy(list, (a) => a.institution);
  $('top-institutions').innerHTML = orgs.length
    ? orgs.map(({ amount, count, sample }) => `
        <li>
          <div>
            ${orgButton(sample.institution)}
            <span class="leader-amount">${compactMoney.format(amount)} · ${count.toLocaleString()} 项${sample.institution.state ? ' · ' + escapeHtml(sample.institution.state) : ''}</span>
          </div>
        </li>`).join('')
    : empty;

  const pis = topBy(list, (a) => `${a.pis[0]}|${a.institution.name}`);
  $('top-pis').innerHTML = pis.length
    ? pis.map(({ amount, count, sample }) => `
        <li>
          <div>
            <button class="pi-link" data-pi="${escapeHtml(sample.pis[0])}">${escapeHtml(sample.pis[0] ?? '—')}</button>
            <span class="leader-amount">${escapeHtml(sample.institution.name)}</span>
            <span class="leader-amount">${compactMoney.format(amount)} · ${count} 项</span>
          </div>
        </li>`).join('')
    : empty;
}

function render() {
  const q = textQuery();
  const list = filteredAwards(q);
  renderStats(list);
  renderLeaders(list);

  const loading = loadedMonths < meta.months.length;
  $('result-count').textContent = (list.length ? `${Math.min(visibleCount, list.length).toLocaleString()} / ${list.length.toLocaleString()}` : '')
    + (loading ? ` · 加载中 ${loadedMonths}/${meta.months.length}` : '');
  $('awards').innerHTML = list.length
    ? renderAwardList(list.slice(0, visibleCount))
    : `<p class="empty">${loading ? '数据加载中…' : '没有符合条件的资助，试试放宽筛选条件。'}</p>`;

  // 搜索时，如果有匹配结果被时间、类型等筛选条件挡住，提示一下
  const hidden = hasText(q) ? awards.filter((a) => matchesText(a, q)).length - list.length : 0;
  $('hint').hidden = hidden <= 0;
  $('hint-text').textContent = `另有 ${hidden.toLocaleString()} 条匹配的资助被筛选条件隐藏（如年度续拨、较早的资助、其他州）`;
  $('more').hidden = visibleCount >= list.length;
}

// ---------- 主题 ----------

// 没手动选过就跟随系统；按钮显示的是“切换到”的模式
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

// ---------- 初始化 ----------

function options(values) {
  return values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function init() {
  initTheme();

  if (!meta) {
    $('result-count').textContent = '没有找到数据，请先运行 python3 scripts/fetch_data.py';
    return;
  }

  institutions = meta.institutions.map(([name, state, city, aliases]) => ({
    name,
    state,
    city,
    // 用 | 隔开各个名字，避免短语跨名字匹配
    search: [name, ...aliases].map(normalize).join(' | '),
  }));

  const updated = new Date(meta.updatedAt).toLocaleString('zh-CN');
  $('meta').textContent = `${meta.rangeStart} — ${meta.rangeEnd} · 更新于 ${updated}`
    + (meta.errors.length ? ` · 部分来源抓取失败：${meta.errors.join('；')}` : '');

  $('institution-list').innerHTML = options([...new Set(institutions.map((i) => i.name))].sort());
  $('department-list').innerHTML = options(meta.departments.filter(Boolean).sort());
  controls.state.insertAdjacentHTML('beforeend', options([...new Set(institutions.map((i) => i.state).filter(Boolean))].sort()));

  // 输入框打字时稍等一下再筛选，避免每个字都把 7 万多条过一遍
  let timer;
  for (const control of Object.values(controls)) {
    const isText = TEXT_CONTROLS.includes(control);
    control.addEventListener('input', () => {
      visibleCount = PAGE_SIZE;
      clearTimeout(timer);
      timer = setTimeout(render, isText ? 150 : 0);
    });
  }

  $('show-all').addEventListener('click', () => {
    controls.range.value = '365';
    controls.source.value = '';
    controls.state.value = '';
    controls.newOnly.checked = false;
    visibleCount = PAGE_SIZE;
    render();
  });

  $('more').addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  // 点击 PI 或机构名，即按它筛选
  document.addEventListener('click', (event) => {
    const pi = event.target.closest('.pi-link');
    const org = event.target.closest('.org-link');
    if (!pi && !org) return;
    if (pi) controls.professor.value = pi.dataset.pi;
    if (org) controls.institution.value = org.dataset.org;
    visibleCount = PAGE_SIZE;
    render();
    $('professor').closest('section').scrollIntoView({ behavior: 'smooth' });
  });

  render();
  loadAllShards();
}

init();
