package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHost    = "127.0.0.1"
	defaultPort    = 8000
	defaultModel   = "deepseek-chat"
	defaultBaseURL = "https://api.deepseek.com"
)

var jsonObjectPattern = regexp.MustCompile(`(?s)\{.*\}`)

type app struct {
	root    string
	model   string
	baseURL string
	client  *http.Client
}

type scoreSessionRequest struct {
	SessionID    string          `json:"session_id"`
	SessionMeta  json.RawMessage `json:"session_meta"`
	AnsweredList []answeredScene `json:"answered_scenes"`
}

type answeredScene struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Category     string `json:"category"`
	Difficulty   string `json:"difficulty"`
	Context      string `json:"context"`
	Goal         string `json:"goal"`
	LatestAnswer string `json:"latest_answer"`
	AttemptCount int    `json:"attempt_count"`
}

type upstreamRequest struct {
	Model          string            `json:"model"`
	Temperature    float64           `json:"temperature"`
	MaxTokens      int               `json:"max_tokens"`
	ResponseFormat map[string]string `json:"response_format"`
	Messages       []upstreamMessage `json:"messages"`
}

type upstreamMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type upstreamResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage map[string]any `json:"usage"`
}

type scoreSessionResponse struct {
	Feedback map[string]any `json:"feedback"`
	Usage    map[string]any `json:"usage"`
}

func main() {
	host := flag.String("host", defaultHost, "监听地址，默认 127.0.0.1")
	port := flag.Int("port", defaultPort, "监听端口，默认 8000")
	flag.Parse()

	portFlagSet := false
	flag.CommandLine.Visit(func(flagItem *flag.Flag) {
		if flagItem.Name == "port" {
			portFlagSet = true
		}
	})

	root, err := os.Getwd()
	if err != nil {
		log.Fatalf("无法获取当前目录: %v", err)
	}

	if err := loadDotEnv(filepath.Join(root, ".env")); err != nil {
		log.Fatalf("读取 .env 失败: %v", err)
	}

	if !portFlagSet {
		portValue := strings.TrimSpace(os.Getenv("PORT"))
		if portValue != "" {
			parsedPort, err := strconv.Atoi(portValue)
			if err != nil || parsedPort <= 0 || parsedPort > 65535 {
				log.Fatalf("无效 PORT: %q", portValue)
			}
			*port = parsedPort
		}
	}

	serverApp := &app{
		root:    root,
		model:   getenv("DEEPSEEK_MODEL", defaultModel),
		baseURL: strings.TrimRight(getenv("DEEPSEEK_BASE_URL", defaultBaseURL), "/"),
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("Serving on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, newMux(serverApp)))
}

func (a *app) handleConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": os.Getenv("DEEPSEEK_API_KEY") != "",
	})
}

func (a *app) handleScoreSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"error": "Method not allowed",
		})
		return
	}

	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	if apiKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "评分服务未配置 API Key，暂时无法使用 AI 评分。",
		})
		return
	}

	var payload scoreSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("无效 JSON：%v", err),
		})
		return
	}

	if len(payload.AnsweredList) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "answered_scenes 不能为空。",
		})
		return
	}

	result, err := a.requestDeepSeekScore(r.Context(), payload, apiKey)
	if err != nil {
		status := http.StatusInternalServerError
		var upstreamErr *upstreamHTTPError
		clientMessage := "评分服务暂时不可用，请稍后重试。"
		switch {
		case errors.As(err, &upstreamErr):
			status = http.StatusBadGateway
			clientMessage = "评分服务暂时不可用（上游错误），请稍后重试。"
		case errors.Is(err, context.DeadlineExceeded):
			status = http.StatusGatewayTimeout
			clientMessage = "评分服务响应超时，请稍后重试。"
		}

		log.Printf("score-session failed: %v", err)
		writeJSON(w, status, map[string]any{
			"error": clientMessage,
		})
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (a *app) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"error": "Method not allowed",
		})
		return
	}

	relativePath := "index.html"
	if cleaned := path.Clean("/" + r.URL.Path); cleaned != "/" {
		relativePath = strings.TrimPrefix(cleaned, "/")
	}

	if strings.HasPrefix(relativePath, ".") || strings.Contains(relativePath, "/.") {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}

	switch strings.ToLower(filepath.Ext(relativePath)) {
	case ".html", ".css", ".js":
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}

	targetPath := filepath.Join(a.root, filepath.FromSlash(relativePath))
	rootAbs, err := filepath.Abs(a.root)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	targetAbs, err := filepath.Abs(targetPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	if !strings.HasPrefix(targetAbs, rootAbs+string(os.PathSeparator)) && targetAbs != rootAbs {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Forbidden"})
		return
	}

	info, err := os.Stat(targetAbs)
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}

	body, err := os.ReadFile(targetAbs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	contentType := mime.TypeByExtension(filepath.Ext(targetAbs))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if strings.HasSuffix(targetAbs, ".js") {
		contentType = "application/javascript; charset=utf-8"
	}
	if strings.HasSuffix(targetAbs, ".css") {
		contentType = "text/css; charset=utf-8"
	}
	if strings.HasSuffix(targetAbs, ".html") {
		contentType = "text/html; charset=utf-8"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func newMux(a *app) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/config", a.handleConfig)
	mux.HandleFunc("/api/score-session", a.handleScoreSession)
	mux.HandleFunc("/", a.handleStatic)
	return mux
}

func (a *app) requestDeepSeekScore(
	ctx context.Context,
	payload scoreSessionRequest,
	apiKey string,
) (scoreSessionResponse, error) {
	detailLimit := len(payload.AnsweredList)
	if detailLimit > 8 {
		detailLimit = 8
	}

	userPayload, err := json.Marshal(payload)
	if err != nil {
		return scoreSessionResponse{}, err
	}

	upstreamPayload := upstreamRequest{
		Model:       a.model,
		Temperature: 0.3,
		MaxTokens:   2600,
		ResponseFormat: map[string]string{
			"type": "json_object",
		},
		Messages: []upstreamMessage{
			{
				Role:    "system",
				Content: buildSystemPrompt(detailLimit),
			},
			{
				Role:    "user",
				Content: string(userPayload),
			},
		},
	}

	requestBody, err := json.Marshal(upstreamPayload)
	if err != nil {
		return scoreSessionResponse{}, err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		a.baseURL+"/chat/completions",
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return scoreSessionResponse{}, err
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return scoreSessionResponse{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return scoreSessionResponse{}, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := extractRemoteError(body)
		if message == "" {
			message = fmt.Sprintf("DeepSeek 返回 %d", resp.StatusCode)
		}
		return scoreSessionResponse{}, &upstreamHTTPError{message: message}
	}

	var upstream upstreamResponse
	if err := json.Unmarshal(body, &upstream); err != nil {
		return scoreSessionResponse{}, err
	}

	if len(upstream.Choices) == 0 {
		return scoreSessionResponse{}, errors.New("DeepSeek 没有返回可用评分结果")
	}

	content := upstream.Choices[0].Message.Content
	jsonText, err := extractJSONObject(content)
	if err != nil {
		return scoreSessionResponse{}, err
	}

	var feedback map[string]any
	if err := json.Unmarshal([]byte(jsonText), &feedback); err != nil {
		return scoreSessionResponse{}, err
	}

	return scoreSessionResponse{
		Feedback: feedback,
		Usage:    upstream.Usage,
	}, nil
}

func buildSystemPrompt(detailLimit int) string {
	return fmt.Sprintf(`你是一个中文口语表达训练教练。你要对用户一整轮“沟通场景作答”做评分。

评分目标不是文学性，而是现实沟通效果。重点判断：
1. 清晰度（0-100）：第一句话能不能让对方迅速知道你要解决什么。
2. 抓重点（0-100）：是否避免绕、是否铺垫过长、是否聚焦关键事实。
3. 分寸感（0-100）：是否体面、留余地、不失边界。
4. 说服力（0-100）：是否能推动对话继续，而不只是表达情绪。
5. 层次感（0-100）：是否有“目标 -> 事实 -> 边界/台阶”的顺序。

总分 overall_score 为 0-100 的整数。总分不能机械取平均，要综合用户本轮整体稳定性来判断。

请严格返回 JSON 对象，不要输出 JSON 之外的任何解释。JSON 结构必须包含：
{
  "overall_score": 0,
  "level": "",
  "encouragement": "",
  "summary": "",
  "dimension_scores": {
    "clarity": 0,
    "focus": 0,
    "tact": 0,
    "persuasion": 0,
    "structure": 0
  },
  "strengths": ["", "", ""],
  "improvement_points": ["", "", ""],
  "next_actions": ["", "", ""],
  "badges": ["", "", ""],
  "scene_feedback": [
    {
      "title": "",
      "score": 0,
      "verdict": "",
      "what_worked": "",
      "what_to_improve": "",
      "better_opening": ""
    }
  ]
}

要求：
- encouragement 必须是鼓励性表达，但不能空泛鸡汤，要和用户本轮表现相关。
- strengths / improvement_points / next_actions 各给 3 条，必须简短、具体、可执行。
- badges 给 2-4 条，像“开始抓重点了”“会给对方留台阶了”这种短标签。
- scene_feedback 只返回最有代表性的 %d 题，优先覆盖最弱点和最值得保留的亮点。
- better_opening 必须是更稳、更像真实沟通的改写，不要写成口号。
- 如果用户某题明显偏离目标，要直接指出，但语气要建设性。`, detailLimit)
}

func extractJSONObject(text string) (string, error) {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		return trimmed, nil
	}

	match := jsonObjectPattern.FindString(trimmed)
	if match == "" {
		return "", errors.New("模型没有返回有效 JSON")
	}

	return match, nil
}

func extractRemoteError(body []byte) string {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return strings.TrimSpace(string(body))
	}

	rawError, ok := payload["error"]
	if !ok {
		return ""
	}

	switch errValue := rawError.(type) {
	case string:
		return errValue
	case map[string]any:
		if message, ok := errValue["message"].(string); ok {
			return message
		}
		if typ, ok := errValue["type"].(string); ok {
			return typ
		}
	}

	return ""
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func loadDotEnv(filePath string) error {
	file, err := os.Open(filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	lineNumber := 0

	for scanner.Scan() {
		lineNumber++
		line := strings.TrimPrefix(scanner.Text(), "\ufeff")
		line = strings.TrimSpace(line)

		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf(".env 第 %d 行缺少 '='", lineNumber)
		}

		key = strings.TrimSpace(key)
		if key == "" {
			return fmt.Errorf(".env 第 %d 行变量名为空", lineNumber)
		}

		if os.Getenv(key) != "" {
			continue
		}

		parsedValue, err := parseDotEnvValue(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf(".env 第 %d 行解析失败: %w", lineNumber, err)
		}

		if err := os.Setenv(key, parsedValue); err != nil {
			return err
		}
	}

	return scanner.Err()
}

func parseDotEnvValue(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}

	if raw[0] == '"' || raw[0] == '\'' {
		quote := raw[0]
		end := findClosingQuote(raw, quote)
		if end < 0 {
			return "", errors.New("引号没有正确闭合")
		}

		trailer := strings.TrimSpace(raw[end+1:])
		if trailer != "" && !strings.HasPrefix(trailer, "#") {
			return "", errors.New("引号后的内容不合法")
		}

		unquoted := raw[1:end]
		if quote == '"' {
			return strings.NewReplacer(
				`\\`, `\`,
				`\n`, "\n",
				`\r`, "\r",
				`\t`, "\t",
				`\"`, `"`,
			).Replace(unquoted), nil
		}

		return unquoted, nil
	}

	if idx := strings.Index(raw, " #"); idx >= 0 {
		raw = raw[:idx]
	}

	return strings.TrimSpace(raw), nil
}

func findClosingQuote(raw string, quote byte) int {
	escaped := false

	for i := 1; i < len(raw); i++ {
		if quote == '"' && raw[i] == '\\' && !escaped {
			escaped = true
			continue
		}

		if raw[i] == quote && !escaped {
			return i
		}

		escaped = false
	}

	return -1
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

type upstreamHTTPError struct {
	message string
}

func (e *upstreamHTTPError) Error() string {
	return e.message
}
