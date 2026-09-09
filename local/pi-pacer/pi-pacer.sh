#!/bin/bash
# pi-pacer.sh — 【通用 pi 会话配速员（pacer）】
# 像马拉松配速员一样盯着一个 pi session：自己不跑（零模型调用），
# 跟着跑（持续监控），掉速就提醒（续命消息），让 agent 以稳定节奏持续自我改进。
# 泛化自 frontier-radar 的 monitor-optimize-session.sh（v3）。
#
# 用法:
#   pi-pacer.sh start <session-file> [选项]   对一个会话开始领跑（后台常驻）
#   pi-pacer.sh stop <session-file>           停止该会话的配速（不影响 agent 当前轮）
#   pi-pacer.sh list                          看板：所有领跑中的配速员一览
#   pi-pacer.sh log <session-file>            尾随该配速员的领跑日志
#
# start 选项:
#   --until "YYYY-MM-DD HH:MM"   值班截止时刻（默认 8 小时后）
#   --hours N                    值班时长（小时，默认 8；与 --until 二选一）
#   --provider NAME              模型 provider（默认 meituan-aigc）
#   --model NAME                 模型（默认 glm-5.3）
#   --stale N                    停滞阈值秒数（默认 300）
#   --revive-msg "..."           首轮复活消息（默认通用「继续优化迭代」模板）
#   --keep-msg "..."             维持消息（默认「继续。」）
#   --no-confirm                 复活后不发确认消息
#   --no-kill-host               检测到宿主 TUI 存活时不杀进程（默认杀掉避免双写）
#   --no-probe                   禁用出手前 provider 探活
#   --probe-url URL              探活端点（默认 meituan-aigc /models）
#
# 检测逻辑（与 pidash 同源思路，零依赖）:
#   - 会话 jsonl mtime 持续更新 → 正常运行，只记心跳
#   - 停滞 ≥ 阈值且宿主 TUI 进程存活 → 异常停止：杀宿主（可关）后续命
#   - 停滞 ≥ 阈值且无宿主 → 已终止：首轮 RPC 恢复（compact→复活→确认），后续发维持消息
# 网络韧性:
#   - 出手前探活 provider（HTTP 状态码 ≠000 即可达，无凭证 401 属正常）
#   - 连续失败 ≥3 轮指数退避（5→10→20→30min 封顶），成功即清零
#   - 连续失败 ≥3 轮发 macOS 通知（每 30min 最多一条）
#
# 状态目录: ~/.pi/agent/pacer/<sid>.{json,pid,log,continue.log}

set -u

PACER_HOME="$HOME/.pi/agent/pacer"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
REVIVE_MJS="$(cd "$(dirname "$0")" && pwd)/pi-pacer-revive.mjs"
mkdir -p "$PACER_HOME"

# ---------- 公共小工具 ----------

die() { echo "❌ $*" >&2; exit 1; }

sid_of() {
	local f="$1"
	basename "$f" .jsonl
}

status_file() { echo "$PACER_HOME/$(sid_of "$1").json"; }
pid_file()    { echo "$PACER_HOME/$(sid_of "$1").pid"; }
log_file()    { echo "$PACER_HOME/$(sid_of "$1").log"; }
cont_file()   { echo "$PACER_HOME/$(sid_of "$1").continue.log"; }

# ---------- 会话元信息（python 一次读齐: cwd / 宿主进程探测） ----------

# 输出: "<project_cwd>\t<host_pid 或空>"
probe_session_meta() {
	local session_file="$1"
	python3 - "$session_file" <<'PYEOF'
import json, os, re, subprocess, sys, time

session_file = sys.argv[1]

# 1) 项目 cwd：读会话 header 第一行的 cwd 字段
cwd = None
try:
    with open(session_file, "rb") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("type") == "session":
                cwd = d.get("cwd")
            break
except Exception:
    pass

# 2) 会话创建时间（文件名时间戳 → epoch ms）
create_ms = None
m = re.search(r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z", os.path.basename(session_file))
if m:
    import calendar
    y, mo, dd, h, mi, s, ms = m.groups()
    create_ms = calendar.timegm((int(y), int(mo), int(dd), int(h), int(mi), int(s), 0, 0, 0)) * 1000 + int(ms)
else:
    create_ms = int(os.path.getctime(session_file) * 1000)

# 3) 找所有 pi 进程及其 cwd（lsof），筛出 cwd 匹配的；
#    配对规则（pidash 同源，带强绑定互斥，防误配到其他会话的 TUI）:
#    a) |文件创建时间 - 进程启动| <= 5s → 新会话强绑定
#    b) 进程若已被同目录另一文件强绑定 → 它属于那个会话，跳过
#    c) 无强绑定时：创建<=启动+5s 且 启动后写过（resume 场景），取启动最新的
host_pid = ""
if cwd:
    import calendar
    try:
        sess_dir = os.path.dirname(session_file)
        # 同目录所有会话文件的创建时间
        create_ms_all = {}
        for fn in os.listdir(sess_dir):
            if not fn.endswith(".jsonl"):
                continue
            m2 = re.search(r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z", fn)
            if m2:
                y, mo, dd, h, mi, s, ms = m2.groups()
                create_ms_all[fn] = calendar.timegm((int(y), int(mo), int(dd), int(h), int(mi), int(s), 0, 0, 0)) * 1000 + int(ms)

        ps = subprocess.run(["ps", "-axo", "pid,etime,command"], capture_output=True, text=True).stdout
        lsof = subprocess.run(["lsof", "-a", "-d", "cwd", "-F", "pn"], capture_output=True, text=True).stdout
        cwd_by_pid = {}
        cur_pid = None
        for tok in lsof.split("\n"):
            if tok.startswith("p") and tok[1:].isdigit():
                cur_pid = tok[1:]
            elif tok.startswith("n") and cur_pid:
                cwd_by_pid[cur_pid] = tok[1:]

        def parse_etime(s):
            # [dd-]hh:mm:ss | mm:ss | ss → 秒（locale 无关）
            days, rest = 0, s
            if "-" in s:
                days, rest = s.split("-", 1)
                days = int(days)
            parts = [int(x) for x in rest.split(":") if x]
            sec = 0
            if len(parts) == 3: sec = parts[0]*3600 + parts[1]*60 + parts[2]
            elif len(parts) == 2: sec = parts[0]*60 + parts[1]
            elif parts: sec = parts[0]
            return days*86400 + sec

        target_fn = os.path.basename(session_file)
        mtime_ms = int(os.path.getmtime(session_file) * 1000)
        resume_candidates = []
        for line in ps.splitlines()[1:]:
            parts = line.strip().split(None, 2)
            if len(parts) < 3:
                continue
            pid, etime, cmd = parts[0], parts[1], " ".join(parts[2:]).strip()
            if not cmd.startswith("pi"):
                continue
            if cwd_by_pid.get(pid) != cwd:
                continue
            start_ms = int((time.time() - parse_etime(etime)) * 1000)
            # ① 精确证据：headless 续命进程命令行里带 --session <该文件>
            if "--session" in cmd and session_file in cmd:
                host_pid = pid
                break
            # 纯 TUI 进程（command 恰为 "pi"）才参与后续配对
            if cmd != "pi":
                continue
            # ② 该进程的强绑定文件（同目录其他会话）
            strong = [fn for fn, cm in create_ms_all.items() if abs(cm - start_ms) <= 5000]
            if strong:
                if target_fn in strong:
                    host_pid = pid  # 新会话强绑定，直接命中
                    break
                else:
                    continue  # 它属于别的会话
            # ③ resume 场景：创建<=启动+5s 且 启动 5 秒后仍在写
            #    （严格要求 mtime>start+5s：排除刚启动、恰好赶上别人写入的
            #     --no-session 巡检进程等无关 pi）
            if create_ms is not None and create_ms <= start_ms + 5000 and mtime_ms >= start_ms + 5000:
                resume_candidates.append((start_ms, pid))
        if not host_pid and resume_candidates:
            resume_candidates.sort(reverse=True)
            host_pid = resume_candidates[0][1]
    except Exception as e:
        print(f"PROBE-ERROR: {e}", file=sys.stderr)

print(f"{cwd or ''}\t{host_pid}")
PYEOF
}

# ---------- 子命令: start ----------

cmd_start() {
	local session_file="" until_str="" hours=8 provider=meituan-aigc model=glm-5.3 stale=300
	local revive_msg="" keep_msg="继续。" confirm=yes kill_host=yes probe=yes
	local probe_url="https://aigc.sankuai.com/v1/openai/native/models"

	while [ $# -gt 0 ]; do
		case "$1" in
			--until)       until_str="$2"; shift 2 ;;
			--hours)       hours="$2"; shift 2 ;;
			--provider)    provider="$2"; shift 2 ;;
			--model)       model="$2"; shift 2 ;;
			--stale)       stale="$2"; shift 2 ;;
			--revive-msg)  revive_msg="$2"; shift 2 ;;
			--keep-msg)    keep_msg="$2"; shift 2 ;;
			--no-confirm)  confirm=no; shift ;;
			--no-kill-host) kill_host=no; shift ;;
			--no-probe)    probe=no; shift ;;
			--probe-url)   probe_url="$2"; shift 2 ;;
			-*)            die "未知选项: $1（见头部注释）" ;;
			*)             session_file="$1"; shift ;;
		esac
	done

	[ -n "$session_file" ] || die "用法: pi-pacer.sh start <session-file> [选项]"
	[ -f "$session_file" ] || die "会话文件不存在: $session_file"
	session_file=$(cd "$(dirname "$session_file")" && pwd)/$(basename "$session_file")

	local sid
	sid=$(sid_of "$session_file")

	# 已有配速员领跑 → 拒绝
	if [ -f "$(pid_file "$session_file")" ]; then
		local oldpid
		oldpid=$(cat "$(pid_file "$session_file")")
		if kill -0 "$oldpid" 2>/dev/null; then
			die "会话 $sid 已有配速员领跑（PID $oldpid）。先 stop 再 start。"
		fi
	fi

	# 截止时间
	local end_epoch
	if [ -n "$until_str" ]; then
		end_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$until_str" +%s 2>/dev/null) || die "--until 格式应为 \"YYYY-MM-DD HH:MM\""
	else
		# bash 算术不支持小数：换算成分钟四舍五入（支持 0.02 这样的短时测试）
		local mins
		mins=$(python3 -c "print(round(float('$hours') * 60))")
		end_epoch=$(( $(date +%s) + mins * 60 ))
	fi

	# 探测会话元信息（项目 cwd + 宿主 TUI 进程）
	local meta cwd host_pid
	meta=$(probe_session_meta "$session_file")
	cwd=${meta%%	*}
	host_pid=${meta##*	}
	[ -z "$cwd" ] && cwd="$PWD"

	# 写配置（供 --run 与看板读取）
	[ -z "$revive_msg" ] && revive_msg="继续优化迭代当前项目。请先阅读 AGENTS.md / FEEDBACK.md（如有）及最近的任务书或报告，结合 git log 近况，选择下一个高价值优化点（缺陷修复 > 测试补齐 > 性能 > 文档），小步快跑，每完成一项即 git 提交并简述成果。"
	python3 - "$session_file" "$cwd" "$host_pid" "$end_epoch" "$stale" "$provider" "$model" \
		"$revive_msg" "$keep_msg" "$confirm" "$kill_host" "$probe" "$probe_url" <<'PYEOF'
import json, sys
(
    session_file, cwd, host_pid, end_epoch, stale, provider, model,
    revive_msg, keep_msg, confirm, kill_host, probe, probe_url
) = sys.argv[1:14]
cfg = {
    "session_file": session_file,
    "cwd": cwd,
    "host_pid": host_pid,
    "end_epoch": int(end_epoch),
    "stale": int(stale),
    "provider": provider,
    "model": model,
    "revive_msg": revive_msg,
    "keep_msg": keep_msg,
    "confirm": confirm,
    "kill_host": kill_host,
    "probe": probe,
    "probe_url": probe_url,
    "started_at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
    # 运行统计（run 循环更新）
    "rounds": 0,
    "fail_streak": 0,
    "last_event": "刚启动",
}
sid = session_file.rsplit("/", 1)[-1].replace(".jsonl", "")
import os
os.makedirs(os.path.expanduser("~/.pi/agent/pacer"), exist_ok=True)
with open(os.path.expanduser(f"~/.pi/agent/pacer/{sid}.json"), "w") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=1)
PYEOF

	# 后台启动配速员本体（脱离进程组，避免被父 shell 回收）
	python3 - "$sid" "$session_file" "$SELF" <<'PYEOF'
import subprocess, sys, os
sid, session_file, self = sys.argv[1:4]
fh = open(os.path.expanduser(f"~/.pi/agent/pacer/{sid}.outer.log"), "a")
p = subprocess.Popen(
    ["bash", self, "--run", session_file],
    stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    start_new_session=True,
)
print(p.pid)
PYEOF
	# 上面的 python 打印的是 run 循环进程 pid，由 --run 自己写 pid 文件

	echo "✅ 配速员已起跑: $sid"
	[ -n "${host_pid}" ] && echo "   宿主 TUI: PID ${host_pid}（停滞时将终止它避免双写）" \
		|| echo "   宿主 TUI: 未探测到（按「已终止」场景处理）"
	echo "   领跑至: $(date -r "$end_epoch" '+%F %H:%M')"
	echo "   看板:   pi-pacer.sh list"
}

# ---------- 子命令: run（常驻循环，由 start 派生） ----------

cmd_run() {
	local session_file="$1"
	local sid cfg
	sid=$(sid_of "$session_file")

	# 读配置
	eval "$(python3 - "$session_file" <<'PYEOF'
import json, sys, os, shlex
sid = sys.argv[1].rsplit("/", 1)[-1].replace(".jsonl", "")
cfg = json.load(open(os.path.expanduser(f"~/.pi/agent/pacer/{sid}.json")))
keys = ["session_file","cwd","host_pid","end_epoch","stale","provider","model",
        "revive_msg","keep_msg","confirm","kill_host","probe","probe_url",
        "rounds","fail_streak"]
for k in keys:
    v = cfg.get(k, "")
    print(f"{k}={shlex.quote(str(v))}")
PYEOF
)"

	local LOG CONT_LOG PIDFILE
	LOG=$(log_file "$session_file")
	CONT_LOG=$(cont_file "$session_file")
	PIDFILE=$(pid_file "$session_file")

	local STALE_SEC=$stale
	local INTERVAL=60
	local RESUME_TIMEOUT=7200
	local ROUND=$rounds
	local FAIL_STREAK=$fail_streak
	local LAST_NOTIFY=0
	local NEXT_WAIT=$STALE_SEC
	local BACKOFF_BASE=300 BACKOFF_MAX=1800 BACKOFF_AFTER=3 NOTIFY_AFTER=3 NOTIFY_EVERY=1800

	log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

	# 统计写回（rounds / fail_streak / last_event）
	save_stats() {
		python3 - "$session_file" "$ROUND" "$FAIL_STREAK" "$1" <<'PYEOF'
import json, sys, os
sid = sys.argv[1].rsplit("/", 1)[-1].replace(".jsonl", "")
p = os.path.expanduser(f"~/.pi/agent/pacer/{sid}.json")
cfg = json.load(open(p))
cfg["rounds"], cfg["fail_streak"], cfg["last_event"] = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
json.dump(cfg, open(p, "w"), ensure_ascii=False, indent=1)
PYEOF
	}

	probe_provider() {
		[ "$probe" = "yes" ] || return 0
		local code
		code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$probe_url" 2>/dev/null)
		if [ "$code" = "000" ] || [ -z "$code" ]; then
			return 1
		fi
		log "provider 探活可达 (HTTP $code)"
		return 0
	}

	notify_failure() {
		local title="pi-pacer 配速告警（$sid）"
		local body="续命连续失败 ${FAIL_STREAK} 轮，已进入退避等待。详见 $LOG"
		osascript -e "display notification \"$body\" with title \"$title\" sound name \"Basso\"" >/dev/null 2>&1
		log "📢 已发送系统通知（连续失败 ${FAIL_STREAK} 轮）"
	}

	register_failure() {
		FAIL_STREAK=$((FAIL_STREAK + 1))
		local now
		now=$(date +%s)
		if [ "$FAIL_STREAK" -ge "$NOTIFY_AFTER" ]; then
			if [ $((now - LAST_NOTIFY)) -ge "$NOTIFY_EVERY" ]; then
				notify_failure
				LAST_NOTIFY=$now
			fi
		fi
		if [ "$FAIL_STREAK" -lt "$BACKOFF_AFTER" ]; then
			NEXT_WAIT=$BACKOFF_BASE
		else
			# bash 3.2 兼容的 2^n（位运算）
			local p=$((FAIL_STREAK - BACKOFF_AFTER))
			local w=$((BACKOFF_BASE * (1 << p)))
			[ "$w" -gt "$BACKOFF_MAX" ] && w=$BACKOFF_MAX
			NEXT_WAIT=$w
		fi
		log "连续失败 ${FAIL_STREAK} 轮，下一轮出手间隔退避至 $((NEXT_WAIT / 60))min"
		save_stats "连续失败 ${FAIL_STREAK} 轮"
	}

	register_success() {
		if [ "$FAIL_STREAK" -gt 0 ]; then
			log "✅ 恢复成功，失败计数清零（此前连续失败 ${FAIL_STREAK} 轮）"
		fi
		FAIL_STREAK=0
		NEXT_WAIT=$BACKOFF_BASE
		save_stats "恢复成功"
	}

	last_state() {
		python3 - "$session_file" <<'PYEOF'
import json, sys, os
path = sys.argv[1]
size = os.path.getsize(path)
with open(path, "rb") as f:
    f.seek(max(0, size - 65536))
    data = f.read()
for l in reversed([x for x in data.split(b"\n") if x.strip()]):
    try:
        d = json.loads(l)
    except Exception:
        continue
    if d.get("type") == "message":
        msg = d["message"]; role = msg.get("role", ""); content = msg.get("content", [])
        if role == "assistant":
            has_tool = any(c.get("type") == "toolCall" for c in content if isinstance(c, dict))
            print("running" if has_tool else "waiting")
        elif role in ("user", "toolResult"):
            print("running")
        else:
            print("unknown")
        break
else:
    print("unknown")
PYEOF
	}

	timeout_cmd() {
		local secs="$1"; shift
		perl -e "alarm $secs; exec @ARGV" -- "$@"
	}

	send_message() {
		local msg="$1"
		log ">>> 发送消息: ${msg:0:80}"
		cd "$cwd" || return 1
		timeout_cmd "$RESUME_TIMEOUT" \
			pi --session "$session_file" \
			--provider "$provider" --model "$model" \
			-p "$msg" >> "$CONT_LOG" 2>&1
		local rc=$?
		log "<<< agent 回复完成 (exit=$rc)"
		tail -c 300 "$CONT_LOG" | tr -d '\000' >> "$LOG"
		echo "" >> "$LOG"
		return $rc
	}

	act_or_skip() {
		local msg="$1"
		if ! probe_provider; then
			log "⚠ provider 探活不通（网络故障），跳过本轮出手"
			register_failure
			return 1
		fi
		if send_message "$msg"; then
			register_success
			return 0
		else
			register_failure
			return 1
		fi
	}

	echo $$ > "$PIDFILE"
	log "===== 配速员起跑 (PID $$) ====="
	log "会话: $sid"
	log "项目: $cwd  模型: $provider/$model  宿主: ${host_pid:-无}"
	log "停滞阈值=${STALE_SEC}s 截止=$(date -r "$end_epoch" '+%F %T' 2>/dev/null) 杀宿主=$kill_host 探活=$probe"

	while true; do
		now=$(date +%s)
		if [ "$now" -ge "$end_epoch" ]; then
			log "到达领跑截止时间，配速员完赛收工"
			save_stats "值班结束"
			rm -f "$PIDFILE"
			exit 0
		fi

		if [ ! -f "$session_file" ]; then
			log "警告: 会话文件不存在，继续等待"
			sleep "$INTERVAL"
			continue
		fi

		mtime=$(stat -f %m "$session_file")
		age=$((now - mtime))

		# 正常运行：只记心跳
		if [ "$age" -lt "$STALE_SEC" ]; then
			if [ $((now % 300)) -lt "$INTERVAL" ]; then
				log "运行中 (age=${age}s state=$(last_state))"
			fi
			sleep "$INTERVAL"
			continue
		fi

		# 停滞 ≥ 阈值
		state=$(last_state)
		host_alive=no
		if [ -n "$host_pid" ] && kill -0 "$host_pid" 2>/dev/null; then
			host_alive=yes
		fi
		log "⚠ 会话停滞 ${age}s (state=$state 宿主${host_pid:-?}存活=$host_alive)"

		if [ "$host_alive" = "yes" ] && [ "$kill_host" = "yes" ]; then
			# 场景①：异常停止 —— 宿主 TUI 还开着但执行已停
			log "异常停止：终止宿主 $host_pid 后发送维持消息"
			kill "$host_pid" 2>/dev/null
			for i in 1 2 3 4 5; do
				kill -0 "$host_pid" 2>/dev/null || break
				sleep 2
			done
			kill -9 "$host_pid" 2>/dev/null
			sleep 2
			act_or_skip "$keep_msg"
			ROUND=$((ROUND + 1))
			save_stats "异常停止干预一轮"
		else
			# 场景②：已终止 —— 无宿主进程接管
			if [ "$ROUND" -eq 0 ]; then
				log "已终止：RPC 恢复（compact → 复活消息 → 等回复 → 确认）"
				if [ -f "$REVIVE_MJS" ]; then
					if probe_provider; then
						PROJECT_DIR="$cwd" TIMEOUT_SEC="$RESUME_TIMEOUT" \
						PI_PROVIDER="$provider" PI_MODEL="$model" \
						REVIVE_MSG="$revive_msg" CONFIRM_MSG="确认执行。按你的计划推进，完成当前单元后继续自主选择下一个优化点迭代，无需等待人工确认。" \
							node "$REVIVE_MJS" "$session_file" $([ "$confirm" = "yes" ] || echo --no-confirm) >> "$CONT_LOG" 2>&1
						rc=$?
						log "<<< RPC 恢复流程结束 (exit=$rc)"
						if [ "$rc" -eq 0 ]; then
							register_success
						else
							register_failure
						fi
					else
						log "⚠ provider 探活不通（网络故障），跳过本轮 RPC 恢复"
						register_failure
					fi
				else
					log "⚠ 恢复脚本不存在: $REVIVE_MJS，回退 send_message"
					act_or_skip "$revive_msg"
				fi
			else
				log "已终止（第 $ROUND 轮后）：发送维持消息"
				act_or_skip "$keep_msg"
			fi
			ROUND=$((ROUND + 1))
			save_stats "已终止续命一轮"
		fi

		sleep "$NEXT_WAIT"
	done
}

# ---------- 子命令: stop ----------

cmd_stop() {
	local session_file="$1"
	local pidfile pid
	pidfile=$(pid_file "$session_file")
	[ -f "$pidfile" ] || die "该会话没有领跑中的配速员"
	pid=$(cat "$pidfile")
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" && echo "✅ 已停止配速员 (PID $pid)。正在执行的 agent 当前轮会继续跑完。"
	else
		echo "配速员进程已不在，清理 pid 文件"
	fi
	rm -f "$pidfile"
}

# ---------- 子命令: list（看板） ----------

cmd_list() {
	python3 - "$PACER_HOME" <<'PYEOF'
import glob, json, os, subprocess, sys, time

home = sys.argv[1]
now = time.time()

def C(code, s): return f"\033[{code}m{s}\033[0m"
def dim(s): return C("2", s)
def ok(s): return C("32", s)
def warn(s): return C("33", s)
def bad(s): return C("31", s)
def info(s): return C("36", s)

def last_state(path):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - 65536))
            data = f.read()
        for l in reversed([x for x in data.split(b"\n") if x.strip()]):
            try:
                d = json.loads(l)
            except Exception:
                continue
            if d.get("type") == "message":
                m = d["message"]; role = m.get("role", "")
                if role == "assistant":
                    has_tool = any(c.get("type") == "toolCall" for c in m.get("content", []) if isinstance(c, dict))
                    return "running" if has_tool else "waiting"
                if role in ("user", "toolResult"):
                    return "running"
                return "unknown"
    except Exception:
        pass
    return "unknown"

cfgs = sorted(glob.glob(os.path.join(home, "*.json")))
if not cfgs:
    print(dim("（无任何领跑记录——用 pi-pacer.sh start <session-file> 起跑一个）"))
    sys.exit(0)

W = 78
print("═" * W)
print(f" pi 配速员看板   {dim(time.strftime('%H:%M:%S'))}")
print("═" * W)

for cp in cfgs:
    sid = os.path.basename(cp).replace(".json", "")
    try:
        cfg = json.load(open(cp))
    except Exception:
        continue
    short = sid[:28] + ("…" if len(sid) > 28 else "")
    print()
    print(f" ◆ {info(short)}")

    # 配速员进程
    pidfile = cp.replace(".json", ".pid")
    on_duty = False
    if os.path.exists(pidfile):
        pid = open(pidfile).read().strip()
        r = subprocess.run(["ps", "-p", pid, "-o", "etime="], capture_output=True, text=True)
        if r.stdout.strip():
            on_duty = True
            print(f"   配速: {ok('● 领跑中')} PID {pid}  已领跑 {r.stdout.strip()}")
        else:
            print(f"   配速: {dim('○ 已完赛')}（pid 文件残留，可忽略或 rm）")
    else:
        print(f"   配速: {dim('○ 已完赛')}")

    # 领跑窗口
    end = cfg.get("end_epoch", 0)
    remain = end - now
    if on_duty:
        if remain > 0:
            h, m2 = int(remain // 3600), int(remain % 3600 // 60)
            print(f"   领跑至: {time.strftime('%F %H:%M', time.localtime(end))}  {dim(f'(还剩 {h}h{m2:02d}m)')}")
        else:
            print(f"   领跑至: {time.strftime('%F %H:%M', time.localtime(end))}  {warn('已到点')}")
    print(f"   模型: {cfg.get('provider')}/{cfg.get('model')}  项目: {cfg.get('cwd','?')}")

    # 会话状态
    sf = cfg.get("session_file", "")
    if sf and os.path.exists(sf):
        age = now - os.path.getmtime(sf)
        st = last_state(sf)
        st_cn = {"running": "干活中", "waiting": "等待输入", "unknown": "未知"}.get(st, st)
        size_kb = os.path.getsize(sf) // 1024
        mark = ok("●") if age < 300 and st == "running" else (warn("◐") if age < 300 else bad("○"))
        print(f"   会话: {mark} {int(age)}s前更新 · {size_kb}KB · {st_cn}")
    else:
        print(f"   会话: {bad('文件不存在')}")

    # 统计
    print(f"   统计: 续命轮次 {cfg.get('rounds', 0)} · 连续失败 {cfg.get('fail_streak', 0)} · {dim(str(cfg.get('last_event','')))}")

    # 日志尾部关键事件
    logp = cp.replace(".json", ".log")
    if os.path.exists(logp):
        evs = []
        for ln in open(logp, encoding="utf-8", errors="replace"):
            if ln.startswith("[") and any(k in ln for k in ("⚠", "已终止", "异常停止", "发送消息", "恢复", "失败", "上岗", "收工")):
                evs.append(ln.rstrip())
        if evs:
            print(dim("   最近事件:"))
            for e in evs[-3:]:
                color = warn if "⚠" in e else (info if any(k in e for k in ("恢复", "发送")) else dim)
                print(color(f"   │ {e[:70]}"))

print()
print(dim("─" * W))
print(dim("  上岗: pi-pacer.sh start <session-file> [--hours N]"))
print(dim("  收工: pi-pacer.sh stop <session-file>   尾随日志: pi-pacer.sh log <session-file>"))
PYEOF
}

# ---------- 子命令: log ----------

cmd_log() {
	local session_file="$1"
	local logp
	logp=$(log_file "$session_file")
	[ -f "$logp" ] || die "无值班日志: $logp"
	tail -f "$logp"
}

# ---------- 入口 ----------

case "${1:-}" in
	start) shift; cmd_start "$@" ;;
	--run) shift; cmd_run "$@" ;;
	stop)  shift; cmd_stop "$@" ;;
	list)  shift; cmd_list "$@" ;;
	log)   shift; cmd_log "$@" ;;
	-h|--help|*)
		sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
		;;
esac
