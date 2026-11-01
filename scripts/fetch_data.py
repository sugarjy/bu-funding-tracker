#!/usr/bin/env python3
"""从 NIH RePORTER 和 NSF Awards API 抓取波士顿大学（BU）近期获得的资助，
写入 data/awards.js，供 index.html 直接读取。

用法：
    python3 scripts/fetch_data.py            # 默认抓取最近 365 天
    python3 scripts/fetch_data.py --days 90
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "awards.js"

NIH_URL = "https://api.reporter.nih.gov/v2/projects/search"
NIH_PAGE_SIZE = 500
NIH_FIELDS = [
    "ApplId", "ProjectNum", "ProjectTitle", "AwardAmount", "AwardNoticeDate",
    "ProjectStartDate", "ProjectEndDate", "Organization", "PrincipalInvestigators",
    "AgencyIcAdmin", "ActivityCode", "AwardType", "ProjectDetailUrl",
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

NSF_URL = "https://api.nsf.gov/services/v1/awards.json"
NSF_PAGE_SIZE = 25
NSF_FIELDS = [
    "id", "title", "piFirstName", "piLastName", "coPDPI", "awardeeName",
    "fundsObligatedAmt", "estimatedTotalAmt", "date", "startDate", "expDate",
    "fundProgramName", "orgLongName", "orgLongName2", "transType",
]


def request_json(url, payload=None, retries=3):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "bu-funding-tracker"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except Exception as exc:
            if attempt == retries - 1:
                raise
            print(f"  请求失败（{exc}），重试中…", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def clean_name(name):
    """'SAM  LING' -> 'Sam Ling'；保留本来就是大小写混合的名字。"""
    name = re.sub(r"\s+", " ", name or "").strip()
    if name.isupper():
        name = name.title()
    return name


def is_bu(org_name):
    # NIH 的机构名是模糊匹配，会混入 Tufts、UMass Boston 等
    return "BOSTON UNIVERSITY" in (org_name or "").upper()


def nih_date(value):
    return value[:10] if value else None


def us_date(value):
    """NSF 的 'MM/DD/YYYY' -> 'YYYY-MM-DD'"""
    return datetime.strptime(value, "%m/%d/%Y").date().isoformat() if value else None


def fetch_nih(start, end):
    awards = []
    offset = 0
    while True:
        payload = {
            "criteria": {
                "org_names": ["BOSTON UNIVERSITY"],
                "award_notice_date": {"from_date": start.isoformat(), "to_date": end.isoformat()},
            },
            "include_fields": NIH_FIELDS,
            "offset": offset,
            "limit": NIH_PAGE_SIZE,
            "sort_field": "award_notice_date",
            "sort_order": "desc",
        }
        data = request_json(NIH_URL, payload)
        results = data.get("results") or []
        for r in results:
            org = r.get("organization") or {}
            if not is_bu(org.get("org_name")):
                continue
            pis = r.get("principal_investigators") or []
            pis.sort(key=lambda p: not p.get("is_contact_pi"))  # 联系人 PI 排第一
            agency = r.get("agency_ic_admin") or {}
            awards.append({
                "id": f"nih-{r['appl_id']}",
                "source": "NIH",
                "title": r.get("project_title") or "",
                "pis": [clean_name(p.get("full_name")) for p in pis],
                "amount": r.get("award_amount") or 0,
                "date": nih_date(r.get("award_notice_date")),
                "start": nih_date(r.get("project_start_date")),
                "end": nih_date(r.get("project_end_date")),
                "funder": agency.get("abbreviation") or "NIH",
                "funderName": agency.get("name") or "",
                "program": r.get("activity_code") or "",
                "department": (org.get("dept_type") or "").title(),
                "campus": org.get("org_name") or "",
                "awardType": NIH_AWARD_TYPES.get((r.get("award_type") or "")[:1], "其他"),
                # 新项目和竞争性续期都要重新评审，算作“新拿到的”资助
                "isNew": (r.get("award_type") or "")[:1] in ("1", "2"),
                "url": r.get("project_detail_url") or "",
            })
        total = data["meta"]["total"]
        offset += NIH_PAGE_SIZE
        print(f"  NIH：已读取 {min(offset, total)}/{total}")
        if offset >= total or not results:
            break
    return awards


def fetch_nsf(start, end):
    awards = []
    offset = 0
    while True:
        params = {
            "awardeeName": '"Boston University"',
            "dateStart": start.strftime("%m/%d/%Y"),
            "dateEnd": end.strftime("%m/%d/%Y"),
            "rpp": NSF_PAGE_SIZE,
            "offset": offset,
            "printFields": ",".join(NSF_FIELDS),
        }
        data = request_json(f"{NSF_URL}?{urllib.parse.urlencode(params)}")
        results = data.get("response", {}).get("award") or []
        for r in results:
            if not is_bu(r.get("awardeeName")):
                continue
            # coPDPI 形如 'Eli Tucker-Raymond etuckerr@bu.edu'，去掉邮箱
            co_pis = [re.sub(r"\s+\S+@\S+$", "", c) for c in r.get("coPDPI") or []]
            pi = clean_name(f"{r.get('piFirstName', '')} {r.get('piLastName', '')}")
            awards.append({
                "id": f"nsf-{r['id']}",
                "source": "NSF",
                "title": r.get("title") or "",
                "pis": [pi] + [clean_name(c) for c in co_pis],
                "amount": int(float(r.get("fundsObligatedAmt") or 0)),
                "totalAmount": int(float(r.get("estimatedTotalAmt") or 0)),
                "date": us_date(r.get("date")),
                "start": us_date(r.get("startDate")),
                "end": us_date(r.get("expDate")),
                "funder": "NSF",
                "funderName": r.get("orgLongName2") or r.get("orgLongName") or "",
                "program": r.get("fundProgramName") or "",
                "department": "",
                "campus": r.get("awardeeName") or "",
                # NSF 接口按首次授予日期查询，结果都是新项目
                "awardType": "新项目",
                "isNew": True,
                "url": f"https://www.nsf.gov/awardsearch/showAward?AWD_ID={r['id']}",
            })
        print(f"  NSF：已读取 {offset + len(results)} 条")
        if len(results) < NSF_PAGE_SIZE:
            break
        offset += NSF_PAGE_SIZE
    return awards


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=365, help="抓取最近多少天的资助（默认 365）")
    args = parser.parse_args()

    end = date.today()
    start = end - timedelta(days=args.days)
    print(f"抓取 {start} 至 {end} 的资助数据…")

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

    awards.sort(key=lambda a: a["date"] or "", reverse=True)
    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rangeStart": start.isoformat(),
        "rangeEnd": end.isoformat(),
        "errors": errors,
        "awards": awards,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # 写成 JS 而不是 JSON，这样直接双击打开 index.html 也能加载（file:// 下不能 fetch）
    OUTPUT.write_text("window.AWARDS_DATA = " + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    print(f"完成：共 {len(awards)} 条，已写入 {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
