#!/usr/bin/env python3
"""从 NIH RePORTER 和 NSF Awards API 抓取全美近期的科研资助，
按月写入 data/shards/YYYY-MM.js，公共字典写入 data/meta.js，供 index.html 读取。

用法：
    python3 scripts/fetch_data.py            # 默认抓取最近 365 天
    python3 scripts/fetch_data.py --days 90

全美一年约 7–8 万条，抓取需要几分钟（NIH 要求每秒不超过一次请求）。
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SHARD_DIR = DATA_DIR / "shards"

NIH_URL = "https://api.reporter.nih.gov/v2/projects/search"
NIH_PAGE_SIZE = 500
NIH_MAX_RESULTS = 14000  # 单次查询 offset + limit 不能超过 15000，留点余量
NIH_FIELDS = [
    "ApplId", "SubprojectId", "ProjectNum", "ProjectTitle", "AwardAmount",
    "AwardNoticeDate", "Organization", "PrincipalInvestigators", "AgencyIcAdmin",
    "ActivityCode", "AwardType",
]

# NIH 的 is_new 字段不可靠（总是 false），改用 award_type 判断
# https://grants.nih.gov/grants/how-to-apply-application-guide/prepare-to-apply-and-register/type-of-applications.htm
NIH_AWARD_TYPES = {
    "1": "新项目",
    "2": "竞争性续期",
    "3": "补充资助",
    "4": "延期",
    "5": "年度续拨",
    "6": "变更机构",
    "7": "变更受资助方",
    "8": "变更机构",
    "9": "变更 NIH 所属机构",
}
NEW_TYPES = {"新项目", "竞争性续期"}  # 都要重新评审，算作“新拿到的”资助

# NSF 接口会忽略 printFields，总是返回全部字段（含摘要），这里只取需要的
NSF_URL = "https://api.nsf.gov/services/v1/awards.json"
NSF_PAGE_SIZE = 1000  # 最大 1000

SMALL_WORDS = {"of", "and", "the", "for", "at", "in", "on", "de", "la"}


def request_json(url, payload=None, retries=4):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "us-funding-tracker"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.load(resp)
        except Exception as exc:
            if attempt == retries - 1:
                raise
            print(f"  请求失败（{exc}），重试中…", file=sys.stderr)
            time.sleep(5 * (attempt + 1))


def clean_name(name):
    """'SAM  LING' -> 'Sam Ling'；保留本来就是大小写混合的名字。"""
    name = re.sub(r"\s+", " ", name or "").strip()
    if name.isupper():
        name = name.title()
    return name


def clean_org(name):
    """'UNIVERSITY OF MICHIGAN AT ANN ARBOR' -> 'University of Michigan at Ann Arbor'"""
    name = re.sub(r"\s+", " ", name or "").strip()
    if not name.isupper():
        return name
    words = name.title().split(" ")
    return " ".join(w.lower() if i and w.lower() in SMALL_WORDS else w for i, w in enumerate(words))


def us_date(value):
    """NSF 的 'MM/DD/YYYY' -> 'YYYY-MM-DD'"""
    return datetime.strptime(value, "%m/%d/%Y").date().isoformat() if value else None


def month_windows(start, end):
    """把 [start, end] 切成按自然月的区间，最新的在前。"""
    windows = []
    cur = end
    while cur >= start:
        first = max(cur.replace(day=1), start)
        windows.append((first, cur))
        cur = first - timedelta(days=1)
    return windows


# ---------- NIH ----------

def nih_query(start, end, offset, limit, fields=NIH_FIELDS):
    payload = {
        "criteria": {"award_notice_date": {"from_date": start.isoformat(), "to_date": end.isoformat()}},
        "include_fields": fields,
        "offset": offset,
        "limit": limit,
        # 按 appl_id 排序：按日期排序时同一天的记录顺序不固定，分页会重复和遗漏
        "sort_field": "appl_id",
        "sort_order": "desc",
    }
    data = request_json(NIH_URL, payload)
    time.sleep(1)  # NIH 要求每秒不超过一次请求
    return data


def nih_windows(start, end):
    """结果超过单次查询上限时，把日期区间对半拆开。"""
    total = nih_query(start, end, 0, 1, ["ApplId"])["meta"]["total"]
    if total <= NIH_MAX_RESULTS or start == end:
        return [(start, end, total)]
    mid = start + (end - start) // 2
    return nih_windows(mid + timedelta(days=1), end) + nih_windows(start, mid)


def fetch_nih(start, end):
    parents = {}
    subprojects = {}
    expected = 0
    for month_start, month_end in month_windows(start, end):
        for w_start, w_end, total in nih_windows(month_start, month_end):
            expected += total
            for offset in range(0, total, NIH_PAGE_SIZE):
                results = nih_query(w_start, w_end, offset, NIH_PAGE_SIZE).get("results") or []
                for r in results:
                    if r.get("subproject_id"):
                        subprojects[r["appl_id"]] = r
                    else:
                        parents[r["appl_id"]] = r
            print(f"  NIH {w_start} ~ {w_end}：{total} 条")

    # 子项目的金额已包含在母项目里，不单独计入；只把子项目负责人并入母项目，方便搜索
    by_project_num = {r.get("project_num"): r for r in parents.values()}
    fetched = len(parents) + len(subprojects)
    if fetched != expected:
        print(f"  警告：NIH 接口报告 {expected} 条，实际取到 {fetched} 条", file=sys.stderr)
    for sub in subprojects.values():
        parent = by_project_num.get(sub.get("project_num"))
        if parent:
            parent.setdefault("_sub_pis", []).extend(sub.get("principal_investigators") or [])

    awards = []
    for r in parents.values():
        org = r.get("organization") or {}
        pis = sorted(r.get("principal_investigators") or [], key=lambda p: not p.get("is_contact_pi"))
        names = []
        for p in pis + r.get("_sub_pis", []):
            name = clean_name(p.get("full_name"))
            if name and name not in names:
                names.append(name)
        agency = r.get("agency_ic_admin") or {}
        award_type = NIH_AWARD_TYPES.get((r.get("award_type") or "")[:1], "其他")
        awards.append({
            "source": "NIH",
            "id": str(r["appl_id"]),
            "title": r.get("project_title") or "",
            "pis": names,
            "amount": r.get("award_amount") or 0,
            "totalAmount": 0,
            "date": (r.get("award_notice_date") or "")[:10],
            "orgName": org.get("org_name") or "",
            "orgUei": org.get("primary_uei") or "",
            "orgState": org.get("org_state") or "",
            "orgCity": org.get("org_city") or "",
            "department": (org.get("dept_type") or "").title(),
            "funder": agency.get("abbreviation") or "NIH",
            "funderName": agency.get("name") or "",
            "program": r.get("activity_code") or "",
            "awardType": award_type,
        })
    print(f"  NIH 合计 {len(awards)} 条（另有 {len(subprojects)} 个子项目并入母项目）")
    return awards


# ---------- NSF ----------

def fetch_nsf(start, end):
    """按天抓取：NSF 分页时结果顺序不固定，跨页会重复和遗漏；
    一天最多两三百条，每页 1000 条基本一次取完。"""
    awards = {}
    day = end
    while day >= start:
        offset = 0
        while True:
            params = {
                "dateStart": day.strftime("%m/%d/%Y"),
                "dateEnd": day.strftime("%m/%d/%Y"),
                "rpp": NSF_PAGE_SIZE,
                "offset": offset,  # NSF 的 offset 从 0 开始
            }
            data = request_json(f"{NSF_URL}?{urllib.parse.urlencode(params)}")
            results = data.get("response", {}).get("award") or []
            for r in results:
                # coPDPI 形如 'Eli Tucker-Raymond etuckerr@bu.edu'，去掉邮箱
                co_pis = [re.sub(r"\s+\S+@\S+$", "", c) for c in r.get("coPDPI") or []]
                pi = clean_name(f"{r.get('piFirstName', '')} {r.get('piLastName', '')}")
                awards[r["id"]] = {
                    "source": "NSF",
                    "id": r["id"],
                    "title": r.get("title") or "",
                    "pis": [n for n in [pi] + [clean_name(c) for c in co_pis] if n],
                    "amount": int(float(r.get("fundsObligatedAmt") or 0)),
                    "totalAmount": int(float(r.get("estimatedTotalAmt") or 0)),
                    "date": us_date(r.get("date")),
                    "orgName": r.get("awardeeName") or "",
                    "orgUei": r.get("ueiNumber") or "",
                    "orgState": r.get("awardeeStateCode") or "",
                    "orgCity": (r.get("awardeeCity") or "").upper(),
                    "department": "",
                    "funder": "NSF",
                    "funderName": r.get("orgLongName2") or r.get("orgLongName") or "",
                    "program": r.get("fundProgramName") or "",
                    # NSF 接口按首次授予日期查询，结果都是新项目
                    "awardType": "新项目",
                }
            offset += len(results)
            time.sleep(0.2)
            if len(results) < NSF_PAGE_SIZE:
                break
        if day.day == 1 or day == start:
            print(f"  NSF 已抓到 {day}，累计 {len(awards)} 条")
        day -= timedelta(days=1)
    return list(awards.values())


# ---------- 输出 ----------

class Dictionary:
    """把重复出现的字符串编成下标，减小数据文件体积。"""

    def __init__(self):
        self.items = []
        self.index = {}

    def get(self, key, value=None):
        if key not in self.index:
            self.index[key] = len(self.items)
            self.items.append(value if value is not None else key)
        return self.index[key]


def build_institutions(awards):
    """用 UEI 合并同一机构在 NIH / NSF 中的不同名称；没有 UEI 的按名称合并。"""
    names = defaultdict(Counter)
    places = {}
    for a in awards:
        key = a["orgUei"] or a["orgName"].upper()
        a["orgKey"] = key
        names[key][clean_org(a["orgName"])] += 1
        if a["orgState"] and key not in places:
            places[key] = (a["orgState"], clean_org(a["orgCity"]))

    institutions = Dictionary()
    for key, counter in names.items():
        display = counter.most_common(1)[0][0]
        aliases = [n for n in counter if n != display]
        state, city = places.get(key, ("", ""))
        institutions.get(key, [display, state, city, aliases])
    return institutions


def write_js(path, var_call, payload):
    path.write_text(f"{var_call}({json.dumps(payload, ensure_ascii=False, separators=(',', ':'))});\n", encoding="utf-8")


def write_output(awards, start, end, errors):
    institutions = build_institutions(awards)
    departments = Dictionary()
    funders = Dictionary()
    programs = Dictionary()
    types = Dictionary()
    departments.get("")

    by_month = defaultdict(list)
    for a in sorted(awards, key=lambda a: (a["date"], a["amount"]), reverse=True):
        # 每条资助编码成一个数组，字段顺序与 src/main.js 中 decodeRow 对应
        by_month[a["date"][:7]].append([
            0 if a["source"] == "NIH" else 1,
            a["id"],
            a["title"],
            "; ".join(a["pis"]),
            a["amount"],
            a["totalAmount"],
            a["date"],
            institutions.index[a["orgKey"]],
            departments.get(a["department"]),
            funders.get(a["funder"] + "|" + a["funderName"], [a["funder"], a["funderName"]]),
            programs.get(a["program"]),
            types.get(a["awardType"], [a["awardType"], a["awardType"] in NEW_TYPES]),
        ])

    SHARD_DIR.mkdir(parents=True, exist_ok=True)
    for old in SHARD_DIR.glob("*.js"):
        old.unlink()
    months = []
    for month in sorted(by_month, reverse=True):
        write_js(SHARD_DIR / f"{month}.js", f"window.FUNDING_SHARD&&FUNDING_SHARD", by_month[month])
        months.append([month, len(by_month[month])])

    meta = {
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rangeStart": start.isoformat(),
        "rangeEnd": end.isoformat(),
        "errors": errors,
        "months": months,
        "institutions": institutions.items,
        "departments": departments.items,
        "funders": funders.items,
        "programs": programs.items,
        "types": types.items,
    }
    # 写成 JS 而不是 JSON，这样直接双击打开 index.html 也能加载（file:// 下不能 fetch）
    (DATA_DIR / "meta.js").write_text(
        "window.FUNDING_META = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    size = sum(p.stat().st_size for p in SHARD_DIR.glob("*.js")) + (DATA_DIR / "meta.js").stat().st_size
    print(f"完成：{len(awards)} 条，{len(institutions.items)} 个机构，{len(months)} 个月份文件，共 {size / 1e6:.1f} MB")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=365, help="抓取最近多少天的资助（默认 365）")
    args = parser.parse_args()

    end = date.today()
    start = end - timedelta(days=args.days)
    print(f"抓取 {start} 至 {end} 的全美资助数据…")

    awards = []
    errors = []
    for name, fetch in (("NIH", fetch_nih), ("NSF", fetch_nsf)):
        try:
            awards += fetch(start, end)
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            print(f"  {name} 抓取失败：{exc}", file=sys.stderr)

    if not awards:
        sys.exit("没有抓到任何数据，保留原有数据文件不变。")

    write_output([a for a in awards if a["date"]], start, end, errors)


if __name__ == "__main__":
    main()
