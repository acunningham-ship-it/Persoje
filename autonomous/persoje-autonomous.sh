#!/usr/bin/env bash
# =============================================================================
# Persoje Autonomous Runner
# 
# Survives SSH disconnects, terminal closes, and system restarts.
# Uses tmux for session persistence + systemd watchdog for auto-restart.
#
# Usage:
#   persoje-autonomous start [prompt]  - Start/resume autonomous session
#   persoje-autonomous attach          - Attach to the running session
#   persoje-autonomous status          - Check if running
#   persoje-autonomous stop            - Stop the session
#   persoje-autonomous logs            - Tail the log file
#   persoje-autonomous watchdog install - Install systemd watchdog
#   persoje-autonomous watchdog remove  - Remove systemd watchdog
# =============================================================================

set -euo pipefail

SESSION_NAME="persoje-auto"
LOG_DIR="$HOME/.local/share/persoje-autonomous"
LOG_FILE="$LOG_DIR/session.log"
PID_FILE="$LOG_DIR/pid"
TASK_FILE="$LOG_DIR/current-task"
STATE_DIR="$LOG_DIR/state"

# Ensure dirs exist
mkdir -p "$LOG_DIR" "$STATE_DIR"

_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
_green() { printf '\033[32m%s\033[0m\n' "$*"; }
_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

is_running() {
    tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

get_pid() {
    if [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    fi
}

# =============================================================================
# START - Launch persoje in a persistent tmux session
# =============================================================================
do_start() {
    local prompt="${1:-}"
    
    if is_running; then
        _yellow "Session '$SESSION_NAME' is already running."
        _blue "Use 'persoje-autonomous attach' to connect to it."
        return 0
    fi

    _green "Starting Persoje autonomous session..."

    # Save the task for persistence/resume
    if [ -n "$prompt" ]; then
        echo "$prompt" > "$TASK_FILE"
    fi

    # Create tmux session - persoje runs directly, output logged
    tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 \
        "persoje 2>&1 | tee -a '$LOG_FILE'"

    # Save PID
    tmux list-panes -t "$SESSION_NAME" -F "#{pane_pid}" > "$PID_FILE"

    _green "✓ Session started in tmux: $SESSION_NAME"
    _green "✓ Logging to: $LOG_FILE"
    echo ""
    _blue "This session will survive:"
    _blue "  • SSH disconnects"
    _blue "  • Terminal closes"  
    _blue "  • Network drops"
    echo ""
    _blue "Commands:"
    _blue "  persoje-autonomous attach  - Reconnect to the session"
    _blue "  persoje-autonomous logs    - Watch the output"
    _blue "  persoje-autonomous stop    - End the session"
}

# =============================================================================
# ATTACH - Reconnect to the running session
# =============================================================================
do_attach() {
    if ! is_running; then
        _red "No running session found."
        _yellow "Use 'persoje-autonomous start' to create one."
        return 1
    fi

    _green "Attaching to session '$SESSION_NAME'..."
    _blue "(Press Ctrl+b then d to detach without stopping)"
    tmux attach-session -t "$SESSION_NAME"
}

# =============================================================================
# STATUS - Show current state
# =============================================================================
do_status() {
    echo "━━━ Persoje Autonomous Status ━━━"
    echo ""
    
    if is_running; then
        _green "● RUNNING"
        echo "  Session: $SESSION_NAME"
        echo "  PID: $(cat "$PID_FILE" 2>/dev/null || echo 'unknown')"
        echo "  Uptime: $(tmux show-option -t "$SESSION_NAME" -v remain-on-exit 2>/dev/null || echo 'active')"
        
        # Show last few lines of log
        if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
            echo ""
            echo "  Last output:"
            tail -5 "$LOG_FILE" | sed 's/^/    /'
        fi
    else
        _red "○ STOPPED"
    fi

    echo ""
    if [ -f "$TASK_FILE" ]; then
        echo "  Current task: $(cat "$TASK_FILE")"
    fi
    echo "  Log file: $LOG_FILE"
    
    # Check systemd watchdog
    if systemctl --user is-active persoje-autonomous.service &>/dev/null; then
        _green "  Watchdog: ACTIVE (systemd)"
    else
        _yellow "  Watchdog: NOT INSTALLED"
    fi
}

# =============================================================================
# STOP - Gracefully stop the session
# =============================================================================
do_stop() {
    if ! is_running; then
        _yellow "No running session to stop."
        return 0
    fi

    _yellow "Stopping session '$SESSION_NAME'..."
    tmux kill-session -t "$SESSION_NAME"
    rm -f "$PID_FILE"
    _green "✓ Session stopped."
}

# =============================================================================
# LOGS - Tail the log file
# =============================================================================
do_logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        _yellow "No log file yet. Start a session first."
    fi
}

# =============================================================================
# WATCHDOG - Install/remove systemd user service for auto-restart
# =============================================================================
do_watchdog_install() {
    local service_dir="$HOME/.config/systemd/user"
    mkdir -p "$service_dir"

    cat > "$service_dir/persoje-autonomous.service" << 'EOF'
[Unit]
Description=Persoje Autonomous Session Watchdog
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/bin/tmux new-session -d -s persoje-auto -x 200 -y 50 "/usr/bin/script -q -c 'persoje' '%h/.local/share/persoje-autonomous/session.log'"
ExecStop=/usr/bin/tmux kill-session -t persoje-auto
ExecReload=/usr/bin/tmux kill-session -t persoje-auto; /usr/bin/tmux new-session -d -s persoje-auto -x 200 -y 50 "/usr/bin/script -q -c 'persoje' '%h/.local/share/persoje-autonomous/session.log'"
Restart=on-failure
RestartSec=10

# If persoje crashes, restart it
OnFailure=persoje-autonomous-restart.service

[Install]
WantedBy=default.target
EOF

    # Also create a restart-on-failure helper
    cat > "$service_dir/persoje-autonomous-restart.service" << 'EOF'
[Unit]
Description=Restart Persoje After Failure

[Service]
Type=oneshot
ExecStart=/usr/bin/tmux new-session -d -s persoje-auto -x 200 -y 50 "/usr/bin/script -q -c 'persoje' '%h/.local/share/persoje-autonomous/session.log'"
EOF

    # Create a timer for periodic health checks
    cat > "$service_dir/persoje-autonomous-health.service" << 'EOF'
[Unit]
Description=Persoje Health Check

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'tmux has-session -t persoje-auto 2>/dev/null || tmux new-session -d -s persoje-auto -x 200 -y 50 "/usr/bin/script -q -c persoje %h/.local/share/persoje-autonomous/session.log"'
EOF

    cat > "$service_dir/persoje-autonomous-health.timer" << 'EOF'
[Unit]
Description=Check Persoje every 60 seconds

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable persoje-autonomous.service
    systemctl --user enable persoje-autonomous-health.timer
    systemctl --user start persoje-autonomous-health.timer

    _green "✓ Watchdog installed!"
    _green "  - systemd service: persoje-autonomous.service"
    _green "  - Health check timer: every 60 seconds"
    _green "  - Auto-restart on crash: enabled"
    echo ""
    _blue "If persoje crashes or the tmux session dies, it will be"
    _blue "automatically restarted within 60 seconds."
}

do_watchdog_remove() {
    systemctl --user stop persoje-autonomous-health.timer 2>/dev/null || true
    systemctl --user disable persoje-autonomous-health.timer 2>/dev/null || true
    systemctl --user stop persoje-autonomous.service 2>/dev/null || true
    systemctl --user disable persoje-autonomous.service 2>/dev/null || true
    systemctl --user daemon-reload

    rm -f "$HOME/.config/systemd/user/persoje-autonomous.service"
    rm -f "$HOME/.config/systemd/user/persoje-autonomous-restart.service"
    rm -f "$HOME/.config/systemd/user/persoje-autonomous-health.service"
    rm -f "$HOME/.config/systemd/user/persoje-autonomous-health.timer"
    systemctl --user daemon-reload

    _green "✓ Watchdog removed."
}

# =============================================================================
# RESUME - If session died but task file exists, restart with the task
# =============================================================================
do_resume() {
    if is_running; then
        _yellow "Session is already running. Attach to it instead."
        return 0
    fi

    if [ -f "$TASK_FILE" ]; then
        local task
        task=$(cat "$TASK_FILE")
        _green "Resuming with saved task: $task"
        do_start "$task"
    else
        _yellow "No saved task found. Starting fresh."
        do_start
    fi
}

# =============================================================================
# Main
# =============================================================================
case "${1:-help}" in
    start)   do_start "${2:-}" ;;
    attach)  do_attach ;;
    status)  do_status ;;
    stop)    do_stop ;;
    logs)    do_logs ;;
    resume)  do_resume ;;
    watchdog)
        case "${2:-}" in
            install) do_watchdog_install ;;
            remove)  do_watchdog_remove ;;
            *)       _red "Usage: persoje-autonomous watchdog [install|remove]" ;;
        esac
        ;;
    help|--help|-h)
        echo "Persoje Autonomous Runner"
        echo ""
        echo "Commands:"
        echo "  start [prompt]         Start autonomous session (survives disconnect)"
        echo "  attach                Reconnect to running session"
        echo "  status                Show session status"
        echo "  stop                  Stop the session"
        echo "  logs                  Tail session output"
        echo "  resume                Restart with last saved task"
        echo "  watchdog install      Install systemd auto-restart watchdog"
        echo "  watchdog remove       Remove the watchdog"
        ;;
    *)
        _red "Unknown command: $1"
        _yellow "Run 'persoje-autonomous help' for usage."
        exit 1
        ;;
esac
