#!/usr/bin/env python3
"""
池上自動車教習所 予約システム — 空位监控（无人值守版）

本地:
    python monitor.py --once
    python monitor.py --weeks 4 --interval 900

云端（GitHub Actions 等）:
    python monitor.py --once --state state.json

⚠️ 单一会话制约：本脚本运行时会踢掉浏览器里的登录，反之亦然。
⚠️ 绝不重复提交同一请求（等同于按 F5），会触发 EC05。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

# ── 常量 ────────────────────────────────────────────

BASE = "https://www.e-license.jp"
LOGIN_URL = f"{BASE}/el32/pc/login"
RESERV_URL = f"{BASE}/el32/pc/reserv/p03/p03a"
NEXT_WEEK_URL = f"{RESERV_URL}/nextWeek"

JST = ZoneInfo("Asia/Tokyo")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 时限号 → 时刻。见 README §3
ZIGEN_TIME = {
    1: "9:00", 2: "10:00", 3: "11:00", 4: "12:00",
    5: "13:00", 6: "14:00", 7: "15:00", 8: "16:00",
    9: "17:00", 10: "18:00", 11: "19:00", 12: "20:00",
}


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def env_int_list(name: str, default: list[int]) -> list[int]:
    raw = env(name)
    if not raw:
        return default
    return [int(x) for x in re.split(r"[,\s]+", raw) if x.strip().isdigit()]


# ── 筛选条件（可用环境变量覆盖）────────────────────

# 平日只看这几限。11 = 19:00，12 = 20:00
WEEKDAY_ZIGEN = env_int_list("IKEGAMI_WEEKDAY_ZIGEN", [11, 12])
# 周末看哪几限，空 = 全天
WEEKEND_ZIGEN = env_int_list("IKEGAMI_WEEKEND_ZIGEN", [])
# 全天监控区间 "20260808-20260816,20261228-20270103"
FULL_DAY_RANGES = [
    tuple(seg.split("-", 1))
    for seg in re.split(r"[,\s]+", env("IKEGAMI_FULLDAY", "20260808-20260816"))
    if "-" in seg
]

# 静默时段（JST）。默认 0:00–7:00 不运行、不通知
QUIET_FROM = int(env("IKEGAMI_QUIET_FROM", "0"))
QUIET_TO = int(env("IKEGAMI_QUIET_TO", "7"))


class SessionKilled(Exception):
    """遇到 EC05 —— 会话已失效，必须停止"""


@dataclass(frozen=True)
class Slot:
    date: str      # YYYYMMDD
    zigen: int     # 1-12
    time: str      # HH:MM
    week: str      # (月) 等

    @property
    def key(self) -> str:
        return f"{self.date}-{self.zigen}"

    @property
    def is_weekend(self) -> bool:
        return bool(re.search(r"[土日]", self.week))

    @property
    def in_full_day(self) -> bool:
        return any(a <= self.date <= b for a, b in FULL_DAY_RANGES)

    @property
    def wanted(self) -> bool:
        """优先级：全天区间 > 周末规则 > 平日规则"""
        if self.in_full_day:
            return True
        if self.is_weekend:
            return not WEEKEND_ZIGEN or self.zigen in WEEKEND_ZIGEN
        return self.zigen in WEEKDAY_ZIGEN

    def pretty(self) -> str:
        d = self.date
        s = f"{d[4:6]}/{d[6:]}{self.week} {self.time}"
        return s + (" ◎" if self.in_full_day else "")


# ── 静默时段 ────────────────────────────────────────

def now_jst() -> datetime:
    return datetime.now(JST)


def in_quiet_hours(t: datetime | None = None) -> bool:
    """日本时间的静默时段内返回 True"""
    h = (t or now_jst()).hour
    if QUIET_FROM == QUIET_TO:
        return False
    if QUIET_FROM < QUIET_TO:
        return QUIET_FROM <= h < QUIET_TO
    return h >= QUIET_FROM or h < QUIET_TO      # 跨零点


# ── 推送 ────────────────────────────────────────────

def notify(title: str, body: str) -> None:
    """向所有已配置的渠道推送。凭据全部走环境变量。"""
    sent = False

    def post(name, **kw):
        nonlocal sent
        try:
            r = requests.request(timeout=20, **kw)
            ok = r.ok
            # HTTP 200 不代表成功 —— 检查业务错误码
            try:
                j = r.json()
                if isinstance(j, dict):
                    if j.get("errcode", 0) not in (0, None):
                        ok, r.reason = False, f"errcode={j.get('errcode')} {j.get('errmsg','')}"
                    elif "code" in j and j["code"] not in (0, 200):
                        ok, r.reason = False, f"code={j['code']} {j.get('message', '')}"
            except ValueError:
                pass
            print(f"  {'✓' if ok else '✗'} {name} — {r.status_code} {r.reason}")
            sent = sent or ok
        except Exception as e:                       # noqa: BLE001
            print(f"  ✗ {name} — {e}", file=sys.stderr)

    # Server酱（微信）
    if key := env("SERVERCHAN_KEY"):
        m = re.match(r"^sctp(\d+)t", key)
        url = (f"https://{m.group(1)}.push.ft07.com/send/{key}.send"
               if m else f"https://sctapi.ftqq.com/{key}.send")
        post("Server酱", method="POST", url=url,
             data={"title": f"教習所 {title}", "desp": f"```\n{body}\n```"})

    # PushPlus（微信）
    if tok := env("PUSHPLUS_TOKEN"):
        post("PushPlus", method="POST", url="https://www.pushplus.plus/send",
             json={"token": tok, "title": f"教習所 {title}",
                   "content": f"<pre>{body}</pre>", "template": "html"})

    # 企业微信群机器人
    if hook := env("WECOM_WEBHOOK"):
        post("企业微信", method="POST", url=hook,
             json={"msgtype": "text", "text": {"content": f"【教習所】{title}\n{body}"}})

    # Bark（iOS）
    if bark := env("BARK_URL"):
        from urllib.parse import quote
        level = env("BARK_LEVEL", "timeSensitive")
        post("Bark", method="GET",
             url=f"{bark.rstrip('/')}/{quote(f'教習所 {title}')}/{quote(body)}"
                 f"?sound=alarm&level={level}&group=ikegami")

    # ntfy
    if url := env("NTFY_URL"):
        post("ntfy", method="POST", url=url,
             data=f"{title}\n{body}".encode(),
             headers={"Title": "Ikegami", "Priority": "high"})

    # Telegram
    if url := env("TELEGRAM_URL"):
        post("Telegram", method="POST", url=url, data={"text": f"{title}\n{body}"})

    # Discord
    if hook := env("DISCORD_WEBHOOK"):
        post("Discord", method="POST", url=hook,
             json={"content": f"**{title}**\n```\n{body}\n```"})

    if not sent:
        print("  ⚠ 没有任何推送渠道成功 —— 检查环境变量是否配置", file=sys.stderr)


# ── 客户端 ──────────────────────────────────────────

class IkegamiClient:
    def __init__(self, student_id: str, password: str, *, car_model_cd: str = "301"):
        self.student_id = student_id
        self.password = password
        self.car_model_cd = car_model_cd
        self.school_cd: str | None = None
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,zh-CN;q=0.9,en;q=0.8",
            "Origin": BASE,
        })

    @staticmethod
    def _check_error(html: str) -> None:
        if "EC05" in html or "システムエラー" in html:
            raise SessionKilled("服务端返回 EC05（会话失效 / 维护中）")

    def _refresh_school_cd(self, html: str) -> None:
        """见 README §5.9b —— schoolCd 每次可能不同，须动态提取"""
        m = (re.search(r'name=["\']schoolCd["\'][^>]*value=["\']([^"\']+)["\']', html)
             or re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']schoolCd["\']', html))
        if m:
            self.school_cd = m.group(1)

    def _post(self, url: str, data: dict, *, referer: str = RESERV_URL) -> str:
        r = self.s.post(url, data=data, timeout=30, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": referer,
        })
        r.raise_for_status()
        self._check_error(r.text)
        self._refresh_school_cd(r.text)
        return r.text

    def _params(self, **over) -> dict:
        """见 README §5.9 —— nextWeek 与 confirm 共用同一套参数"""
        p = {
            "schoolCd": self.school_cd or "", "lastScreenCd": "",
            "dateInformationType": "", "groupCd": "1", "instructorTypeCd": "0",
            "page": "1", "changeInstructorFlg": "0", "carModelCd": self.car_model_cd,
            "instructorCd": "0", "infoPeriodNumber": "", "nominationInstructorCd": "0",
            "kamokuCd": "0", "selectTime": "",
        }
        p.update(over)
        return p

    def login(self) -> None:
        html = self.s.get(LOGIN_URL, timeout=30).text
        self._refresh_school_cd(html)
        if not self.school_cd:
            raise RuntimeError("登录页未找到 schoolCd —— 页面结构可能已变更")
        html = self._post(LOGIN_URL, {
            "schoolCd": self.school_cd,
            "studentId": self.student_id,
            "password": self.password,
        }, referer=LOGIN_URL)
        if "studentId" in html and "password" in html:
            raise RuntimeError("登录失败 —— 检查教習生番号与密码")

    @staticmethod
    def parse_slots(html: str) -> list[Slot]:
        """status1 + a.simei = 可预约。见 README §4"""
        soup = BeautifulSoup(html, "html.parser")
        out, seen = [], set()
        for a in soup.select("a.simei"):
            date, zigen = a.get("data-yoyaku"), a.get("data-zigen")
            if not date or not zigen:
                continue
            k = f"{date}-{zigen}"
            if k in seen:                    # 两张转置表会重复
                continue
            seen.add(k)
            out.append(Slot(
                date=date, zigen=int(zigen),
                time=a.get("data-time") or ZIGEN_TIME.get(int(zigen), "?"),
                week=a.get("data-week", ""),
            ))
        return out

    def scan(self, weeks: int = 4) -> list[Slot]:
        self.login()
        html = self._post(RESERV_URL, self._params())
        found = list(self.parse_slots(html))
        for _ in range(weeks - 1):
            time.sleep(random.uniform(1.5, 3.5))
            html = self._post(NEXT_WEEK_URL, self._params())
            found.extend(self.parse_slots(html))
        uniq = {s.key: s for s in found}
        return sorted(uniq.values(), key=lambda s: (s.date, s.zigen))


# ── 状态持久化 ──────────────────────────────────────

def load_state(path: Path) -> set[str]:
    if path.exists():
        try:
            return set(json.loads(path.read_text("utf-8")))
        except Exception:                    # noqa: BLE001
            pass
    return set()


def save_state(path: Path, keys: set[str]) -> None:
    path.write_text(json.dumps(sorted(keys), ensure_ascii=False), "utf-8")


# ── 主流程 ──────────────────────────────────────────

def run_once(client: IkegamiClient, weeks: int, state_path: Path) -> int:
    slots = client.scan(weeks)
    hits = [s for s in slots if s.wanted]

    known = load_state(state_path)
    fresh = [s for s in hits if s.key not in known]
    save_state(state_path, {s.key for s in hits})

    ts = now_jst().strftime("%m-%d %H:%M")
    print(f"[{ts} JST] 扫描 {weeks} 周 → 空位 {len(slots)} 个 / "
          f"命中 {len(hits)} 个 / 新增 {len(fresh)} 个")

    for s in hits:
        print(f"    {'★' if s in fresh else '·'} {s.pretty()}")

    if fresh:
        body = "\n".join(s.pretty() for s in fresh)
        notify(f"空位 {len(fresh)} 件", body)
    return len(fresh)


def build_client() -> IkegamiClient:
    sid, pw = env("IKEGAMI_ID"), env("IKEGAMI_PW")
    if not sid or not pw:
        print("未设置 IKEGAMI_ID / IKEGAMI_PW", file=sys.stderr)
        sys.exit(1)
    return IkegamiClient(sid, pw, car_model_cd=env("IKEGAMI_CAR_MODEL", "301"))


def main() -> int:
    ap = argparse.ArgumentParser(description="池上教習所 空位监控")
    ap.add_argument("--once", action="store_true", help="扫描一次后退出")
    ap.add_argument("--weeks", type=int, default=4, help="向后扫描几周")
    ap.add_argument("--interval", type=int, default=900, help="轮询间隔秒")
    ap.add_argument("--state", default="state.json", help="状态文件路径")
    ap.add_argument("--ignore-quiet", action="store_true", help="忽略静默时段")
    args = ap.parse_args()

    state_path = Path(args.state)

    # 静默时段：直接退出，云端定时器无需为此单独配置
    if not args.ignore_quiet and in_quiet_hours():
        print(f"[{now_jst():%H:%M} JST] 静默时段 "
              f"{QUIET_FROM:02d}:00–{QUIET_TO:02d}:00，跳过本次")
        return 0

    while True:
        try:
            run_once(build_client(), args.weeks, state_path)
        except SessionKilled as e:
            print(f"⚠ {e}", file=sys.stderr)
            if args.once:
                return 2
            time.sleep(1800)                 # 退避 30 分钟
            continue
        except (requests.RequestException, RuntimeError) as e:
            print(f"⚠ {e}", file=sys.stderr)
            if args.once:
                return 3
            time.sleep(300)
            continue

        if args.once:
            return 0

        wait = args.interval + random.randint(-120, 120)
        print(f"    下次扫描：{wait // 60} 分后\n")
        time.sleep(wait)

        while in_quiet_hours():              # 静默时段内挂起
            time.sleep(600)


if __name__ == "__main__":
    sys.exit(main())
