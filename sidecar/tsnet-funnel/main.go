package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type Event struct {
	Event   string `json:"event"`
	URL     string `json:"url,omitempty"`
	Message string `json:"message,omitempty"`
}

func emit(ev Event) {
	b, _ := json.Marshal(ev)
	fmt.Println(string(b))
}

var urlRegex = regexp.MustCompile(`https://login\.tailscale\.com/[^\s"'<>]+`)

func main() {
	hostname := flag.String("hostname", "fmc-hub", "Tailscale Funnel hostname")
	stateDir := flag.String("state-dir", "./tsnet-state", "Directory to persist Tailscale login state")
	target := flag.String("target", "http://127.0.0.1:18787", "Local FMC Control API target URL")
	flag.Parse()

	targetURL, err := url.Parse(*target)
	if err != nil {
		emit(Event{Event: "error", Message: "invalid target URL: " + err.Error()})
		os.Exit(1)
	}

	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		emit(Event{Event: "error", Message: "failed to create state-dir: " + err.Error()})
		os.Exit(1)
	}

	srv := &tsnet.Server{
		Hostname: *hostname,
		Dir:      *stateDir,
		Logf: func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			if m := urlRegex.FindString(line); m != "" {
				if strings.Contains(m, "funnel") {
					emit(Event{Event: "funnel_enable", URL: m, Message: "请在浏览器中一键开启 Tailscale Funnel 权限"})
				} else {
					emit(Event{Event: "auth_url", URL: m, Message: "请在浏览器中登录 Tailscale 账号完成一次绑定"})
				}
			}
		},
	}
	defer srv.Close()

	emit(Event{Event: "starting", Message: "正在初始化内嵌 Tailscale (tsnet) 用户态网络..."})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		cancel()
		_ = srv.Close()
		os.Exit(0)
	}()

	// Wait until Tailscale node is logged in and up
	status, err := srv.Up(ctx)
	if err != nil {
		emit(Event{Event: "error", Message: "Tailscale 启动失败: " + err.Error()})
		os.Exit(1)
	}

	var domain string
	if status != nil && len(status.CertDomains) > 0 {
		domain = status.CertDomains[0]
	}
	if domain == "" && status != nil && status.Self != nil {
		domain = strings.TrimSuffix(status.Self.DNSName, ".")
	}

	// Retry ListenFunnel briefly in case user just clicked "Enable Funnel" in browser
	var lnErr error
	for attempt := 0; attempt < 30; attempt++ {
		ln, err := srv.ListenFunnel("tcp", ":443")
		if err == nil {
			if domain == "" {
				if st2, e2 := srv.Up(ctx); e2 == nil && st2 != nil && len(st2.CertDomains) > 0 {
					domain = st2.CertDomains[0]
				}
			}
			publicURL := "https://" + domain
			emit(Event{Event: "ready", URL: publicURL, Message: "Tailscale 永久 443 HTTPS 域名已在线！"})

			proxy := httputil.NewSingleHostReverseProxy(targetURL)
			httpSrv := &http.Server{Handler: proxy}
			if serveErr := httpSrv.Serve(ln); serveErr != nil && ctx.Err() == nil {
				emit(Event{Event: "error", Message: "HTTP 转发服务退出: " + serveErr.Error()})
			}
			return
		}
		lnErr = err
		errText := err.Error()
		if m := urlRegex.FindString(errText); m != "" {
			emit(Event{Event: "funnel_enable", URL: m, Message: "请点击链接启用 Tailscale Funnel，启用后会自动重连"})
		} else if strings.Contains(errText, "HTTPS must be enabled") {
			emit(Event{Event: "funnel_enable", URL: "https://login.tailscale.com/admin/dns", Message: "请点击链接在 Tailscale 后台开启 HTTPS Certificates（开启后自动重连）"})
		} else if strings.Contains(errText, "no-funnel") || strings.Contains(errText, "node attribute not set") {
			emit(Event{Event: "funnel_enable", URL: "https://login.tailscale.com/f/funnel", Message: "HTTPS 已就绪，请点击链接一键开启 Funnel 公网权限（开启后自动重连）"})
		} else if attempt == 0 {
			emit(Event{Event: "waiting_funnel", Message: "等待启用 Tailscale Funnel... " + errText})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}

	emit(Event{Event: "error", Message: "ListenFunnel 失败: " + lnErr.Error()})
	os.Exit(1)
}
