# BU 科研资助追踪

跟踪波士顿大学（Boston University）研究人员近期获得的 NIH 和 NSF 资助。

纯 HTML / CSS / JavaScript + 一个 Python 抓取脚本，不需要安装任何依赖。

## 使用

1. 抓取最新数据（默认最近 365 天）：

   ```bash
   python3 scripts/fetch_data.py
   # 或指定天数
   python3 scripts/fetch_data.py --days 90
   ```

2. 直接用浏览器打开 `index.html`。

## 数据来源

| 来源 | 接口 | 说明 |
| --- | --- | --- |
| NIH | [RePORTER API](https://api.reporter.nih.gov/) | 按 award notice date 查询，只保留机构名含 "Boston University" 的记录（医学院区 + Charles River 校区） |
| NSF | [Awards API](https://resources.research.gov/common/webapi/awardapisearch-v1.htm) | 按首次授予日期查询，受资助方为 Trustees of Boston University |

注意：

- NIH 的多年期项目每年都会有一次“年度续拨”（award type 5）。网页默认勾选“只看新拿到的资助”，只显示**新项目**和**竞争性续期**。
- 金额是本次拨付的金额。NSF 项目另外显示预计总额。
- PI 不一定都是教授，也包括研究员等。

## 目录结构

```
index.html              页面
src/main.js             筛选、排序、渲染
src/style.css           样式
scripts/fetch_data.py   抓取 NIH / NSF 数据
data/awards.js          抓取结果（由脚本生成）
```
