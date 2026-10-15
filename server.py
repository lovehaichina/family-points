# -*- coding: utf-8 -*-
"""家庭任务积分乐园 —— 本地服务端

纯 Python 标准库实现（无第三方依赖）。
启动：python server.py
环境变量：FAMILY_PORT（默认 8787）、FAMILY_HOST（默认 0.0.0.0）、FAMILY_DB（数据库路径）、
         FAMILY_AUTODEMO=1（空库自动载入演示数据）、FAMILY_PIN_LOCKOUT（PIN 锁定秒数，默认 60）、
         FAMILY_SUBMIT_DEADLINE_HOURS（接取后提交时限，默认 3 小时）、
         FAMILY_ACCESS_USER / FAMILY_ACCESS_PASS（整站访问口令，未设置则关闭）

v5（2026-10-11）三项业务规则：
  1. 限时提交：任务被接取后须在 N 小时内（默认 3）提交，超时自动作废（status='overdue'），已扣积分不退。
  2. 指定孩子：任务可勾选可接取的孩子（tasks.kids，逗号分隔；空=全部孩子）；
     勾选多名孩子时，每名孩子各持一份独立实例（instances.member_id 标记归属），互不影响。
  3. 停用后再启用：立即刷新为可接取状态（rebuild_current_instances：重建当期实例）。

v6（2026-10-11）孩子自建任务（发布申请）+ 每日利息：
  1. 孩子可申请发布任务（仅发布给自己）：填写标题/说明/类型/完成奖励积分；
     提交时按当时费率快照 fee=floor(reward*m%) 与 cost=floor(reward*n%)，
     经家长「通过」后扣除发布费并创建正式任务（origin='kid'），驳回则不收费。
  2. 费率与开关由家长设置（均 ≥0 整数）：kid_publish_fee(m, 默认5) / kid_claim_cost(n, 默认5) /
     interest_rate(x, 默认1) / kid_publish_enabled(总开关, 默认开)。
     开关关闭后孩子不能提交新申请；存量申请与已发布任务不受影响。
  3. 每日利息：孩子余额每天获得 floor(余额*x%) 的利息（惰性结算、跨天补发、日复利）；
     余额 ≤0 或单日利息为 0 时不产生流水。

v6.3–v7（2026-10-11）放弃留档 + 列表分页 + 历史按需加载：
  1. 放弃留档：孩子放弃任务时插入一条 abandoned 历史快照（周期键留空以避开唯一索引），
     原实例照旧回池（可再次接取），放弃消耗不退。
  2. 全站列表分页（前端）：每页 5 条、上一页/下一页。
  3. 历史按需加载：build_data 主数据流瘦身（instances 只带「活跃 + 当期」，ledger 最近 150 条）；
     新增 history:query 动作分页读取任意深度的流水 / 任务历史（完成、超时、放弃），
     突破保留量上限——前端翻页时实时取数，再多的历史都能翻到。

v8（2026-10-11）品牌升级 + 兑换分类 + 默认配置体系：
  1. 品牌更名：「家庭任务与积分激励系统」→「家庭任务积分乐园」（服务端/前端/文档全量替换）。
  2. 兑换分类：rewards 表新增 category 字段（文本，空=未分类）；孩子端「使用积分」下拉按分类
     分组展示（optgroup），家长端兑换清单按分类分区显示并支持按分类筛选；家长新增/编辑可指定分类。
  3. 默认配置体系（default_seed）：一键清空数据后回到「老大/老二/家长」三成员 + 本方案
     （docs/任务列表与兑换清单设计方案_v3.md）的例行任务 / 专项任务 / 兑换清单全套默认配置。
     reset_all 与首次建库（空库）均调用 default_seed，保证「清空即回到默认」。
"""
import base64
import hashlib
import hmac
import json
import os
import socket
import sqlite3
import struct
import sys
import threading
import time
import uuid
import zlib
import socketserver
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from http.server import ThreadingHTTPServer
except ImportError:  # Python 3.6 兼容层（ThreadingHTTPServer 自 3.7 起提供）
    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, 'data')
UPLOAD_DIR = os.path.join(DATA_DIR, 'uploads')
DB_PATH = os.environ.get('FAMILY_DB') or os.path.join(DATA_DIR, 'family.db')
STATIC_DIR = os.path.join(BASE, 'static')
HOST = os.environ.get('FAMILY_HOST', '0.0.0.0')
PORT = int(os.environ.get('FAMILY_PORT', '8787'))
AUTODEMO = os.environ.get('FAMILY_AUTODEMO', '') == '1'
PIN_LOCKOUT = int(os.environ.get('FAMILY_PIN_LOCKOUT', '60'))
SUBMIT_DEADLINE_HOURS = int(os.environ.get('FAMILY_SUBMIT_DEADLINE_HOURS', '3'))

TOKENS = {}          # token -> 过期时间戳
# v13.1：家长 token 持久化到 data/tokens.json —— 服务重启（含每次部署）
#   不再导致家长端「掉线」：此前 TOKENS 纯内存，重启后用户在家长端看到的页面
#   仍正常（/api/data 不校验 token），但所有家长操作与导出链接都会 403。
TOKENS_FILE = os.path.join(DATA_DIR, 'tokens.json')
LOCK = threading.Lock()
PIN_STATE = {'fails': 0, 'lock_until': 0.0}
# v15：成员（孩子）PIN 门禁 —— 每个成员访问自己的页面都需要输入该成员的 PIN。
#   · 存储：members.pin（默认 '1234'）+ members.pin_changed（0/1，是否已自行改过）
#   · 登录态：MEMBER_TOKENS 持久化到 data/member_tokens.json，格式
#     { token: {'mid': <member_id>, 'exp': <时间戳>} }；家长改成员 PIN 时
#     只作废【该成员】的 token，不影响其他成员与家长端。
#   · 需求确认（2026-10-14 Yoo 裁决）：①每次进入都要验证 ②首次 1234 登录后
#     强制修改 ③家长改 PIN 后该成员登录态立即作废 ④家长入口放「设置」页统一列表。
MEMBER_TOKENS = {}   # token -> {'mid': int, 'exp': float}
MEMBER_TOKENS_FILE = os.path.join(DATA_DIR, 'member_tokens.json')
MEMBER_PIN_LOCKOUT = int(os.environ.get('FAMILY_MEMBER_PIN_LOCKOUT', '60'))
MEMBER_PIN_STATE = {}   # member_id -> {'fails': int, 'lock_until': float}
DEFAULT_MEMBER_PIN = '1234'
ALLOWED_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'}
MAX_FILES_PER_SUBMIT = 6
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_BODY = 60 * 1024 * 1024
TOKEN_TTL = 30 * 24 * 3600
LIMIT_TASK = 1000000        # 任务奖励/接取消耗单值上限
LIMIT_ADJUST = 1000000      # 单次调整幅度上限
LIMIT_SPEND = 10000000      # 单次自由使用上限


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def week_key_of(d=None):
    d = d or date.today()
    y, w, _ = d.isocalendar()
    return f'{y}-W{int(w):02d}'


def day_key_of(d=None):
    d = d or date.today()
    return d.strftime('%Y-%m-%d')


def parse_kids(s):
    """解析 tasks.kids（逗号分隔的孩子 ID；空 = 全部孩子 → 返回 []）。"""
    out = []
    for part in str(s or '').split(','):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    return con


def init_db():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    con = db()
    con.executescript('''
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS members(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL,
  sort INTEGER DEFAULT 0, created_at TEXT,
  pin TEXT DEFAULT '1234', pin_changed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT DEFAULT '', reward INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  weekday INTEGER, kids TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT,
  tag TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS instances(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id),
  member_id INTEGER NOT NULL DEFAULT 0,
  week_key TEXT, day_key TEXT, status TEXT NOT NULL DEFAULT 'available', assignee_id INTEGER,
  claimed_at TEXT, submitted_at TEXT, completed_at TEXT,
  review_note TEXT, submit_note TEXT, created_at TEXT,
  claim_cost INTEGER DEFAULT NULL);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER NOT NULL REFERENCES instances(id),
  filename TEXT, path TEXT, size INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, delta INTEGER NOT NULL,
  type TEXT NOT NULL, ref TEXT, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS spend_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, amount INTEGER NOT NULL,
  note TEXT, status TEXT DEFAULT 'pending', created_at TEXT, decided_at TEXT, decision_note TEXT,
  kind TEXT DEFAULT 'free', reward_id INTEGER, quantity INTEGER DEFAULT 1, ref TEXT DEFAULT '',
  cart_items TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS rewards(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 10,
  limit_type TEXT DEFAULT 'week', limit_count INTEGER DEFAULT 1, active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0, category TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS publish_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT DEFAULT '', type TEXT NOT NULL,
  reward INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, created_at TEXT, decided_at TEXT,
  tag TEXT DEFAULT '');
''')
    # ---- 旧库迁移 ----
    cols = [r['name'] for r in con.execute('PRAGMA table_info(spend_requests)').fetchall()]
    if 'kind' not in cols:
        con.execute("ALTER TABLE spend_requests ADD COLUMN kind TEXT DEFAULT 'free'")
    if 'reward_id' not in cols:
        con.execute('ALTER TABLE spend_requests ADD COLUMN reward_id INTEGER')
    if 'quantity' not in cols:
        con.execute('ALTER TABLE spend_requests ADD COLUMN quantity INTEGER DEFAULT 1')
    # v10：幂等去重键（连续完成奖励按 ref 防重复生成）
    if 'ref' not in cols:
        con.execute("ALTER TABLE spend_requests ADD COLUMN ref TEXT DEFAULT ''")
    # v11：购物车明细（JSON 数组；空 = 传统单条申请）
    #   一项申请可包含多件兑换物（网购购物车「一车一单」），amount 存合计分值，
    #   cart_items 存 [{reward_id, name, cost, quantity, amount}] 明细，供家长端逐项勾选。
    if 'cart_items' not in cols:
        con.execute("ALTER TABLE spend_requests ADD COLUMN cart_items TEXT DEFAULT ''")
    task_cols = [r['name'] for r in con.execute('PRAGMA table_info(tasks)').fetchall()]
    if 'kids' not in task_cols:
        con.execute("ALTER TABLE tasks ADD COLUMN kids TEXT DEFAULT ''")
    if 'origin' not in task_cols:
        con.execute("ALTER TABLE tasks ADD COLUMN origin TEXT DEFAULT 'parent'")
    # v9：任务标签（二级分类，空 = 未分类，历史数据保持兼容）
    if 'tag' not in task_cols:
        con.execute("ALTER TABLE tasks ADD COLUMN tag TEXT DEFAULT ''")
    pr_cols = [r['name'] for r in con.execute('PRAGMA table_info(publish_requests)').fetchall()]
    if 'tag' not in pr_cols:
        con.execute("ALTER TABLE publish_requests ADD COLUMN tag TEXT DEFAULT ''")
    mem_cols = [r['name'] for r in con.execute('PRAGMA table_info(members)').fetchall()]
    if 'last_interest_date' not in mem_cols:
        con.execute('ALTER TABLE members ADD COLUMN last_interest_date TEXT')
    # v15：成员（孩子）PIN 门禁 —— 每位成员一个 PIN，默认 1234。
    #   pin 存明文（家庭局域网内部工具，与家长 PIN 同级别对待）；
    #   pin_changed=0 表示仍为默认值 → 首次登录后强制修改。
    if 'pin' not in mem_cols:
        con.execute("ALTER TABLE members ADD COLUMN pin TEXT DEFAULT '1234'")
    if 'pin_changed' not in mem_cols:
        con.execute('ALTER TABLE members ADD COLUMN pin_changed INTEGER DEFAULT 0')
    # 历史成员补齐（NULL / 空 一律按默认 PIN 处理）
    con.execute("UPDATE members SET pin=? WHERE pin IS NULL OR pin=''", (DEFAULT_MEMBER_PIN,))
    con.execute('UPDATE members SET pin_changed=0 WHERE pin_changed IS NULL')
    # v8：兑换分类（空 = 未分类，历史数据保持兼容）
    rw_cols = [r['name'] for r in con.execute('PRAGMA table_info(rewards)').fetchall()]
    if 'category' not in rw_cols:
        con.execute("ALTER TABLE rewards ADD COLUMN category TEXT DEFAULT ''")
    inst_cols = [r['name'] for r in con.execute('PRAGMA table_info(instances)').fetchall()]
    if 'member_id' not in inst_cols:
        con.execute('ALTER TABLE instances ADD COLUMN member_id INTEGER NOT NULL DEFAULT 0')
    if 'day_key' not in inst_cols:
        con.execute('ALTER TABLE instances ADD COLUMN day_key TEXT')
    # v13：接取时实际扣除的积分快照（NULL = 未接取过）。
    #   用于「展示 / 退还」与实际扣款严格一致——家长中途调整接取费率 n 后，
    #   已接取实例仍按当时的成本显示与退还（扣多少、显示多少、退多少）。
    if 'claim_cost' not in inst_cols:
        con.execute('ALTER TABLE instances ADD COLUMN claim_cost INTEGER DEFAULT NULL')
    # 唯一键升级为 (task_id, member_id, 周期键)：支持"每名孩子独立一份实例"
    con.execute('DROP INDEX IF EXISTS uniq_task_week')
    con.execute('DROP INDEX IF EXISTS uniq_task_day')
    for key_col, idx_name in (('week_key', 'uniq_task_member_week'), ('day_key', 'uniq_task_member_day')):
        dup_groups = con.execute(
            "SELECT task_id, member_id, %s AS k FROM instances WHERE %s IS NOT NULL "
            "GROUP BY task_id, member_id, %s HAVING COUNT(*) > 1" % (key_col, key_col, key_col)).fetchall()
        for g in dup_groups:
            rows = con.execute(
                "SELECT id, status FROM instances WHERE task_id=? AND member_id=? AND %s=? ORDER BY id" % key_col,
                (g['task_id'], g['member_id'], g['k'])).fetchall()
            keep = None
            for r in rows:
                if r['status'] in ('in_progress', 'submitted', 'done'):
                    keep = r['id']
                    break
            if keep is None:
                keep = rows[0]['id']
            con.execute("DELETE FROM instances WHERE task_id=? AND member_id=? AND %s=? AND id<>?" % key_col,
                        (g['task_id'], g['member_id'], g['k'], keep))
        try:
            con.execute('CREATE UNIQUE INDEX IF NOT EXISTS %s ON instances(task_id, member_id, %s) '
                        'WHERE %s IS NOT NULL' % (idx_name, key_col, key_col))
        except sqlite3.OperationalError:
            pass
    for k, v in {'family_name': '我的家', 'parent_pin': '1234', 'cost_refund': '1',
                 'kid_publish_enabled': '1', 'kid_publish_fee': '5', 'kid_claim_cost': '5',
                 'interest_rate': '1',
                 'streak_reward_days': '7', 'streak_reward_points': '2000'}.items():
        con.execute('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', (k, v))
    con.commit()
    con.close()


def setting(con, key, default=''):
    r = con.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return r['value'] if r else default


def set_setting(con, key, value):
    con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, str(value)))


def setting_int(con, key, default=0):
    """读取整数设置（防御脏数据，异常时回退默认值）。"""
    try:
        return int(setting(con, key, str(default)))
    except (ValueError, TypeError):
        return default


def balance(con, member_id):
    r = con.execute('SELECT COALESCE(SUM(delta),0) AS b FROM ledger WHERE member_id=?', (member_id,)).fetchone()
    return int(r['b'])


def add_ledger(con, member_id, delta, ltype, ref='', note=''):
    if delta == 0:
        return
    con.execute('INSERT INTO ledger(member_id,delta,type,ref,note,created_at) VALUES(?,?,?,?,?,?)',
                (member_id, int(delta), ltype, ref, note, now_str()))


def period_start(limit_type):
    """限额周期的起始日期（字符串，可与 created_at/decided_at 直接比较）。"""
    today = date.today()
    if limit_type == 'day':
        return today.strftime('%Y-%m-%d')
    if limit_type == 'week':
        return (today - timedelta(days=today.weekday())).strftime('%Y-%m-%d')
    if limit_type == 'month':
        return today.replace(day=1).strftime('%Y-%m-%d')
    return '1970-01-01'


def period_label(limit_type):
    return {'day': '每天', 'week': '每周', 'month': '每月'}.get(limit_type, '')


def quota_used(con, reward_id, member_id, start):
    """已用额度 = 已确认 + 待确认（按数量求和）。

    v11：购物车申请（kind='cart'）把明细存在 cart_items JSON 里，
    传统单条申请（kind='reward'）把数量存在 quantity 列里，两者都要计入，
    否则孩子可以靠「加购物车」绕过限额。
    """
    a = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                    "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='approved' AND decided_at>=?",
                    (reward_id, member_id, start)).fetchone()['s']
    p = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                    "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='pending' AND created_at>=?",
                    (reward_id, member_id, start)).fetchone()['s']
    return int(a) + int(p) + cart_quota_used(con, reward_id, member_id, start)


def cart_quota_used(con, reward_id, member_id, start):
    """购物车申请中该兑换项的已用额度（已确认 + 待确认）。"""
    total = 0
    rows = con.execute("SELECT cart_items, status, created_at, decided_at FROM spend_requests "
                       "WHERE kind='cart' AND member_id=? AND status IN ('pending','approved')",
                       (member_id,)).fetchall()
    for r in rows:
        # 待确认按提交时间落入周期，已确认按确认时间落入周期（与单条申请口径一致）
        ts = r['created_at'] if r['status'] == 'pending' else (r['decided_at'] or r['created_at'])
        if not ts or str(ts) < str(start):
            continue
        for it in parse_cart(r['cart_items']):
            if it['reward_id'] == reward_id:
                total += int(it['quantity'])
    return total


# ---------------- v11：购物车（一车一单） ----------------
def parse_cart(s):
    """解析 spend_requests.cart_items（JSON 数组）；脏数据一律按空处理。"""
    if not s:
        return []
    try:
        out = json.loads(s)
    except (ValueError, TypeError):
        return []
    if not isinstance(out, list):
        return []
    clean = []
    for it in out:
        if not isinstance(it, dict):
            continue
        try:
            qty = int(it.get('quantity') or 1)
        except (ValueError, TypeError):
            qty = 1
        try:
            cost = int(it.get('cost') or 0)
        except (ValueError, TypeError):
            cost = 0
        clean.append({
            'reward_id': int(it.get('reward_id') or 0),
            'name': str(it.get('name') or '')[:60],
            'cost': max(0, cost),
            'quantity': max(1, qty),
            'amount': max(0, cost) * max(1, qty),
            'kind': str(it.get('kind') or 'reward'),
        })
    return clean


def validate_cart_item(con, mid, it):
    """校验单个购物车条目；返回 (error_msg_or_None, normalized_item)。

    规则与旧的单条兑换完全一致：兑换项须存在且启用、数量 1..99、
    余额需覆盖、限额周期的「已确认 + 待确认」需有余量。
    """
    rid = int(it.get('reward_id') or 0)
    qty = int(it.get('quantity') or 1)
    rw = con.execute('SELECT * FROM rewards WHERE id=?', (rid,)).fetchone()
    if not rw or not rw['active']:
        return ('该兑换项不存在或已停用', None)
    if qty < 1:
        qty = 1
    if qty > 99:
        return ('单次兑换数量过多（最多 99）', None)
    if rw['limit_type'] != 'none':
        start = period_start(rw['limit_type'])
        used = quota_used(con, rid, mid, start)
        if used + qty > int(rw['limit_count']):
            remain = max(0, int(rw['limit_count']) - used)
            return (f"「{rw['name']}」超出限额：{period_label(rw['limit_type'])}最多可兑换 "
                    f"{rw['limit_count']} 次，当前剩余 {remain} 次", None)
    return (None, {'reward_id': rid, 'name': rw['name'], 'cost': int(rw['cost']),
                   'quantity': qty, 'amount': int(rw['cost']) * qty, 'kind': 'reward'})


def cart_total(items):
    return sum(int(x.get('amount') or 0) for x in items)


def daily_streak(con, task_id, member_id):
    """【v10】每天例行任务的「当前连续完成天数」。

    定义：从今天（或昨天）往前逐日回溯，该任务在该日有 status='done' 的实例则计入连续；
    遇到第一个无完成记录的日期即停止。

    关键排除项（否则放弃/超时快照会打断连贯性，产生假断签）：
      - status IN ('overdue','abandoned','expired') 一律不算完成（只认 status='done'）
      - 放弃快照的 week_key/day_key 可能为 NULL，不能用周期键匹配，只按完成日期归日
      - 专项任务（special）无 daily 周期，不参与连续统计

    返回 (streak, last_done_date)：当前连续天数；最近一次完成日期（无则 None）。
    """
    rows = con.execute(
        "SELECT completed_at, day_key FROM instances "
        "WHERE task_id=? AND member_id=? AND status='done'",
        (task_id, member_id)).fetchall()
    if not rows:
        return 0, None

    # 完成日期集合：优先 day_key（实例生成所属日），缺失时回退 completed_at 的日期部分。
    # 用 set 去重——同一天可能有多条（重做等），只算一天。
    done_days = set()
    for r in rows:
        dk = (r['day_key'] or '').strip()
        if dk:
            done_days.add(dk[:10])
        elif r['completed_at']:
            done_days.add(str(r['completed_at'])[:10])
    if not done_days:
        return 0, None

    today = date.today()
    today_str = today.strftime('%Y-%m-%d')
    last = max(done_days)

    # 今天还没完成时允许从昨天起算（当天尚未做不算断签，避免早上打开就看到"已中断"）
    cursor = today
    if today_str not in done_days:
        cursor = today - timedelta(days=1)
        if cursor.strftime('%Y-%m-%d') not in done_days:
            return 0, last

    streak = 0
    while cursor.strftime('%Y-%m-%d') in done_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak, last


def month_done_count(con, task_id, member_id, months_back=0):
    """【v10】本月已完成天数（结果导向的展示口径，替代低幼的"打卡"叙事）。

    统计 status='done' 且完成日期落在本月的独立天数；兼容 day_key 为空的历史数据。
    """
    today = date.today()
    y, m = today.year, today.month
    for _ in range(months_back):
        m -= 1
        if m < 1:
            m = 12
            y -= 1
    prefix = '%04d-%02d' % (y, m)
    rows = con.execute(
        "SELECT completed_at, day_key FROM instances WHERE task_id=? AND member_id=? AND status='done'",
        (task_id, member_id)).fetchall()
    days = set()
    for r in rows:
        key = (r['day_key'] or '').strip()[:10] or str(r['completed_at'] or '')[:10]
        if key.startswith(prefix):
            days.add(key)
    return len(days)


def grant_streak_rewards(con):
    """【v10】连续完成奖励 —— 方案乙：生成「待家长确认」记录，不自动发放。

    规则：每天例行任务连续完成达 N 天（默认 7）→ 生成一条 kind='streak' 的
         spend_requests 待确认记录，由家长点一下确认后发放。

    幂等 + 补漏：ref 形如 streak:<task_id>:<member_id>:<cycle>，cycle 从 1 到 streak//N
         逐个补齐。这样即使系统连续多天没被打开（streak 一次跳到 14），
         中间错过的第 1 个周期也会补上，不会漏发。
    """
    reward_points = max(0, setting_int(con, 'streak_reward_points', 2000))
    if reward_points <= 0:
        return 0
    threshold = max(2, setting_int(con, 'streak_reward_days', 7))
    created = 0
    for t in con.execute("SELECT id, title, kids FROM tasks WHERE type='daily' AND active=1").fetchall():
        for mid_ in (parse_kids(t['kids']) or [0]):
            # 公共任务（member_id=0，未指定孩子）没有明确受益人，不自动生成奖励；
            # 其连续统计仅在 build_data().streaks 中输出（与 instances 的 member_id=0 公共语义一致）。
            if not mid_:
                continue
            streak, _ = daily_streak(con, t['id'], mid_)
            if streak < threshold:
                continue
            for cycle in range(1, streak // threshold + 1):
                ref = 'streak:%d:%d:%d' % (t['id'], mid_, cycle)
                if con.execute("SELECT id FROM spend_requests WHERE kind='streak' AND ref=?", (ref,)).fetchone():
                    continue
                days = cycle * threshold
                con.execute("INSERT INTO spend_requests(member_id,amount,note,status,created_at,kind,quantity,ref) "
                            "VALUES(?,?,?,?,?,?,?,?)",
                            (mid_, reward_points, '连续完成 %d 天：%s' % (days, t['title']),
                             'pending', now_str(), 'streak', 1, ref))
                created += 1
    if created:
        con.commit()
    return created


def ensure_periods(con):
    """周期任务实例的自动生成 / 过期 / 超时作废：
    - 每天例行（daily）：按天生成（每名可接孩子各一份）；跨天未接的标记 expired
    - 每周例行（routine）：按周生成（每名可接孩子各一份）；跨周未接的标记 expired
    - 限时提交：接取后超过 SUBMIT_DEADLINE_HOURS 小时未提交（仍为 in_progress）→ 标记 overdue（作废，积分不退）
    """
    wk = week_key_of()
    dk = day_key_of()
    cutoff = (datetime.now() - timedelta(hours=SUBMIT_DEADLINE_HOURS)).strftime('%Y-%m-%d %H:%M:%S')
    con.execute("UPDATE instances SET status='overdue' "
                "WHERE status='in_progress' AND claimed_at IS NOT NULL AND claimed_at<?", (cutoff,))
    con.execute("UPDATE instances SET status='expired' WHERE status='available' AND week_key IS NOT NULL AND week_key<>?", (wk,))
    con.execute("UPDATE instances SET status='expired' WHERE status='available' AND day_key IS NOT NULL AND day_key<>?", (dk,))
    rows = con.execute("SELECT id, type, kids FROM tasks WHERE type IN ('routine','daily') AND active=1").fetchall()
    for t in rows:
        targets = parse_kids(t['kids']) or [0]
        for m in targets:
            if t['type'] == 'routine':
                con.execute('INSERT OR IGNORE INTO instances(task_id,member_id,week_key,status,created_at) VALUES(?,?,?,?,?)',
                            (t['id'], m, wk, 'available', now_str()))
            else:
                con.execute('INSERT OR IGNORE INTO instances(task_id,member_id,day_key,status,created_at) VALUES(?,?,?,?,?)',
                            (t['id'], m, dk, 'available', now_str()))
    con.commit()


def ensure_special_instances(con, task):
    """专项任务：为每名可接孩子（或公共）保证存在一个未结束的实例。"""
    targets = parse_kids(task['kids']) or [0]
    for m in targets:
        ex = con.execute("SELECT id FROM instances WHERE task_id=? AND member_id=? "
                         "AND status IN ('available','in_progress','submitted')",
                         (task['id'], m)).fetchone()
        if not ex:
            con.execute('INSERT INTO instances(task_id,member_id,week_key,status,created_at) VALUES(?,?,NULL,?,?)',
                        (task['id'], m, 'available', now_str()))


def settle_interest(con):
    """每日利息（惰性结算，v6）：
    - 每个孩子每天获得 floor(当日余额 × x%) 利息（x = interest_rate，0=关闭）
    - 跨天自动补发（日复利：逐日按当日余额计算，向下取整）
    - 余额 ≤0 或单日利息为 0 时不产生流水；首次见到某孩子时初始化结算日为当天（当天不发）
    """
    rate = max(0, setting_int(con, 'interest_rate', 1))
    today = date.today()
    tstr = today.strftime('%Y-%m-%d')
    rows = con.execute("SELECT id, last_interest_date FROM members WHERE role='child'").fetchall()
    for m in rows:
        last = m['last_interest_date']
        if not last:
            con.execute('UPDATE members SET last_interest_date=? WHERE id=?', (tstr, m['id']))
            continue
        if str(last)[:10] >= tstr:
            continue
        try:
            d0 = datetime.strptime(str(last)[:10], '%Y-%m-%d').date()
        except ValueError:
            d0 = today
        days = (today - d0).days
        if days <= 0:
            con.execute('UPDATE members SET last_interest_date=? WHERE id=?', (tstr, m['id']))
            continue
        if rate > 0:
            for _ in range(min(days, 3660)):   # 补发上限 10 年（防御日期被异常篡改）
                b = balance(con, m['id'])
                if b <= 0:
                    break
                interest = b * rate // 100
                if interest <= 0:
                    break
                add_ledger(con, m['id'], interest, 'interest', '', '每日利息 %d%%' % rate)
        con.execute('UPDATE members SET last_interest_date=? WHERE id=?', (tstr, m['id']))
    con.commit()


def rebuild_current_instances(con, task_id):
    """重建当期"未接取"实例（用于：编辑任务/启用任务 → 立即刷新为可接取状态）。
    仅清理 available / cancelled，不影响进行中、待审核与历史记录。"""
    task = get_task(con, task_id)
    if not task:
        return
    if task['type'] == 'special':
        con.execute("DELETE FROM instances WHERE task_id=? AND status IN ('available','cancelled')", (task_id,))
        if task['active']:
            ensure_special_instances(con, task)
    else:
        wk = week_key_of()
        dk = day_key_of()
        con.execute("DELETE FROM instances WHERE task_id=? AND status IN ('available','cancelled') "
                    "AND (week_key=? OR day_key=?)", (task_id, wk, dk))
    ensure_periods(con)


def get_task(con, task_id):
    return con.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()


# ============ v13：任务接取消耗 = 接取费率 n% × 奖励（全局统一规则） ============
# 设计要点（Yoo 需求）：
#   所有任务的接取消耗统一按「奖励 × 接取费率 n%」向下取整计算，与「孩子自建任务」
#   的接取费率 n（settings.kid_claim_cost）共用同一个配置，家长不再逐任务手填。
#   - n 变更时，所有任务的接取消耗自动同步重算
#   - 提供 parent:resync_claim_cost 供手动重算（用于规则上线后调整存量任务）
#   - 已完成/进行中的实例不受影响（扣分发生在接取当下，历史不回滚）

def claim_cost_of(con, reward):
    """按统一规则计算接取消耗：reward × n% 向下取整（n = kid_claim_cost）。"""
    n = max(0, setting_int(con, 'kid_claim_cost', 5))
    try:
        rw = int(reward or 0)
    except (TypeError, ValueError):
        rw = 0
    if rw <= 0:
        return 0
    return rw * n // 100


def resync_claim_cost(con):
    """把所有任务的接取消耗按当前 n 重算；返回变更清单 [{id,title,from,to}]。"""
    changed = []
    for t in con.execute('SELECT id,title,reward,cost FROM tasks').fetchall():
        new_cost = claim_cost_of(con, t['reward'])
        old_cost = int(t['cost'] or 0)
        if old_cost != new_cost:
            changed.append({'id': t['id'], 'title': t['title'], 'from': old_cost, 'to': new_cost})
            con.execute('UPDATE tasks SET cost=? WHERE id=?', (new_cost, t['id']))
    if changed:
        con.commit()
    return changed


def make_png(w, h, rgb=(226, 235, 252)):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    raw = (b'\x00' + bytes(rgb) * w) * h
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


# ============ v12：配置导出/导入 + 数据备份导出/导入 + 清空所有数据 ============
# 设计要点（与 Yoo 逐条确认后的最终形态）：
#   1) 配置文件只含「可迁移的设置项」，不含任何业务数据；任务/兑换清单归数据备份通道。
#   2) 配置文件与数据备份文件都【不含 parent_pin】（备份泄露也不暴露家长口令）。
#   3) 清空所有数据：保留访问口令（环境变量）与家长 PIN，重建默认任务/兑换，
#      成员重置为「老大/老二/家长」出厂三个成员。
#   4) 所有文件统一带 format / version 头，导入前校验格式、版本、字段完整性；
#      校验失败一律返回明确错误且【不覆盖现有配置】。

CFG_FORMAT = 'family-points-config'
CFG_VERSION = 1
BAK_FORMAT = 'family-points-backup'
BAK_VERSION = 1

# 配置文件的设置项清单：(键, 类型, 中文名, 默认值)
#   类型 int   -> 非负整数；类型 bool -> 0/1；类型 text -> 字符串
CONFIG_FIELDS = [
    ('family_name', 'text', '家庭名称', '我的家'),
    ('cost_refund', 'bool', '接取消耗退还', '1'),
    ('kid_publish_enabled', 'bool', '孩子自建任务开关', '1'),
    ('kid_publish_fee', 'int', '发布费率 m', '5'),
    ('kid_claim_cost', 'int', '接取费率 n', '5'),
    ('interest_rate', 'int', '利息率 x', '1'),
    ('streak_reward_days', 'int', '连续达标天数', '7'),
    ('streak_reward_points', 'int', '连续奖励分值', '2000'),
]
CONFIG_KEYS = [f[0] for f in CONFIG_FIELDS]

# 数据备份包含的表（顺序固定，便于比对）
BACKUP_TABLES = ('settings', 'members', 'tasks', 'instances', 'files',
                 'ledger', 'spend_requests', 'rewards', 'publish_requests')


def _cfg_default(key):
    for k, _t, _n, d in CONFIG_FIELDS:
        if k == key:
            return d
    return ''


def export_config(con):
    """导出当前配置（只含设置项；绝不含 parent_pin）。"""
    settings = {}
    for key, ftype, _name, default in CONFIG_FIELDS:
        raw = setting(con, key, default)
        if ftype == 'bool':
            settings[key] = (raw == '1')
        elif ftype == 'int':
            try:
                settings[key] = int(raw)
            except (TypeError, ValueError):
                settings[key] = int(default)
        else:
            settings[key] = raw
    return {
        'format': CFG_FORMAT,
        'version': CFG_VERSION,
        'exported_at': now_str(),
        'app': '家庭任务积分乐园',
        'settings': settings,
    }


def validate_config(doc):
    """校验配置文件；返回 (error_or_None, normalized_settings_or_None)。

    校验顺序：整体结构 → format → version → settings 存在 → 逐字段类型/范围。
    任何一步失败都返回明确错误，调用方据此【不覆盖现有配置】。
    """
    if not isinstance(doc, dict):
        return ('配置文件格式不正确：文件内容不是一个 JSON 对象', None)
    fmt = doc.get('format')
    if fmt != CFG_FORMAT:
        return (f'不是本系统的配置文件（期望 format="{CFG_FORMAT}"，实际 "{fmt}"）', None)
    try:
        ver = int(doc.get('version'))
    except (TypeError, ValueError):
        return ('配置文件缺少有效的 version 字段', None)
    if ver > CFG_VERSION:
        return (f'配置文件版本过新（文件 v{ver}，本系统支持到 v{CFG_VERSION}），请升级系统后再导入', None)
    if ver < 1:
        return (f'配置文件版本无效（v{ver}）', None)
    settings = doc.get('settings')
    if not isinstance(settings, dict):
        return ('配置文件缺少 settings 字段，或用例不是对象', None)
    missing = [k for k in CONFIG_KEYS if k not in settings]
    if missing:
        names = '、'.join(_cfg_name(k) for k in missing)
        return (f'配置文件字段不完整，缺少：{names}', None)

    normalized = {}
    for key, ftype, name, default in CONFIG_FIELDS:
        val = settings.get(key)
        if ftype == 'bool':
            if isinstance(val, bool):
                normalized[key] = '1' if val else '0'
            elif isinstance(val, int) and val in (0, 1):
                normalized[key] = '1' if val else '0'
            else:
                return (f'配置项「{name}」的值类型不正确（应为 true/false）', None)
        elif ftype == 'int':
            if isinstance(val, bool) or not isinstance(val, int):
                if isinstance(val, float) and val.is_integer():
                    val = int(val)
                else:
                    return (f'配置项「{name}」的值类型不正确（应为整数）', None)
            if val < 0:
                return (f'配置项「{name}」不能为负数', None)
            if val > LIMIT_TASK:
                return (f'配置项「{name}」数值过大（上限 {LIMIT_TASK}）', None)
            normalized[key] = str(val)
        else:
            if not isinstance(val, str):
                return (f'配置项「{name}」的值类型不正确（应为文本）', None)
            text = val.strip()[:50]
            if key == 'family_name' and not text:
                text = default
            normalized[key] = text
    # 连续达标天数下限 2（与 build_data 的 max(2, ...) 保持一致）
    if int(normalized.get('streak_reward_days', '7')) < 2:
        return ('配置项「连续达标天数」不能小于 2', None)
    return (None, normalized)


def _cfg_name(key):
    for k, _t, name, _d in CONFIG_FIELDS:
        if k == key:
            return name
    return key


def export_backup(con):
    """导出完整数据备份（全部业务表；不含 parent_pin，也不含成员 PIN）。"""
    dump = {}
    for t in BACKUP_TABLES:
        rows = [dict(r) for r in con.execute(f'SELECT * FROM {t}').fetchall()]
        if t == 'settings':
            # 安全：家长 PIN 属于本机凭据，不进备份文件
            rows = [r for r in rows if r.get('key') != 'parent_pin']
        if t == 'members':
            # v15 安全：成员 PIN 与「已改过」标记都属于本机凭据，不进备份文件。
            #   导入后所有成员一律回到默认 PIN 1234 并要求首次修改。
            for r in rows:
                r.pop('pin', None)
                r.pop('pin_changed', None)
        dump[t] = rows
    return {
        'format': BAK_FORMAT,
        'version': BAK_VERSION,
        'exported_at': now_str(),
        'app': '家庭任务积分乐园',
        'data': dump,
    }


def validate_backup(doc):
    """校验备份文件结构；返回 (error_or_None, data_or_None)。"""
    if not isinstance(doc, dict):
        return ('备份文件格式不正确：文件内容不是一个 JSON 对象', None)
    fmt = doc.get('format')
    if fmt != BAK_FORMAT:
        return (f'不是本系统的备份文件（期望 format="{BAK_FORMAT}"，实际 "{fmt}"）', None)
    try:
        ver = int(doc.get('version'))
    except (TypeError, ValueError):
        return ('备份文件缺少有效的 version 字段', None)
    if ver > BAK_VERSION:
        return (f'备份文件版本过新（文件 v{ver}，本系统支持到 v{BAK_VERSION}），请升级系统后再导入', None)
    if ver < 1:
        return (f'备份文件版本无效（v{ver}）', None)
    data = doc.get('data')
    if not isinstance(data, dict):
        return ('备份文件缺少 data 字段，或格式不正确', None)
    missing = [t for t in BACKUP_TABLES if t not in data]
    if missing:
        return ('备份文件内容不完整，缺少数据表：' + '、'.join(missing), None)
    for t in BACKUP_TABLES:
        if not isinstance(data[t], list):
            return (f'备份文件中的数据表「{t}」格式不正确（应为数组）', None)
    return (None, data)


def import_config(con, normalized):
    """把校验后的配置写入 settings（不碰 parent_pin）。返回变更项列表。"""
    changed = []
    for key, ftype, name, _default in CONFIG_FIELDS:
        old = setting(con, key, _cfg_default(key))
        new = normalized[key]
        if key == 'family_name':
            cmp_old = old
        else:
            cmp_old = old if ftype == 'text' else str(old)
        if str(cmp_old) != str(new):
            changed.append({'key': key, 'name': name, 'from': str(cmp_old), 'to': str(new)})
        set_setting(con, key, new)
    con.commit()
    return changed


def import_backup(con, data):
    """用备份数据整体覆盖业务表（覆盖式恢复）。

    安全铁律（v15 延续）：
      - 即使备份里带了 parent_pin 也会被忽略（保留本机当前家长 PIN）；
      - 即使备份里带了 members.pin / members.pin_changed 也会被忽略，
        恢复后所有成员一律回到默认 PIN 1234 并要求首次修改。
    顺序：先删子表再删父表，插入时按父→子顺序，避免外键引用悬空。
    """
    cur_pin = setting(con, 'parent_pin', '1234')

    # 删除顺序：子 → 父
    for t in ('files', 'instances', 'ledger', 'spend_requests', 'publish_requests',
              'tasks', 'rewards', 'members', 'settings'):
        con.execute(f'DELETE FROM {t}')

    # 插入顺序：父 → 子（外键指向的表先插）
    for t in ('settings', 'members', 'tasks', 'rewards', 'instances', 'files',
              'ledger', 'spend_requests', 'publish_requests'):
        rows = data.get(t) or []
        for r in rows:
            if t == 'settings':
                # 安全：忽略备份里的 parent_pin，恢复后用本机当前 PIN
                if r.get('key') == 'parent_pin':
                    continue
            if not isinstance(r, dict) or not r:
                continue
            r = dict(r)
            if t == 'members':
                # v15 安全：成员 PIN 属本机凭据，一律丢弃 → 回到默认 PIN 并要求首改
                r.pop('pin', None)
                r.pop('pin_changed', None)
            cols = [c for c in r.keys()]
            placeholders = ','.join('?' for _ in cols)
            col_sql = ','.join('"%s"' % c.replace('"', '') for c in cols)
            vals = [r[c] for c in cols]
            try:
                con.execute(f'INSERT INTO {t} ({col_sql}) VALUES ({placeholders})', vals)
            except sqlite3.Error:
                # 单行异常不阻断整体恢复（脏数据跳过）
                continue
    # v15：兜底——若 members 表因某种原因出现了 NULL 的 PIN，一律补默认值
    con.execute("UPDATE members SET pin=? WHERE pin IS NULL OR pin=''", (DEFAULT_MEMBER_PIN,))
    con.execute('UPDATE members SET pin_changed=0 WHERE pin_changed IS NULL')

    # 保证本机 PIN 仍在（备份不含时补默认；含则沿用当前值）
    if not con.execute("SELECT 1 FROM settings WHERE key='parent_pin'").fetchone():
        set_setting(con, 'parent_pin', cur_pin)
    # 补齐可能缺失的基础设置键（旧备份）
    for k, v in {'family_name': '我的家', 'parent_pin': cur_pin, 'cost_refund': '1',
                 'kid_publish_enabled': '1', 'kid_publish_fee': '5', 'kid_claim_cost': '5',
                 'interest_rate': '1', 'streak_reward_days': '7',
                 'streak_reward_points': '2000'}.items():
        con.execute('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', (k, v))
    con.commit()


def clear_all_data(con):
    """清空所有数据 → 回到初始状态。

    与 default_seed 的区别：
      - 保留家长 PIN（default_seed 会重置为 1234）
      - 成员重置为「老大/老二/家长」出厂三个成员（与 default_seed 一致）
      - 重建默认任务体系与兑换清单
      - v15：成员 PIN 随成员一起重置为默认 1234（出厂成员即默认 PIN），
        并作废全部成员登录态（成员已被重建，旧 token 无意义）。
    """
    cur_pin = setting(con, 'parent_pin', '1234')
    default_seed(con, demo=False)      # 内部会重置 parent_pin=1234
    set_setting(con, 'parent_pin', cur_pin)   # 恢复用户 PIN
    # v15：成员已重建（新 pin 均为默认 1234 / pin_changed=0），清掉旧成员登录态
    MEMBER_TOKENS.clear()
    save_member_tokens()
    MEMBER_PIN_STATE.clear()
    con.commit()


def make_png(w, h, rgb=(226, 235, 252)):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    raw = (b'\x00' + bytes(rgb) * w) * h
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def default_seed(con, demo=False):
    """默认配置体系（v8）：一键清空数据 → 回到默认成员 + 默认配置。

    默认成员：老大（child）/ 老二（child）/ 家长（parent）
    默认配置：见 docs/任务列表与兑换清单设计方案_v3.md
      - 例行任务（每天例行 / 每周例行）
      - 专项任务
      - 兑换清单（按分类：自由支配金 / 自我投资 / 社交体验 / 数字时间 / 特权自主）

    demo=True 时额外造一条「已提交待审核」的实例与一条待确认兑换申请，
    便于本地演示/测试待办流；生产建库（reset_all）不带演示数据。
    """
    for t in ('ledger', 'files', 'spend_requests', 'instances', 'tasks', 'members', 'rewards', 'publish_requests'):
        con.execute(f'DELETE FROM {t}')
    set_setting(con, 'family_name', '家庭任务积分乐园')
    set_setting(con, 'parent_pin', '1234')
    set_setting(con, 'cost_refund', '1')
    set_setting(con, 'kid_publish_enabled', '1')
    set_setting(con, 'kid_publish_fee', '5')
    set_setting(con, 'kid_claim_cost', '5')
    set_setting(con, 'interest_rate', '3')

    con.execute('INSERT INTO members(name,role,sort,created_at) VALUES(?,?,?,?)', ('老大', 'child', 1, now_str()))
    con.execute('INSERT INTO members(name,role,sort,created_at) VALUES(?,?,?,?)', ('老二', 'child', 2, now_str()))
    con.execute('INSERT INTO members(name,role,sort,created_at) VALUES(?,?,?,?)', ('家长', 'parent', 3, now_str()))
    kid1 = con.execute("SELECT id FROM members WHERE name='老大'").fetchone()['id']
    kid2 = con.execute("SELECT id FROM members WHERE name='老二'").fetchone()['id']
    all_kids = '%d,%d' % (kid1, kid2)

    # ---------- 例行任务（每天例行） ----------
    # tag = 二级分类标签（学业 / 阅读 / 运动 / 生活 / 兴趣 / 品格）
    daily_tasks = [
        ('自主完成作业', '无需催促，按时完成全部作业；家长可抽查。', 50, '学业'),
        ('课外阅读 30 分钟', '主动阅读并能复述内容（口述或笔记均可）。', 40, '阅读'),
        ('每日运动', '运动 30 分钟（全周，不限周末）。', 30, '运动'),
        ('错题讲解', '订正错题，并能讲给家长听。', 30, '学业'),
        ('预习 / 复习', '主动预习或复习 15 分钟，能说出当天重点。', 30, '学业'),
        ('兴趣练习', '练琴/书法/编程等兴趣练习 30 分钟。', 30, '兴趣'),
        ('主动做家务', '完成当日指定家务 1 项（家长可按日轮换）。', 20, '生活'),
        ('每日答题', '每天固定 1 次，答对即得（家长出题）。', 30, '学业'),
    ]
    for title, desc, reward, tag in daily_tasks:
        con.execute("INSERT INTO tasks(type,title,description,reward,cost,weekday,kids,active,created_at,tag) "
                    "VALUES('daily',?,?,?,0,NULL,?,1,?,?)",
                    (title, desc, reward, all_kids, now_str(), tag))

    # ---------- 例行任务（每周例行） ----------
    routine_tasks = [
        ('按时作息', '早睡早起，一周全勤达标。', 50, '生活'),
        ('整理自己房间', '一周保持整洁达标。', 50, '生活'),
    ]
    for title, desc, reward, tag in routine_tasks:
        con.execute("INSERT INTO tasks(type,title,description,reward,cost,weekday,kids,active,created_at,tag) "
                    "VALUES('routine',?,?,?,0,NULL,?,1,?,?)",
                    (title, desc, reward, all_kids, now_str(), tag))

    # ---------- 专项任务 ----------
    special_tasks = [
        ('考试成绩优秀', '单科 90 分及以上（以学校正式考试为准）。', 2000, '学业'),
        ('成绩进步', '比上次提升约定幅度（奖励努力，而非天赋）。', 2500, '学业'),
        ('学科突破', '弱势学科单科提升一档（如 70 → 85）。', 3000, '学业'),
        ('读书并输出', '读完一本书，提交读书笔记 / 口述分享 / 思维导图。', 1200, '阅读'),
        ('深度研究性作业', '完成一份课题或探究性作业（非抄写类）。', 1500, '学业'),
        ('家庭贡献提案', '主动提出一个改善家庭生活的建议并落实。', 1000, '品格'),
        ('独立生活技能', '学会一项生活技能（做饭/洗衣/简单维修/理财记账）。', 800, '生活'),
        ('比赛获奖·校级', '校级比赛获奖。', 2000, '荣誉'),
        ('比赛获奖·区级', '区级比赛获奖。', 3500, '荣誉'),
        ('比赛获奖·市级及以上', '市级及以上比赛获奖。', 6000, '荣誉'),
        ('竞选 / 担任职务', '当选班干部或社团职务。', 2000, '荣誉'),
        ('公开表达', '演讲、表演、比赛上场等公开场合完成表达。', 1500, '品格'),
        ('长期项目达成', '完成一个跨月度的自定项目（学一门技能 / 完成作品）。', 4000, '兴趣'),
    ]
    for title, desc, reward, tag in special_tasks:
        con.execute("INSERT INTO tasks(type,title,description,reward,cost,weekday,kids,active,created_at,tag) "
                    "VALUES('special',?,?,?,0,NULL,'',1,?,?)",
                    (title, desc, reward, now_str(), tag))

    # ---------- 兑换清单（按分类） ----------
    # 格式：(分类, 名称, 所需积分, 限额周期, 限额次数)
    CAT_FREE = '自由支配金'
    CAT_INVEST = '自我投资'
    CAT_SOCIAL = '社交体验'
    CAT_DIGITAL = '数字时间'
    CAT_PRIVILEGE = '特权与自主'
    rewards = [
        (CAT_FREE, '零花钱 50 元', 5300, 'month', 2),
        (CAT_FREE, '零花钱 100 元', 10300, 'month', 1),
        (CAT_FREE, '零花钱 200 元', 20200, 'month', 1),
        (CAT_FREE, '零花钱 500 元（大额目标）', 49000, 'month', 1),
        (CAT_INVEST, '报名一门兴趣课 / 网课', 15000, 'month', 1),
        (CAT_INVEST, '买书（自选，≤100 元）', 10000, 'month', 1),
        (CAT_INVEST, '学习设备 / 文具升级', 30000, 'month', 3),
        (CAT_SOCIAL, '和同学外出（电影/聚餐）', 8000, 'month', 2),
        (CAT_SOCIAL, '一次独自出行 / 短途旅行', 30000, 'month', 1),
        (CAT_SOCIAL, '兴趣装备（球鞋/乐器/护具，≤300 元）', 31000, 'month', 1),
        (CAT_DIGITAL, '游戏 / 短视频 1 小时', 1500, 'week', 3),
        (CAT_DIGITAL, '游戏 / 短视频 3 小时（周末）', 4000, 'week', 1),
        (CAT_DIGITAL, '游戏内购（≤50 元）', 6000, 'month', 1),
        (CAT_PRIVILEGE, '自主安排一天（免家庭安排）', 5000, 'month', 2),
        (CAT_PRIVILEGE, '家庭决策「一票否决权」（具体事项）', 8000, 'month', 1),
    ]
    for cat, name, cost, lt, lc in rewards:
        con.execute('INSERT INTO rewards(name,cost,limit_type,limit_count,active,sort,category,created_at) '
                    'VALUES(?,?,?,?,1,0,?,?)', (name, cost, lt, lc, cat, now_str()))

    ensure_periods(con)
    # v13：默认任务的接取消耗统一按「奖励 × 接取费率 n%」计算（与孩子自建任务共用 n）
    resync_claim_cost(con)
    for t in con.execute("SELECT * FROM tasks WHERE type='special' AND active=1").fetchall():
        ensure_special_instances(con, t)

    if demo:
        # 演示：老大提交一份待审核的「整理自己房间」
        inst = con.execute("SELECT i.id FROM instances i JOIN tasks t ON t.id=i.task_id "
                           "WHERE t.title='整理自己房间' AND i.status='available' AND i.member_id=? LIMIT 1",
                           (kid1,)).fetchone()
        if inst:
            iid = inst['id']
            con.execute("UPDATE instances SET status='submitted',assignee_id=?,claimed_at=?,submitted_at=?,submit_note=? WHERE id=?",
                        (kid1, now_str(), now_str(), '房间已经整理好啦，照片为证。', iid))
            fn = 'demo_evidence_%s.png' % uuid.uuid4().hex[:8]
            with open(os.path.join(UPLOAD_DIR, fn), 'wb') as f:
                f.write(make_png(320, 200))
            con.execute('INSERT INTO files(instance_id,filename,path,size,created_at) VALUES(?,?,?,?,?)',
                        (iid, '演示照片.png', fn, 0, now_str()))
        # 演示：老大发起一条待确认的兑换申请
        rw = con.execute("SELECT id, cost FROM rewards WHERE name='游戏 / 短视频 1 小时'").fetchone()
        if rw:
            con.execute('INSERT INTO spend_requests(member_id,amount,note,status,created_at,kind,reward_id,quantity) '
                        'VALUES(?,?,?,?,?,?,?,?)',
                        (kid1, rw['cost'], '想这周五晚上用', 'pending', now_str(), 'reward', rw['id'], 1))
    con.commit()


def reset_all(con):
    """一键清空 → 回到默认成员（老大/老二/家长）与默认配置。"""
    default_seed(con, demo=False)
    # v15：成员被重建（PIN 全部回到默认 1234），旧成员登录态一并作废
    MEMBER_TOKENS.clear()
    save_member_tokens()
    MEMBER_PIN_STATE.clear()


def load_demo(con):
    """空库自动载入演示数据（FAMILY_AUTODEMO=1）：默认配置 + 少量待办演示。"""
    default_seed(con, demo=True)


def check_token(token):
    if not token:
        return False
    exp = TOKENS.get(token, 0)
    return exp > time.time()


def load_tokens():
    """启动时载入持久化的家长 token（顺手丢弃已过期项）。"""
    global TOKENS
    now = time.time()
    loaded = {}
    try:
        with open(TOKENS_FILE, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            for k, v in raw.items():
                try:
                    exp = float(v)
                except (TypeError, ValueError):
                    continue
                if isinstance(k, str) and exp > now:
                    loaded[k] = exp
    except (IOError, OSError, ValueError, TypeError):
        loaded = {}
    TOKENS = loaded


def save_tokens():
    """把 TOKENS 原子写入文件（失败不抛异常，只是退化为内存态）。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = TOKENS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(TOKENS, f)
        os.replace(tmp, TOKENS_FILE)
    except (IOError, OSError, ValueError, TypeError):
        pass


# ---------------- v15：成员（孩子）PIN 门禁 ----------------
def load_member_tokens():
    """启动时载入持久化的成员 token（丢弃已过期项）。"""
    global MEMBER_TOKENS
    now = time.time()
    loaded = {}
    try:
        with open(MEMBER_TOKENS_FILE, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            for k, v in raw.items():
                if not isinstance(k, str) or not isinstance(v, dict):
                    continue
                try:
                    mid = int(v.get('mid'))
                    exp = float(v.get('exp'))
                except (TypeError, ValueError):
                    continue
                if exp > now:
                    loaded[k] = {'mid': mid, 'exp': exp}
    except (IOError, OSError, ValueError, TypeError):
        loaded = {}
    MEMBER_TOKENS = loaded


def save_member_tokens():
    """把 MEMBER_TOKENS 原子写入文件（失败不抛异常）。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = MEMBER_TOKENS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(MEMBER_TOKENS, f)
        os.replace(tmp, MEMBER_TOKENS_FILE)
    except (IOError, OSError, ValueError, TypeError):
        pass


def member_pin_of(con, member_id):
    """读取某成员的 PIN（缺失一律按默认值）。"""
    r = con.execute('SELECT pin FROM members WHERE id=?', (member_id,)).fetchone()
    if not r:
        return ''
    pin = r['pin']
    return pin if pin else DEFAULT_MEMBER_PIN


def member_token_mid(token):
    """成员 token 对应的 member_id（无效/过期返回 0）。"""
    if not token:
        return 0
    rec = MEMBER_TOKENS.get(token)
    if not rec:
        return 0
    try:
        if float(rec.get('exp') or 0) <= time.time():
            return 0
        return int(rec.get('mid') or 0)
    except (TypeError, ValueError):
        return 0


def revoke_member_tokens(member_id):
    """作废某成员的全部登录态（家长改 / 重置该成员 PIN 时调用）。"""
    for tk in [k for k, v in MEMBER_TOKENS.items() if int(v.get('mid') or 0) == int(member_id)]:
        MEMBER_TOKENS.pop(tk, None)
    save_member_tokens()


def build_data():
    con = db()
    try:
        with LOCK:
            ensure_periods(con)
            settle_interest(con)
            grant_streak_rewards(con)   # v10：连续达标 → 生成待确认奖励（幂等）
        members = []
        for m in con.execute('SELECT * FROM members ORDER BY sort,id').fetchall():
            # v15：只暴露「是否仍为默认 PIN」的状态位，绝不把 PIN 明文下发给前端。
            members.append({'id': m['id'], 'name': m['name'], 'role': m['role'],
                            'balance': balance(con, m['id']),
                            'pin_changed': int(m['pin_changed'] or 0) == 1})
        tasks = [dict(r) for r in con.execute('SELECT * FROM tasks ORDER BY active DESC,id DESC').fetchall()]
        rewards = [dict(r) for r in con.execute('SELECT * FROM rewards ORDER BY active DESC,category,id DESC').fetchall()]
        wk = week_key_of()
        dk = day_key_of()
        # v7.0：主数据流只带「活跃实例 + 当期实例」；完整历史走 history:query 按需查询（突破保留量上限）
        inst_rows = con.execute('''
SELECT i.*, t.title AS task_title, t.type AS task_type, t.reward AS reward,
       COALESCE(i.claim_cost, t.cost) AS cost, t.description AS task_desc,
       m.name AS assignee_name
FROM instances i JOIN tasks t ON t.id=i.task_id
LEFT JOIN members m ON m.id=i.assignee_id
WHERE i.status IN ('available','in_progress','submitted')
   OR i.week_key = ? OR i.day_key = ?
ORDER BY i.id DESC LIMIT 1200''', (wk, dk)).fetchall()
        instances = []
        for r in inst_rows:
            d = dict(r)
            fl = con.execute('SELECT id,filename,path FROM files WHERE instance_id=?', (r['id'],)).fetchall()
            d['files'] = [{'id': f['id'], 'filename': f['filename'], 'url': '/uploads/' + f['path']} for f in fl]
            d['remain_sec'] = None
            if d['status'] == 'in_progress' and d.get('claimed_at'):
                try:
                    cl = datetime.strptime(d['claimed_at'], '%Y-%m-%d %H:%M:%S')
                    dl = cl + timedelta(hours=SUBMIT_DEADLINE_HOURS)
                    d['remain_sec'] = max(0, int((dl - datetime.now()).total_seconds()))
                except Exception:
                    pass
            instances.append(d)
        ledger = [dict(r) for r in con.execute('''
SELECT l.*, m.name AS member_name FROM ledger l JOIN members m ON m.id=l.member_id
ORDER BY l.id DESC LIMIT 150''').fetchall()]
        requests = [dict(r) for r in con.execute('''
SELECT s.*, m.name AS member_name, r.name AS reward_name, r.cost AS reward_cost
FROM spend_requests s JOIN members m ON m.id=s.member_id
LEFT JOIN rewards r ON r.id=s.reward_id
ORDER BY s.id DESC LIMIT 100''').fetchall()]
        # v11：购物车申请附带解析后的明细（前端渲染 + 家长端逐项勾选）
        for _r in requests:
            _r['items'] = parse_cart(_r.get('cart_items'))
        publish_requests = [dict(r) for r in con.execute('''
SELECT p.*, m.name AS member_name
FROM publish_requests p JOIN members m ON m.id=p.member_id
ORDER BY p.id DESC LIMIT 100''').fetchall()]
        kid_ids = [m['id'] for m in members if m['role'] == 'child']
        reward_usage = []
        for rw in rewards:
            start = period_start(rw['limit_type']) if rw['limit_type'] != 'none' else '1970-01-01'
            for mid_ in kid_ids:
                a = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                                "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='approved' AND decided_at>=?",
                                (rw['id'], mid_, start)).fetchone()['s']
                p = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                                "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='pending' AND created_at>=?",
                                (rw['id'], mid_, start)).fetchone()['s']
                if int(a) or int(p):
                    reward_usage.append({'reward_id': rw['id'], 'member_id': mid_,
                                         'approved': int(a), 'pending': int(p)})
        # v10：连续完成统计（每个每天例行任务 × 每名孩子）
        #   只输出结果导向的数字（当前连续天数 / 本月完成天数），前端按初中生口吻呈现。
        #   注意：这里不做 mid_ 过滤 —— 未指定孩子的公共任务以 member_id=0 输出，
        #   与 instances 的公共语义保持一致（否则公共任务永远查不到连续进度）。
        streaks = []
        for t in con.execute("SELECT id, title, kids FROM tasks WHERE type='daily' AND active=1").fetchall():
            for mid_ in (parse_kids(t['kids']) or [0]):
                st, last = daily_streak(con, t['id'], mid_)
                streaks.append({
                    'task_id': t['id'], 'member_id': mid_,
                    'title': t['title'],
                    'streak': st,
                    'month_count': month_done_count(con, t['id'], mid_),
                    'last_done': last,
                })
        data = {
            'ok': True,
            'server_time': now_str(),
            'week_key': wk,
            'day_key': dk,
            'settings': {
                'family_name': setting(con, 'family_name', '我的家'),
                'cost_refund': setting(con, 'cost_refund', '1') == '1',
                'submit_deadline_hours': SUBMIT_DEADLINE_HOURS,
                'kid_publish_enabled': setting(con, 'kid_publish_enabled', '1') == '1',
                'kid_publish_fee': max(0, setting_int(con, 'kid_publish_fee', 5)),
                'kid_claim_cost': max(0, setting_int(con, 'kid_claim_cost', 5)),
                'interest_rate': max(0, setting_int(con, 'interest_rate', 1)),
                'streak_reward_days': max(2, setting_int(con, 'streak_reward_days', 7)),
                'streak_reward_points': max(0, setting_int(con, 'streak_reward_points', 2000)),
            },
            'members': members,
            'tasks': tasks,
            'rewards': rewards,
            'reward_usage': reward_usage,
            'instances': instances,
            'ledger': ledger,
            'spend_requests': requests,
            'publish_requests': publish_requests,
            'streaks': streaks,
        }
        return data
    finally:
        con.close()


def handle_action(payload, token, member_token=''):
    if not isinstance(payload, dict):
        return {'ok': False, 'error': '参数格式不正确，请检查输入'}
    action = str(payload.get('action') or '')
    is_parent = action.startswith('parent:')
    if is_parent and action not in ('parent:login', 'parent:init') and not check_token(token):
        return {'ok': False, 'needLogin': True, 'error': '家长身份已过期，请重新输入 PIN'}
    # v15：需家长身份的动作（能力性，避开 member:* 的 startswith）
    if action in ('parent:set_member_pin', 'parent:reset_member_pin') and not check_token(token):
        return {'ok': False, 'needLogin': True, 'error': '家长身份已过期，请重新输入 PIN'}
    # v15：需成员登录态的动作 —— 校验 X-Member-Token 是否属于 payload 里的 member_id
    if action == 'member:ping':
        if not member_token_mid(member_token):
            return {'ok': False, 'needMemberLogin': True, 'error': '请先验证你的 PIN'}
    with LOCK:
        con = db()
        try:
            ensure_periods(con)
            settle_interest(con)
            if action == 'parent:login':
                now = time.time()
                if PIN_STATE['lock_until'] > now:
                    wait = int(PIN_STATE['lock_until'] - now) + 1
                    return {'ok': False, 'error': f'尝试次数过多，请 {wait} 秒后再试'}
                pin = str(payload.get('pin') or '')
                if pin and pin == setting(con, 'parent_pin', '1234'):
                    PIN_STATE['fails'] = 0
                    tk = uuid.uuid4().hex + uuid.uuid4().hex
                    TOKENS[tk] = time.time() + TOKEN_TTL
                    save_tokens()   # v13.1：持久化，服务重启后仍有效
                    return {'ok': True, 'token': tk}
                PIN_STATE['fails'] += 1
                if PIN_STATE['fails'] >= 5:
                    PIN_STATE['fails'] = 0
                    PIN_STATE['lock_until'] = now + PIN_LOCKOUT
                    return {'ok': False, 'error': f'连续输错 5 次，已锁定，请 {PIN_LOCKOUT} 秒后再试'}
                return {'ok': False, 'error': 'PIN 不正确'}

            if action == 'parent:ping':
                # v13.1：轻量 token 校验（前端在家长模式下刷新时调用）。
                #   无效 token 会在此前的统一校验处被拦下并返回 needLogin，
                #   前端据此及时提示「身份已过期」，而不是等某个操作莫名失败。
                return {'ok': True}

            # ---------- v15：成员（孩子）PIN 门禁 ----------
            if action == 'member:login':
                mid = int(payload.get('member_id', 0) or 0)
                m = con.execute('SELECT * FROM members WHERE id=?', (mid,)).fetchone()
                if not m:
                    return {'ok': False, 'error': '成员不存在'}
                if m['role'] != 'child':
                    return {'ok': False, 'error': '该成员不是孩子，无需在此进入'}
                now = time.time()
                st = MEMBER_PIN_STATE.get(mid) or {'fails': 0, 'lock_until': 0.0}
                if st['lock_until'] > now:
                    wait = int(st['lock_until'] - now) + 1
                    return {'ok': False, 'error': f'尝试次数过多，请 {wait} 秒后再试'}
                pin = str(payload.get('pin') or '')
                if pin and pin == member_pin_of(con, mid):
                    st['fails'] = 0
                    MEMBER_PIN_STATE[mid] = st
                    tk = uuid.uuid4().hex + uuid.uuid4().hex
                    MEMBER_TOKENS[tk] = {'mid': mid, 'exp': time.time() + TOKEN_TTL}
                    save_member_tokens()
                    # 首次仍为默认 PIN → 告知前端「必须修改」
                    return {'ok': True, 'token': tk, 'member_id': mid,
                            'pin_changed': int(m['pin_changed'] or 0) == 1,
                            'need_change': int(m['pin_changed'] or 0) != 1}
                st['fails'] = int(st.get('fails') or 0) + 1
                if st['fails'] >= 5:
                    st['fails'] = 0
                    st['lock_until'] = now + MEMBER_PIN_LOCKOUT
                    MEMBER_PIN_STATE[mid] = st
                    return {'ok': False, 'error': f'连续输错 5 次，已锁定，请 {MEMBER_PIN_LOCKOUT} 秒后再试'}
                MEMBER_PIN_STATE[mid] = st
                return {'ok': False, 'error': 'PIN 不正确'}

            if action == 'member:ping':
                # 轻量校验成员登录态（前端进入成员页前探测）
                return {'ok': True}

            if action == 'member:set_pin':
                mid = int(payload.get('member_id', 0) or 0)
                token_mid = member_token_mid(member_token)
                if not token_mid or token_mid != mid:
                    return {'ok': False, 'needMemberLogin': True, 'error': '请先验证你的 PIN'}
                old_pin = str(payload.get('old_pin') or '')
                new_pin = str(payload.get('new_pin') or '').strip()
                if old_pin != member_pin_of(con, mid):
                    return {'ok': False, 'error': '原 PIN 不正确'}
                if len(new_pin) < 4:
                    return {'ok': False, 'error': '新 PIN 至少 4 位'}
                if new_pin == DEFAULT_MEMBER_PIN:
                    return {'ok': False, 'error': '不能使用默认 PIN 1234，请设置一个新 PIN'}
                if new_pin == old_pin:
                    return {'ok': False, 'error': '新 PIN 与原 PIN 相同'}
                con.execute('UPDATE members SET pin=?, pin_changed=1 WHERE id=?', (new_pin, mid))
                con.commit()
                # 改 PIN 后作废该成员旧登录态，用新 PIN 重新验证（与家长端一致）
                revoke_member_tokens(mid)
                return {'ok': True}

            if action in ('parent:set_member_pin', 'parent:reset_member_pin'):
                mid = int(payload.get('member_id', 0) or 0)
                m = con.execute('SELECT * FROM members WHERE id=?', (mid,)).fetchone()
                if not m:
                    return {'ok': False, 'error': '成员不存在'}
                if action == 'parent:reset_member_pin':
                    new_pin = DEFAULT_MEMBER_PIN
                    mark_changed = 0
                else:
                    new_pin = str(payload.get('pin') or '').strip()
                    mark_changed = 1
                    if len(new_pin) < 4:
                        return {'ok': False, 'error': 'PIN 至少 4 位'}
                con.execute('UPDATE members SET pin=?, pin_changed=? WHERE id=?',
                            (new_pin, mark_changed, mid))
                con.commit()
                # 家长改 / 重置成员 PIN → 立即作废该成员登录态
                revoke_member_tokens(mid)
                return {'ok': True, 'pin_changed': bool(mark_changed)}

            if action == 'parent:init':
                # v8：默认配置体系下首次部署即带成员与配置，本动作仅在「完全空库」时可用
                #（如有人手工清空 members）。这里仅做兜底，正常不会触发。
                has_parent = con.execute("SELECT COUNT(*) AS c FROM members WHERE role='parent'").fetchone()['c'] > 0
                if has_parent:
                    return {'ok': False, 'error': '系统已初始化，无需重复设置'}
                fam = str(payload.get('family_name') or '我的家')[:50]
                kid = str(payload.get('child_name') or '孩子')[:30]
                par = str(payload.get('parent_name') or '家长')[:30]
                pin = str(payload.get('pin') or '')
                if len(pin) < 4:
                    return {'ok': False, 'error': 'PIN 至少 4 位'}
                set_setting(con, 'family_name', fam)
                set_setting(con, 'parent_pin', pin)
                # v8：初始化 = 从干净状态起步 → 清空默认配置后写入用户指定的成员
                for _t in ('ledger', 'files', 'spend_requests', 'instances', 'tasks', 'members',
                           'rewards', 'publish_requests'):
                    con.execute('DELETE FROM %s' % _t)
                con.execute('INSERT INTO members(name,role,sort,created_at,pin,pin_changed) '
                            'VALUES(?,?,?,?,?,0)', (kid, 'child', 1, now_str(), DEFAULT_MEMBER_PIN))
                con.execute('INSERT INTO members(name,role,sort,created_at,pin,pin_changed) '
                            'VALUES(?,?,?,?,?,0)', (par, 'parent', 2, now_str(), DEFAULT_MEMBER_PIN))
                con.commit()
                tk = uuid.uuid4().hex + uuid.uuid4().hex
                TOKENS[tk] = time.time() + TOKEN_TTL
                save_tokens()   # v13.1：持久化
                return {'ok': True, 'token': tk}

            if action == 'claim':
                iid, mid = int(payload.get('instance_id', 0)), int(payload.get('member_id', 0))
                inst = con.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
                if not inst:
                    return {'ok': False, 'error': '任务不存在'}
                m = con.execute('SELECT * FROM members WHERE id=?', (mid,)).fetchone()
                if not m or m['role'] != 'child':
                    return {'ok': False, 'error': '仅孩子可以接取任务'}
                if inst['member_id'] and inst['member_id'] != mid:
                    return {'ok': False, 'error': '该任务不在你的任务列表中'}
                if inst['status'] != 'available':
                    return {'ok': False, 'error': '该任务已被接取或已结束'}
                task = get_task(con, inst['task_id'])
                if not task or not task['active']:
                    return {'ok': False, 'error': '任务已停用'}
                if task['type'] == 'routine' and inst['week_key'] != week_key_of():
                    return {'ok': False, 'error': '仅可接取本周的例行任务'}
                if task['type'] == 'daily' and inst['day_key'] != day_key_of():
                    return {'ok': False, 'error': '仅可接取今天的任务'}
                bal = balance(con, mid)
                cost = int(task['cost'])
                if bal < cost:
                    return {'ok': False, 'error': f'积分不足：接取需 {cost} 分，当前 {bal} 分'}
                # v13：把本次实际扣除的成本写入实例快照（展示与退还都以它为准）
                upd = con.execute("UPDATE instances SET status='in_progress',assignee_id=?,claimed_at=?,claim_cost=? "
                                  "WHERE id=? AND status='available'",
                                  (mid, now_str(), cost, iid))
                if upd.rowcount != 1:
                    return {'ok': False, 'error': '手慢了，该任务刚被接取'}
                if cost > 0:
                    add_ledger(con, mid, -cost, 'claim', f'inst:{iid}', f"接取消耗：{task['title']}")
                con.commit()
                return {'ok': True}

            if action == 'submit':
                iid, mid = int(payload.get('instance_id', 0)), int(payload.get('member_id', 0))
                inst = con.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
                if inst and inst['assignee_id'] == mid and inst['status'] == 'overdue':
                    return {'ok': False, 'error': '任务已超时作废：接取后未在 %d 小时内提交，已扣除的积分不予退回'
                                                  % SUBMIT_DEADLINE_HOURS}
                if not inst or inst['assignee_id'] != mid or inst['status'] != 'in_progress':
                    return {'ok': False, 'error': '当前状态不可提交'}
                images = payload.get('files') or []
                if len(images) > MAX_FILES_PER_SUBMIT:
                    return {'ok': False, 'error': f'最多上传 {MAX_FILES_PER_SUBMIT} 个文件'}
                note = str(payload.get('note') or '')[:2000]
                if not images and not note.strip():
                    return {'ok': False, 'error': '请至少上传一张证据图片或填写说明'}
                saved = []
                for f in images:
                    name = str(f.get('name') or 'file')
                    ext = os.path.splitext(name)[1].lower()
                    if ext not in ALLOWED_EXT:
                        return {'ok': False, 'error': f'不支持的文件类型：{ext or name}'}
                    try:
                        raw = base64.b64decode(f.get('data') or '', validate=False)
                    except Exception:
                        return {'ok': False, 'error': f'文件解码失败：{name}'}
                    if not raw:
                        return {'ok': False, 'error': f'文件内容为空：{name}'}
                    if len(raw) > MAX_FILE_BYTES:
                        return {'ok': False, 'error': f'文件过大：{name}（上限 15MB）'}
                    fn = uuid.uuid4().hex + ext
                    with open(os.path.join(UPLOAD_DIR, fn), 'wb') as fp:
                        fp.write(raw)
                    saved.append((name, fn, len(raw)))
                con.execute("UPDATE instances SET status='submitted',submitted_at=?,submit_note=?,review_note='' WHERE id=?",
                            (now_str(), note, iid))
                for name, fn, size in saved:
                    con.execute('INSERT INTO files(instance_id,filename,path,size,created_at) VALUES(?,?,?,?,?)',
                                (iid, name, fn, size, now_str()))
                con.commit()
                return {'ok': True}

            if action == 'abandon':
                iid, mid = int(payload.get('instance_id', 0)), int(payload.get('member_id', 0))
                inst = con.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
                if not inst or inst['assignee_id'] != mid or inst['status'] not in ('in_progress', 'submitted'):
                    return {'ok': False, 'error': '当前状态不可放弃'}
                fl = con.execute('SELECT path FROM files WHERE instance_id=?', (iid,)).fetchall()
                for f in fl:
                    try:
                        os.remove(os.path.join(UPLOAD_DIR, f['path']))
                    except OSError:
                        pass
                con.execute('DELETE FROM files WHERE instance_id=?', (iid,))
                # 留档：插入一条放弃历史快照（v6.3）——周期键置空以避开唯一索引；created_at 记放弃时间
                con.execute("INSERT INTO instances(task_id,member_id,week_key,day_key,status,assignee_id,claimed_at,created_at) "
                            "VALUES(?,?,NULL,NULL,'abandoned',?,?,?)",
                            (inst['task_id'], inst['member_id'], mid, inst['claimed_at'], now_str()))
                con.execute("UPDATE instances SET status='available',assignee_id=NULL,claimed_at=NULL,submitted_at=NULL,submit_note='',review_note='' WHERE id=?",
                            (iid,))
                con.commit()
                return {'ok': True, 'note': '已放弃，接取消耗不退还'}

            if action == 'spend_request':
                mid = int(payload.get('member_id', 0))
                kind = payload.get('kind', 'free')
                note = str(payload.get('note') or '')[:500]
                # v11：购物车「一车一单」——items 数组一次提交多件兑换物
                if kind == 'cart':
                    raw_items = payload.get('items')
                    if not isinstance(raw_items, list) or not raw_items:
                        return {'ok': False, 'error': '购物车是空的，请先选择要兑换的内容'}
                    if len(raw_items) > 20:
                        return {'ok': False, 'error': '单次兑换种类过多（最多 20 种）'}
                    normalized, seen = [], {}
                    for it in raw_items:
                        if not isinstance(it, dict):
                            return {'ok': False, 'error': '购物车数据格式不正确'}
                        if str(it.get('kind') or 'reward') == 'free':
                            try:
                                amt = int(it.get('amount') or 0)
                            except (ValueError, TypeError):
                                return {'ok': False, 'error': '自由数值格式不正确'}
                            if amt <= 0:
                                return {'ok': False, 'error': '自由使用数值需大于 0'}
                            if amt > LIMIT_SPEND:
                                return {'ok': False, 'error': f'数值过大（单次上限 {LIMIT_SPEND}）'}
                            normalized.append({'reward_id': 0, 'name': '自由支配',
                                               'cost': amt, 'quantity': 1, 'amount': amt,
                                               'kind': 'free'})
                            continue
                        err, norm = validate_cart_item(con, mid, it)
                        if err:
                            return {'ok': False, 'error': err}
                        # 同一兑换项在购物车里合并数量，避免绕过 99 上限
                        rid = norm['reward_id']
                        if rid in seen:
                            merged = seen[rid]['quantity'] + norm['quantity']
                            if merged > 99:
                                return {'ok': False, 'error': f'「{norm["name"]}」单次兑换数量过多（最多 99）'}
                            seen[rid]['quantity'] = merged
                            seen[rid]['amount'] = seen[rid]['cost'] * merged
                        else:
                            seen[rid] = norm
                            normalized.append(norm)
                    total = cart_total(normalized)
                    if total <= 0:
                        return {'ok': False, 'error': '购物车合计为 0，请检查数量'}
                    bal = balance(con, mid)
                    if bal < total:
                        return {'ok': False, 'error': f'积分不足：购物车共需 {total} 分，当前 {bal} 分'}
                    con.execute('INSERT INTO spend_requests(member_id,amount,note,status,created_at,'
                                'kind,quantity,cart_items) VALUES(?,?,?,?,?,?,?,?)',
                                (mid, total, note, 'pending', now_str(), 'cart',
                                 len(normalized), json.dumps(normalized, ensure_ascii=False)))
                    con.commit()
                    return {'ok': True, 'amount': total, 'count': len(normalized)}
                if kind == 'reward':
                    rid = int(payload.get('reward_id', 0))
                    qty = int(payload.get('quantity', 1))
                    rw = con.execute('SELECT * FROM rewards WHERE id=?', (rid,)).fetchone()
                    if not rw or not rw['active']:
                        return {'ok': False, 'error': '该兑换项不存在或已停用'}
                    if qty < 1:
                        qty = 1
                    if qty > 99:
                        return {'ok': False, 'error': '单次兑换数量过多（最多 99）'}
                    total = int(rw['cost']) * qty
                    bal = balance(con, mid)
                    if bal < total:
                        return {'ok': False, 'error': f'积分不足：需要 {total} 分，当前 {bal} 分'}
                    if rw['limit_type'] != 'none':
                        start = period_start(rw['limit_type'])
                        used = quota_used(con, rid, mid, start)
                        if used + qty > int(rw['limit_count']):
                            remain = max(0, int(rw['limit_count']) - used)
                            return {'ok': False, 'error': f"超出限额：{period_label(rw['limit_type'])}最多可兑换 {rw['limit_count']} 次，当前剩余 {remain} 次"}
                    con.execute('INSERT INTO spend_requests(member_id,amount,note,status,created_at,kind,reward_id,quantity) '
                                'VALUES(?,?,?,?,?,?,?,?)',
                                (mid, total, note, 'pending', now_str(), 'reward', rid, qty))
                    con.commit()
                    return {'ok': True}
                amount = int(payload.get('amount', 0))
                if amount <= 0:
                    return {'ok': False, 'error': '请填写大于 0 的积分数值'}
                if amount > LIMIT_SPEND:
                    return {'ok': False, 'error': f'数值过大（单次上限 {LIMIT_SPEND}）'}
                bal = balance(con, mid)
                if bal < amount:
                    return {'ok': False, 'error': f'提交数值不能超过当前余额（{bal} 分）'}
                con.execute('INSERT INTO spend_requests(member_id,amount,note,status,created_at,kind) VALUES(?,?,?,?,?,?)',
                            (mid, amount, note, 'pending', now_str(), 'free'))
                con.commit()
                return {'ok': True}

            if action == 'history:query':
                # v7.0 历史按需查询：分页读取任意深度的流水/任务历史（突破 build_data 保留量上限）
                kind = str(payload.get('kind') or '')
                try:
                    mid = int(payload.get('member_id') or 0)
                    offset = max(0, int(payload.get('offset') or 0))
                    limit = max(1, min(int(payload.get('limit') or 5), 50))
                except (TypeError, ValueError):
                    return {'ok': False, 'error': '参数格式不正确，请检查输入'}
                if not mid or not con.execute('SELECT id FROM members WHERE id=?', (mid,)).fetchone():
                    return {'ok': False, 'error': '成员不存在'}
                if kind == 'ledger':
                    total = con.execute('SELECT COUNT(*) AS c FROM ledger WHERE member_id=?', (mid,)).fetchone()['c']
                    items = [dict(r) for r in con.execute('''
SELECT l.*, m.name AS member_name FROM ledger l JOIN members m ON m.id=l.member_id
WHERE l.member_id=? ORDER BY l.id DESC LIMIT ? OFFSET ?''', (mid, limit, offset)).fetchall()]
                    return {'ok': True, 'total': total, 'offset': offset, 'limit': limit, 'items': items}
                if kind == 'instance_history':
                    total = con.execute("SELECT COUNT(*) AS c FROM instances WHERE assignee_id=? "
                                        "AND status IN ('done','overdue','abandoned')", (mid,)).fetchone()['c']
                    rows = con.execute('''
SELECT i.*, t.title AS task_title, t.type AS task_type, t.reward AS reward, t.cost AS cost, t.description AS task_desc,
       m.name AS assignee_name
FROM instances i JOIN tasks t ON t.id=i.task_id
LEFT JOIN members m ON m.id=i.assignee_id
WHERE i.assignee_id=? AND i.status IN ('done','overdue','abandoned')
ORDER BY i.id DESC LIMIT ? OFFSET ?''', (mid, limit, offset)).fetchall()
                    items = []
                    for r in rows:
                        d2 = dict(r)
                        fl = con.execute('SELECT id,filename,path FROM files WHERE instance_id=?', (r['id'],)).fetchall()
                        d2['files'] = [{'id': f['id'], 'filename': f['filename'], 'url': '/uploads/' + f['path']} for f in fl]
                        d2['remain_sec'] = None
                        items.append(d2)
                    return {'ok': True, 'total': total, 'offset': offset, 'limit': limit, 'items': items}
                return {'ok': False, 'error': '未知的查询类型'}

            if action == 'kid:request_publish':
                # 孩子申请发布任务（仅发布给自己）：提交时快照发布费与接取消耗，等待家长处理
                if setting(con, 'kid_publish_enabled', '1') != '1':
                    return {'ok': False, 'error': '家长已关闭「孩子申请发布」功能，暂时无法申请'}
                mid = int(payload.get('member_id', 0))
                m = con.execute('SELECT * FROM members WHERE id=?', (mid,)).fetchone()
                if not m or m['role'] != 'child':
                    return {'ok': False, 'error': '仅孩子可以申请发布任务'}
                ttype = payload.get('type', 'special')
                if ttype not in ('routine', 'daily', 'special'):
                    return {'ok': False, 'error': '任务类型不正确'}
                title = str(payload.get('title') or '').strip()[:100]
                if not title:
                    return {'ok': False, 'error': '请填写任务名称'}
                desc = str(payload.get('description') or '')[:2000]
                reward = int(payload.get('reward') or 0)
                if reward < 1:
                    return {'ok': False, 'error': '请填写大于 0 的完成奖励积分'}
                if reward > LIMIT_TASK:
                    return {'ok': False, 'error': f'数值过大（单项上限 {LIMIT_TASK}）'}
                mrate = max(0, setting_int(con, 'kid_publish_fee', 5))
                nrate = max(0, setting_int(con, 'kid_claim_cost', 5))
                fee = reward * mrate // 100
                cost = reward * nrate // 100
                bal = balance(con, mid)
                if bal < fee:
                    return {'ok': False, 'error': f'积分不足：申请通过后需扣发布费 {fee} 分（奖励的 {mrate}%），当前 {bal} 分'}
                dup = con.execute("SELECT id FROM publish_requests WHERE member_id=? AND title=? AND status='pending'",
                                  (mid, title)).fetchone()
                if dup:
                    return {'ok': False, 'error': '你已有一个同名申请正在等待家长处理'}
                con.execute('INSERT INTO publish_requests(member_id,title,description,type,reward,fee,cost,status,created_at,tag) '
                            'VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (mid, title, desc, ttype, reward, fee, cost, 'pending', now_str(),
                             str(payload.get('tag') or '').strip()[:12]))
                con.commit()
                return {'ok': True, 'fee': fee, 'cost': cost}

            if action == 'parent:decide_publish':
                # 家长处理孩子发布申请：通过 = 扣发布费 + 创建任务（origin='kid'，仅该孩子）；驳回 = 不收费
                rid = int(payload.get('request_id', 0))
                approve = bool(payload.get('approve', False))
                r = con.execute('SELECT * FROM publish_requests WHERE id=?', (rid,)).fetchone()
                if not r or r['status'] != 'pending':
                    return {'ok': False, 'error': '该申请不存在或已处理'}
                if approve:
                    fee = int(r['fee'])
                    bal = balance(con, r['member_id'])
                    if bal < fee:
                        return {'ok': False, 'error': f"孩子当前余额不足：需扣发布费 {fee} 分，当前 {bal} 分，无法通过（可先驳回或等待孩子攒够积分）"}
                    add_ledger(con, r['member_id'], -fee, 'publish_fee', f"pub:{rid}", f"发布费：{r['title']}")
                    # v13：接取消耗按「当前的」接取费率 n% 重算（与全体任务保持同一规则；
                    #   发布费 fee 仍用申请时的快照——那是对孩子的费用承诺，不随设置变动）
                    task_cost = claim_cost_of(con, int(r['reward']))
                    cur = con.execute("INSERT INTO tasks(type,title,description,reward,cost,weekday,kids,active,origin,created_at,tag) "
                                      "VALUES(?,?,?,?,?,NULL,?,1,'kid',?,?)",
                                      (r['type'], r['title'], r['description'], int(r['reward']), task_cost,
                                       str(r['member_id']), now_str(), (r['tag'] if 'tag' in r.keys() else '') or ''))
                    tid = cur.lastrowid
                    rebuild_current_instances(con, tid)
                    con.execute("UPDATE publish_requests SET status='approved',task_id=?,decided_at=? WHERE id=?",
                                (tid, now_str(), rid))
                else:
                    con.execute("UPDATE publish_requests SET status='rejected',decided_at=? WHERE id=?",
                                (now_str(), rid))
                con.commit()
                return {'ok': True}

            if action == 'parent:approve':
                iid = int(payload.get('instance_id', 0))
                inst = con.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
                if not inst or inst['status'] != 'submitted':
                    return {'ok': False, 'error': '该任务不在待审核状态'}
                task = get_task(con, inst['task_id'])
                add_ledger(con, inst['assignee_id'], int(task['reward']), 'reward', f'inst:{iid}', f"任务奖励：{task['title']}")
                # v13：退还金额 = 该实例接取时实际扣除的积分（claim_cost 快照优先；
                #   快照缺失时回退查该实例的 claim 流水）——避免家长中途调整接取费率
                #   后出现「扣 2 分却退 5 分」这类不一致。
                paid = 0
                try:
                    paid = int(inst['claim_cost'] or 0)
                except (IndexError, KeyError):
                    paid = 0
                if paid <= 0:
                    row = con.execute("SELECT -delta AS paid FROM ledger WHERE type='claim' AND ref=? "
                                      "ORDER BY id DESC LIMIT 1", (f'inst:{iid}',)).fetchone()
                    paid = int(row['paid']) if row else 0
                if setting(con, 'cost_refund', '1') == '1' and paid > 0:
                    add_ledger(con, inst['assignee_id'], paid, 'refund', f'inst:{iid}', f"成本退还：{task['title']}")
                con.execute("UPDATE instances SET status='done',completed_at=? WHERE id=?", (now_str(), iid))
                con.commit()
                return {'ok': True}

            if action == 'parent:reject':
                iid = int(payload.get('instance_id', 0))
                inst = con.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
                if not inst or inst['status'] != 'submitted':
                    return {'ok': False, 'error': '该任务不在待审核状态'}
                con.execute("UPDATE instances SET status='in_progress',submitted_at=NULL,review_note=? WHERE id=?",
                            (str(payload.get('note') or '请补充或修改后重新提交')[:500], iid))
                con.commit()
                return {'ok': True}

            if action == 'parent:decide_request':
                rid = int(payload.get('request_id', 0))
                approve = bool(payload.get('approve', False))
                r = con.execute('SELECT * FROM spend_requests WHERE id=?', (rid,)).fetchone()
                if not r or r['status'] != 'pending':
                    return {'ok': False, 'error': '该申请已处理'}
                kind = r['kind'] or 'free'
                rw = None
                if kind == 'reward' and r['reward_id']:
                    rw = con.execute('SELECT * FROM rewards WHERE id=?', (r['reward_id'],)).fetchone()
                if kind == 'streak':
                    # v10：连续完成奖励 —— 确认即「加分」，不扣余额、不占兑换限额
                    if approve:
                        add_ledger(con, r['member_id'], int(r['amount']), 'streak', f"req:{rid}",
                                   r['note'] or '连续完成奖励')
                        con.execute("UPDATE spend_requests SET status='approved',decided_at=? WHERE id=?",
                                    (now_str(), rid))
                    else:
                        con.execute("UPDATE spend_requests SET status='rejected',decided_at=?,decision_note=? WHERE id=?",
                                    (now_str(), str(payload.get('note') or '')[:500], rid))
                    con.commit()
                    return {'ok': True}
                if kind == 'cart':
                    # v11：购物车「一车一单」——家长可勾选部分通过
                    #   approve=True/False → 整单全同意 / 全拒绝
                    #   payload.items = [明细下标数组] → 只通过选中的明细（其余视为拒绝）
                    items = parse_cart(r['cart_items'])
                    if not items:
                        return {'ok': False, 'error': '该申请没有可处理的明细'}
                    raw_sel = payload.get('items')
                    if isinstance(raw_sel, list):
                        picked = []
                        for i in raw_sel:
                            try:
                                idx = int(i)
                            except (ValueError, TypeError):
                                continue
                            if 0 <= idx < len(items) and idx not in picked:
                                picked.append(idx)
                        keep = [items[i] for i in sorted(picked)]
                    else:
                        keep = items if approve else []
                    if not keep:
                        con.execute("UPDATE spend_requests SET status='rejected',decided_at=?,decision_note=? WHERE id=?",
                                    (now_str(), str(payload.get('note') or '')[:500], rid))
                        con.commit()
                        return {'ok': True, 'approved_amount': 0}
                    # 逐项复查限额（家长点击时才最终确认，期间可能有其他申请被通过）
                    for it in keep:
                        if it['kind'] == 'free':
                            continue
                        rw = con.execute('SELECT * FROM rewards WHERE id=?', (it['reward_id'],)).fetchone()
                        if not rw or not rw['active']:
                            return {'ok': False, 'error': f"「{it['name']}」已不存在或已停用"}
                        if rw['limit_type'] != 'none':
                            start = period_start(rw['limit_type'])
                            a = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                                            "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='approved' AND decided_at>=?",
                                            (rw['id'], r['member_id'], start)).fetchone()['s']
                            # v11：购物车里的同项也要计入，否则可通过购物车绕过限额
                            a = int(a) + cart_quota_used(con, rw['id'], r['member_id'], start)
                            if int(a) + int(it['quantity']) > int(rw['limit_count']):
                                remain = max(0, int(rw['limit_count']) - int(a))
                                return {'ok': False,
                                        'error': f"「{rw['name']}」超出限额：{period_label(rw['limit_type'])}"
                                                 f"最多 {rw['limit_count']} 次，本期剩余 {remain} 次"}
                    total = cart_total(keep)
                    if total <= 0:
                        return {'ok': False, 'error': '选中项合计为 0'}
                    bal = balance(con, r['member_id'])
                    if bal < total:
                        return {'ok': False, 'error': f"余额不足：当前 {bal} 分，需扣除 {total} 分，无法确认"}
                    names = []
                    for it in keep:
                        if it['kind'] == 'free':
                            names.append(f"自由支配 {it['amount']} 分")
                        else:
                            names.append(f"{it['name']} ×{it['quantity']}")
                    full = len(keep) == len(items)
                    add_ledger(con, r['member_id'], -total, 'spend', f"req:{rid}",
                               ('兑换：' if full else '兑换（部分）：') + '、'.join(names))
                    con.execute("UPDATE spend_requests SET status='approved',decided_at=?,decision_note=? WHERE id=?",
                                (now_str(), '' if full else ('实际通过：' + '、'.join(names))[:500], rid))
                    con.commit()
                    return {'ok': True, 'approved_amount': total, 'approved_count': len(keep)}
                if approve:
                    bal = balance(con, r['member_id'])
                    if bal < r['amount']:
                        return {'ok': False, 'error': f"余额不足：当前 {bal} 分，需扣除 {r['amount']} 分，无法确认"}
                    if rw and rw['limit_type'] != 'none':
                        start = period_start(rw['limit_type'])
                        a = con.execute("SELECT COALESCE(SUM(quantity),0) AS s FROM spend_requests "
                                        "WHERE kind='reward' AND reward_id=? AND member_id=? AND status='approved' AND decided_at>=?",
                                        (rw['id'], r['member_id'], start)).fetchone()['s']
                        # v11：购物车里的同项也要计入
                        a = int(a) + cart_quota_used(con, rw['id'], r['member_id'], start)
                        if int(a) + int(r['quantity'] or 1) > int(rw['limit_count']):
                            remain = max(0, int(rw['limit_count']) - int(a))
                            return {'ok': False, 'error': f"超出限额：{period_label(rw['limit_type'])}最多 {rw['limit_count']} 次，本期剩余 {remain} 次"}
                    note = (f"兑换：{rw['name']} ×{r['quantity']}" if rw else '积分使用（家长确认）')
                    add_ledger(con, r['member_id'], -int(r['amount']), 'spend', f"req:{rid}", note)
                    con.execute("UPDATE spend_requests SET status='approved',decided_at=? WHERE id=?", (now_str(), rid))
                else:
                    con.execute("UPDATE spend_requests SET status='rejected',decided_at=?,decision_note=? WHERE id=?",
                                (now_str(), str(payload.get('note') or '')[:500], rid))
                con.commit()
                return {'ok': True}

            if action == 'parent:save_reward':
                rid = int(payload.get('reward_id') or 0)
                name = str(payload.get('name') or '').strip()[:60]
                if not name:
                    return {'ok': False, 'error': '请填写兑换名称'}
                cost = int(payload.get('cost') or 0)
                if cost < 1:
                    return {'ok': False, 'error': '所需积分至少为 1'}
                if cost > LIMIT_TASK:
                    return {'ok': False, 'error': f'数值过大（单项上限 {LIMIT_TASK}）'}
                lt = payload.get('limit_type', 'week')
                if lt not in ('day', 'week', 'month', 'none'):
                    lt = 'week'
                lc = max(1, int(payload.get('limit_count') or 1)) if lt != 'none' else 0
                category = str(payload.get('category') or '').strip()[:30]
                if rid:
                    if not con.execute('SELECT id FROM rewards WHERE id=?', (rid,)).fetchone():
                        return {'ok': False, 'error': '兑换项不存在'}
                    con.execute('UPDATE rewards SET name=?,cost=?,limit_type=?,limit_count=?,category=? WHERE id=?',
                                (name, cost, lt, lc, category, rid))
                else:
                    con.execute('INSERT INTO rewards(name,cost,limit_type,limit_count,active,category,created_at) VALUES(?,?,?,?,1,?,?)',
                                (name, cost, lt, lc, category, now_str()))
                con.commit()
                return {'ok': True}

            if action == 'parent:toggle_reward':
                rid = int(payload.get('reward_id', 0))
                active = 1 if payload.get('active') else 0
                con.execute('UPDATE rewards SET active=? WHERE id=?', (active, rid))
                con.commit()
                return {'ok': True}

            if action == 'parent:save_task':
                tid = int(payload.get('task_id') or 0)
                ttype = payload.get('type', 'special')
                if ttype not in ('routine', 'daily', 'special'):
                    return {'ok': False, 'error': '任务类型不正确'}
                title = str(payload.get('title') or '').strip()[:100]
                if not title:
                    return {'ok': False, 'error': '请填写任务名称'}
                desc = str(payload.get('description') or '')[:2000]
                reward = max(0, int(payload.get('reward') or 0))
                if reward > LIMIT_TASK:
                    return {'ok': False, 'error': f'数值过大（单项上限 {LIMIT_TASK}）'}
                # v13：接取消耗不再由家长手填，统一按「奖励 × 接取费率 n%」计算
                #   （n = settings.kid_claim_cost，与孩子自建任务共用同一配置）
                cost = claim_cost_of(con, reward)
                weekday = payload.get('weekday')
                weekday = int(weekday) if weekday not in (None, '', 'null') else None
                if weekday is not None and not (0 <= weekday <= 6):
                    weekday = None
                if ttype != 'routine':   # 建议完成日仅每周例行使用
                    weekday = None
                # 可接取的孩子：数组（空数组/缺省 = 全部孩子）；仅接受存在的孩子成员
                kids_raw = payload.get('kids')
                kids_ids = []
                if isinstance(kids_raw, list):
                    valid = {row['id'] for row in con.execute("SELECT id FROM members WHERE role='child'").fetchall()}
                    for x in kids_raw:
                        try:
                            xi = int(x)
                        except (TypeError, ValueError):
                            continue
                        if xi in valid and xi not in kids_ids:
                            kids_ids.append(xi)
                kids_str = ','.join(str(i) for i in kids_ids)
                tag = str(payload.get('tag') or '').strip()[:12]   # v9：任务标签（二级分类）
                if tid:
                    old = get_task(con, tid)
                    if not old:
                        return {'ok': False, 'error': '任务不存在'}
                    con.execute('UPDATE tasks SET type=?,title=?,description=?,reward=?,cost=?,weekday=?,kids=?,tag=? WHERE id=?',
                                (ttype, title, desc, reward, cost, weekday, kids_str, tag, tid))
                else:
                    cur = con.execute('INSERT INTO tasks(type,title,description,reward,cost,weekday,kids,active,created_at,tag) '
                                      'VALUES(?,?,?,?,?,?,?,1,?,?)',
                                      (ttype, title, desc, reward, cost, weekday, kids_str, now_str(), tag))
                    tid = cur.lastrowid
                rebuild_current_instances(con, tid)
                con.commit()
                return {'ok': True, 'task_id': tid}

            if action == 'parent:toggle_task':
                tid = int(payload.get('task_id', 0))
                active = 1 if payload.get('active') else 0
                con.execute('UPDATE tasks SET active=? WHERE id=?', (active, tid))
                if not active:
                    con.execute("UPDATE instances SET status='cancelled' WHERE task_id=? AND status='available'", (tid,))
                else:
                    rebuild_current_instances(con, tid)   # 启用后立即刷新为可接取状态
                con.commit()
                return {'ok': True}

            if action == 'parent:add_member':
                name = str(payload.get('name') or '').strip()[:30]
                role = payload.get('role', 'child')
                if not name:
                    return {'ok': False, 'error': '请填写名字'}
                if role not in ('child', 'parent'):
                    role = 'child'
                # v15：新成员统一带默认 PIN 1234（首次进入后强制修改）
                con.execute('INSERT INTO members(name,role,sort,created_at,pin,pin_changed) '
                            'VALUES(?,?,?,?,?,0)',
                            (name, role, int(time.time()), now_str(), DEFAULT_MEMBER_PIN))
                con.commit()
                return {'ok': True}

            if action == 'parent:rename_member':
                mid = int(payload.get('member_id', 0))
                name = str(payload.get('name') or '').strip()[:30]
                if not name:
                    return {'ok': False, 'error': '请填写名字'}
                con.execute('UPDATE members SET name=? WHERE id=?', (name, mid))
                con.commit()
                return {'ok': True}

            if action == 'parent:adjust':
                mid = int(payload.get('member_id', 0))
                delta = int(payload.get('delta', 0))
                if delta == 0:
                    return {'ok': False, 'error': '调整值不能为 0'}
                if abs(delta) > LIMIT_ADJUST:
                    return {'ok': False, 'error': f'调整幅度过大（单次上限 ±{LIMIT_ADJUST}）'}
                if balance(con, mid) + delta < 0:
                    return {'ok': False, 'error': '调整后余额不能为负数'}
                add_ledger(con, mid, delta, 'adjust', '', str(payload.get('note') or '')[:200] or '手动调整')
                con.commit()
                return {'ok': True}

            if action == 'parent:set_setting':
                key = payload.get('key', '')
                if key == 'family_name':
                    set_setting(con, 'family_name', str(payload.get('value') or '')[:50] or '我的家')
                elif key == 'parent_pin':
                    pin = str(payload.get('value') or '').strip()
                    if len(pin) < 4:
                        return {'ok': False, 'error': 'PIN 至少 4 位'}
                    set_setting(con, 'parent_pin', pin)
                    TOKENS.clear()
                    save_tokens()   # v13.1：改 PIN 后旧 token 全部作废（持久化同步清空）
                    PIN_STATE['fails'] = 0
                    PIN_STATE['lock_until'] = 0.0
                elif key == 'cost_refund':
                    set_setting(con, 'cost_refund', '1' if payload.get('value') else '0')
                elif key == 'kid_publish_enabled':
                    set_setting(con, 'kid_publish_enabled', '1' if payload.get('value') else '0')
                elif key in ('kid_publish_fee', 'kid_claim_cost', 'interest_rate'):
                    raw = payload.get('value')
                    bad = {'ok': False, 'error': '只能设置为大于等于 0 的整数'}
                    if raw is None or isinstance(raw, bool):
                        return bad
                    if isinstance(raw, float) and not raw.is_integer():
                        return bad
                    try:
                        iv = int(raw)
                    except (TypeError, ValueError):
                        return bad
                    if iv < 0:
                        return bad
                    set_setting(con, key, str(iv))
                    if key == 'kid_claim_cost':
                        # v13：接取费率 n 变更 → 所有任务的接取消耗自动同步重算
                        synced = resync_claim_cost(con)
                        con.commit()
                        return {'ok': True, 'synced': len(synced), 'changed': synced}
                else:
                    return {'ok': False, 'error': '未知设置项'}
                con.commit()
                return {'ok': True}

            if action == 'parent:load_demo':
                load_demo(con)
                con.commit()
                return {'ok': True}

            # ---------- v13：接取消耗手动重算（按当前 n 同步所有任务） ----------
            if action == 'parent:resync_claim_cost':
                changed = resync_claim_cost(con)
                con.commit()
                return {'ok': True, 'synced': len(changed), 'changed': changed}

            if action == 'parent:reset_all':
                reset_all(con)
                con.commit()
                return {'ok': True}

            # ---------- v12：配置导出/导入 ----------
            if action == 'parent:export_config':
                return {'ok': True, 'config': export_config(con)}

            if action == 'parent:import_config':
                doc = payload.get('config')
                err, normalized = validate_config(doc)
                if err:
                    # 校验失败：明确报错，绝不覆盖现有配置
                    return {'ok': False, 'error': err}
                changed = import_config(con, normalized)
                # v13：若导入的配置改动了接取费率 n，同步重算所有任务的接取消耗
                #   （与 parent:set_setting 的行为保持一致）
                synced = 0
                if any(c.get('key') == 'kid_claim_cost' for c in changed):
                    synced = len(resync_claim_cost(con))
                    con.commit()
                return {'ok': True, 'changed': changed, 'changed_count': len(changed),
                        'claim_cost_synced': synced}

            # ---------- v12：数据备份导入（导出走 GET /api/parent/backup） ----------
            if action == 'parent:import_backup':
                doc = payload.get('backup')
                err, data = validate_backup(doc)
                if err:
                    return {'ok': False, 'error': err}
                counts = {t: len(data.get(t) or []) for t in BACKUP_TABLES}
                import_backup(con, data)
                # v13：备份可能来自旧版本（任务 cost 是手填值）——按当前费率重算，
                #   保证导入后系统始终处于「cost = reward × n%」的一致状态。
                synced = len(resync_claim_cost(con))
                con.commit()
                return {'ok': True, 'counts': counts, 'claim_cost_synced': synced}

            # ---------- v12：清空所有数据（保留口令与家长 PIN） ----------
            if action == 'parent:clear_data':
                clear_all_data(con)
                return {'ok': True}

            return {'ok': False, 'error': '未知操作：' + action}
        finally:
            con.close()


class Handler(BaseHTTPRequestHandler):
    server_version = 'FamilyPoints/2.0'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _file(self, path):
        if not os.path.isfile(path):
            self._send(404, 'not found', 'text/plain; charset=utf-8')
            return
        ctype = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
                 '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
                 '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
                 '.pdf': 'application/pdf', '.svg': 'image/svg+xml'}.get(
            os.path.splitext(path)[1].lower(), 'application/octet-stream')
        with open(path, 'rb') as f:
            data = f.read()
        self._send(200, data, ctype)

    # ---------- 访问口令与登录会话（一次登录，一年免重复） ----------
    def _access_conf(self):
        return (os.environ.get('FAMILY_ACCESS_USER', ''),
                os.environ.get('FAMILY_ACCESS_PASS', ''))

    def _session_cookie(self):
        raw = self.headers.get('Cookie', '') or ''
        for part in raw.split(';'):
            part = part.strip()
            if part.startswith('fp_session='):
                return part[len('fp_session='):]
        return ''

    def _make_session(self, user, pwd):
        exp = int(time.time()) + 365 * 24 * 3600
        payload = '%s|%d' % (user, exp)
        sig = hmac.new(('fp-secret:' + pwd).encode('utf-8'), payload.encode('utf-8'),
                       hashlib.sha256).hexdigest()[:40]
        return base64.urlsafe_b64encode((payload + '|' + sig).encode('utf-8')).decode('ascii').rstrip('=')

    def _valid_session(self, token, user, pwd):
        if not token:
            return False
        try:
            pad = '=' * (-len(token) % 4)
            raw = base64.urlsafe_b64decode(token + pad).decode('utf-8', 'replace')
            parts = raw.split('|')
            if len(parts) != 3:
                return False
            payload = parts[0] + '|' + parts[1]
            want = hmac.new(('fp-secret:' + pwd).encode('utf-8'), payload.encode('utf-8'),
                            hashlib.sha256).hexdigest()[:40]
            if not (hmac.compare_digest(parts[2], want) and hmac.compare_digest(parts[0], user)):
                return False
            return int(parts[1]) > time.time()
        except Exception:
            return False

    def _basic_ok(self, user, pwd):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Basic '):
            return False
        try:
            got = base64.b64decode(auth[6:].strip()).decode('utf-8', 'replace')
        except Exception:
            return False
        return hmac.compare_digest(got, '%s:%s' % (user, pwd))

    def _auth_ok(self):
        user, pwd = self._access_conf()
        if not user:
            return True
        return self._valid_session(self._session_cookie(), user, pwd) or self._basic_ok(user, pwd)

    def _redirect(self, target):
        self.send_response(303)
        self.send_header('Location', target)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _handle_login(self):
        user, pwd = self._access_conf()

        def _urldecode(s):
            s = s.replace('+', ' ')
            out = []
            i = 0
            n = len(s)
            while i < n:
                if s[i] == '%' and i + 2 < n:
                    try:
                        out.append(chr(int(s[i + 1:i + 3], 16)))
                        i += 3
                        continue
                    except Exception:
                        pass
                out.append(s[i])
                i += 1
            return ''.join(out)

        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace') if length else ''
        except Exception:
            raw = ''
        form = {}
        for kv in raw.split('&'):
            if '=' in kv:
                k, v = kv.split('=', 1)
                form[_urldecode(k)] = _urldecode(v)
        if hmac.compare_digest(form.get('user', ''), user) and hmac.compare_digest(form.get('pass', ''), pwd):
            token = self._make_session(user, pwd)
            self.send_response(303)
            self.send_header('Location', '/')
            self.send_header('Set-Cookie',
                             'fp_session=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax'
                             % (token, 365 * 24 * 3600))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self._send_login_page('账号或口令不正确，请重试')

    def _send_login_page(self, error=''):
        err_html = ('<div class="err">%s</div>' % error) if error else ''
        html = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1C1C24">
<title>登录 · 家庭任务积分乐园</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236ea87d'/%3E%3Cstop offset='1' stop-color='%234f8160'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='%231C1C24'/%3E%3Cpath d='M32 12l5.6 14.4L52 32l-14.4 5.6L32 52l-5.6-14.4L12 32l14.4-5.6z' fill='url(%23g)'/%3E%3C/svg%3E">
<style>
* { box-sizing: border-box; }
html { height: 100%; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 22px; font: 15px/1.6 "PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif; color: #e8e8ee;
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: #1C1C24;
  background: radial-gradient(900px 460px at 92% -6%, rgba(100,156,116,.14) 0%, rgba(100,156,116,0) 62%),
              radial-gradient(760px 420px at -8% 2%, rgba(79,129,96,.12) 0%, rgba(79,129,96,0) 58%), #1C1C24; }
.card { width: 100%; max-width: 380px; background: #26262e; border: 1px solid #3a3a44;
  border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 30px 26px 24px;
  margin: auto; }   /* v14：flex 失效时 margin:auto 仍可居中 */
.logo { width: 54px; height: 54px; border-radius: 14px; margin: 0 auto 14px; color: #fff; font-weight: 800; font-size: 27px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg,#6ea87d,#4f8160); box-shadow: 0 10px 24px rgba(100,156,116,.4); }
h1 { font-size: 20px; text-align: center; margin: 0 0 6px; letter-spacing: .3px; color: #e8e8ee; }
.sub { text-align: center; color: #a0a0ad; font-size: 12.5px; margin: 0 0 20px; }
label { display: block; font-size: 13px; font-weight: 700; color: #a0a0ad; margin: 12px 0 6px; }
input { width: 100%; padding: 13px 14px; border: 1.5px solid #3a3a44; border-radius: 8px;
  font: inherit; font-size: 16px; background: #3B3B42; color: #e8e8ee; }
input:focus { outline: none; border-color: #649C74; box-shadow: 0 0 0 4px rgba(100,156,116,.18); background: #3B3B42; }
button { width: 100%; margin-top: 18px; padding: 13px; border: none; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: 15px; font-weight: 800; color: #fff; letter-spacing: 2px;
  background: linear-gradient(135deg,#6ea87d,#4f8160); box-shadow: 0 10px 22px rgba(100,156,116,.32);
  transition: filter .15s ease, transform .15s ease; }
button:hover { filter: brightness(1.06); }
button:active { transform: scale(.98); }
.err { background: #4a2422; color: #f0a3a0; border-radius: 8px; padding: 10px 13px; font-size: 13.5px;
  font-weight: 600; margin-bottom: 4px; }
.tips { text-align: center; color: #7c7c8a; font-size: 12px; margin: 16px 0 0; }
</style></head>
<body>
<div class="card">
  <div class="logo">家</div>
  <h1>家庭任务积分乐园</h1>
  <p class="sub">登录一次，一年内在本设备免重复输入</p>
  __ERROR__
  <form method="post" action="/login">
    <label>访问账号</label>
    <input name="user" type="text" autocomplete="username">
    <label>访问口令</label>
    <input name="pass" type="password" autocomplete="current-password">
    <button type="submit">进入系统</button>
  </form>
  <p class="tips">手机与电脑首次登录后都会自动记住，无需每次输入</p>
</div>
</body></html>'''
        html = html.replace('__ERROR__', err_html)
        self._send(200, html, 'text/html; charset=utf-8')

    def _check_access(self):
        """公网访问口令关卡：通过放行；未通过按场景返回登录页或 401。

        ⚠️ 此处【刻意不发送 `WWW-Authenticate: Basic`】（2026-10-14 修复）：
          一旦发送，浏览器遇到 401 会尝试弹出**原生 Basic 登录框**并挂起该请求
          —— 实测 fetch 与 XHR 均**永久 pending**（6 秒超时也未返回），
          现象是「访问口令会话过期后，已打开的应用页点任何按钮都毫无反应」。
          我们的 Basic 消费者是脚本 / 工具，它们**主动**带上 `Authorization`
          头，从不依赖服务端"质询"，因此去掉该头零损失。
          另：API 路径改为返回 JSON，前端才能识别 401 并跳回登录页。
        """
        user, _pwd = self._access_conf()
        if not user or self._auth_ok():
            return True
        path = urlparse(self.path).path
        if self.command == 'GET' and path == '/':
            self._send_login_page()
            return False
        if path.startswith('/api/'):
            self._json({'ok': False, 'needAccess': True, 'error': '需要访问口令'}, 401)
        else:
            self._send(401, '需要访问口令，请先登录', 'text/plain; charset=utf-8')
        return False

    def do_GET(self):
        if urlparse(self.path).path == '/login':
            if self._auth_ok():
                self._redirect('/')
            else:
                self._send_login_page()
            return
        if not self._check_access():
            return
        url = urlparse(self.path)
        path = url.path
        if path == '/api/data':
            try:
                self._json(build_data())
            except Exception:
                self._json({'ok': False, 'error': '服务器内部错误，请稍后重试'}, 500)
            return
        # v13.1：三个导出接口统一带 Content-Disposition（attachment + 文件名）。
        #   此前只靠前端 <a download> 触发下载，响应头缺失时浏览器（尤其 Edge）
        #   可能把 JSON 响应判为「不安全/无权限下载」而直接拦截。
        if path in ('/api/parent/export', '/api/parent/backup', '/api/parent/config'):
            is_cfg = (path == '/api/parent/config')
            fname = 'family-config.json' if is_cfg else 'family-backup.json'
            token = (parse_qs(url.query).get('token') or [''])[0]
            if not check_token(token):
                self._json({'ok': False, 'error': '家长身份无效或已过期，请重新输入 PIN 后再试'}, 403)
                return
            con = db()
            try:
                doc = export_config(con) if is_cfg else export_backup(con)
                body = json.dumps(doc, ensure_ascii=False, indent=1)
                self._send(200, body, 'application/json; charset=utf-8',
                           [('Content-Disposition', 'attachment; filename="%s"' % fname)])
            finally:
                con.close()
            return
        if path.startswith('/uploads/'):
            name = os.path.basename(path)
            self._file(os.path.join(UPLOAD_DIR, name))
            return
        if path.startswith('/static/'):
            name = path[len('/static/'):]
            safe = os.path.join(STATIC_DIR, os.path.basename(name))
            self._file(safe)
            return
        if path == '/' or path == '/index.html':
            self._file(os.path.join(STATIC_DIR, 'index.html'))
            return
        self._send(404, 'not found', 'text/plain; charset=utf-8')

    def do_POST(self):
        if urlparse(self.path).path == '/login':
            self._handle_login()
            return
        if not self._check_access():
            return
        url = urlparse(self.path)
        if url.path != '/api/action':
            self._json({'ok': False, 'error': '接口不存在'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json({'ok': False, 'error': '请求体过大或为空'}, 413)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            self._json({'ok': False, 'error': '请求格式错误'})
            return
        token = self.headers.get('X-Parent-Token', '')
        member_token = self.headers.get('X-Member-Token', '')
        try:
            result = handle_action(payload, token, member_token)
        except (ValueError, TypeError, OverflowError):
            result = {'ok': False, 'error': '参数格式不正确，请检查输入'}
        except Exception:
            result = {'ok': False, 'error': '服务器内部错误，请稍后重试'}
        self._json(result)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    os.makedirs(DATA_DIR, exist_ok=True)
    init_db()
    load_tokens()   # v13.1：恢复持久化的家长 token（避免重启后家长端掉线）
    load_member_tokens()   # v15：恢复持久化的成员 token（避免重启后成员端掉线）
    # v8：空库自动载入默认配置（老大/老二/家长 + 默认任务与兑换）；
    #     AUTODEMO=1 时额外带待办演示数据（本地开发用）。
    con = db()
    try:
        n = con.execute('SELECT COUNT(*) AS c FROM members').fetchone()['c']
        if n == 0:
            default_seed(con, demo=AUTODEMO)
            print('[初始化] 已载入默认配置（老大 / 老二 / 家长 + 默认任务与兑换清单）', flush=True)
    finally:
        con.close()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('=' * 52, flush=True)
    print('家庭任务积分乐园 已启动', flush=True)
    print(f'本机访问：      http://127.0.0.1:{PORT}', flush=True)
    print(f'手机/平板访问： http://{lan_ip()}:{PORT}   （需同一 Wi-Fi）', flush=True)
    print('按 Ctrl+C 停止服务', flush=True)
    print('=' * 52, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止', flush=True)


if __name__ == '__main__':
    main()
