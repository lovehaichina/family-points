# -*- coding: utf-8 -*-
"""忘记家长 PIN 时的重置工具：先将系统服务停掉，再运行本脚本，PIN 将重置为 1234。"""
import os
import sqlite3

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'data', 'family.db')

if not os.path.exists(DB):
    print('未找到数据库文件：', DB)
    print('（请先启动一次系统，让数据库自动创建）')
else:
    con = sqlite3.connect(DB)
    con.execute("INSERT INTO settings(key,value) VALUES('parent_pin','1234') "
                "ON CONFLICT(key) DO UPDATE SET value='1234'")
    con.commit()
    con.close()
    print('家长 PIN 已重置为 1234。请启动系统后尽快在「设置」中修改。')

try:
    input('按回车键退出...')
except EOFError:
    pass
