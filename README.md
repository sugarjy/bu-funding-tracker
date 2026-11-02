# 美国科研资助追踪

跟踪全美高校与研究机构近期获得的 NIH 和 NSF 资助，可按教授、学校、院系、州查找。

纯 HTML / CSS / JavaScript + 一个 Python 抓取脚本，不需要安装任何依赖。

线上地址：https://sugarjy.github.io/bu-funding-tracker/

## 使用

1. 抓取最新数据（默认最近 365 天，全美约 7–8 万条，需要几分钟）：

   ```bash
   python3 scripts/fetch_data.py
   # 或指定天数
   python3 scripts/fetch_data.py --days 90
   ```

2. 直接用浏览器打开 `index.html`。

3. 上线：提交并推送，GitHub Pages 约一分钟后更新。

   ```bash
   git add -A data && git commit -m "更新数据" && git push
   ```

## 数据来源

| 来源 | 接口 | 说明 |
| --- | --- | --- |
| NIH | [RePORTER API](https://api.reporter.nih.gov/) | 按 award notice date 查询，包括新项目、竞争性续期、年度续拨、补充资助等全部类型 |
| NSF | [Awards API](https://resources.research.gov/common/webapi/awardapisearch-v1.htm) | 按首次授予日期查询 |

注意：

- 网页默认勾选“只看新拿到的资助”，只显示**新项目**和**竞争性续期**；取消勾选可看到年度续拨等全部记录。
- NIH 大型项目（P01、U54 等）的子项目金额已包含在母项目中，所以不单独计入；子项目负责人并入母项目，搜索时能找到。
- 同一机构在 NIH 和 NSF 中名称不同（如 "Boston University Medical Campus" / "Trustees of Boston University"），用机构 UEI 合并，两边的名字都能搜到。
- “院系”只有 NIH 提供，且是 NIH 的大类（如 Internal Medicine/Medicine），NSF 记录没有院系。
- 金额是本次拨付的金额。NSF 项目另外显示预计总额。PI 不一定都是教授。

## 数据格式

数据按月拆分，网页打开后从最新月份开始依次加载：

```
data/meta.js            更新时间、月份列表，以及机构、资助方、项目类型等公共字典
data/shards/YYYY-MM.js  每月的资助记录，每条是一个数组（字段顺序见 fetch_data.py 的 write_output）
```

## 目录结构

```
index.html              页面
src/main.js             加载数据、筛选、排序、渲染
src/style.css           样式（暗色 / 亮色主题）
scripts/fetch_data.py   抓取 NIH / NSF 数据
data/                   抓取结果（由脚本生成）
```
